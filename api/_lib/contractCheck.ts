// Chequeo de contrato contra la API de CourtTrack (privada y sin documentar: cambia sin aviso). Solo lee CourtTrack,
// no toca Supabase. Lo usan la CLI (scripts/check-courtrack.ts) y el cron semanal (api/cron/contract-check.ts).
// Invariantes:
//   1. getLigas, findPartidos y getDetallePartido pasan los esquemas de api/_lib/courtrack.ts
//   2. no aparecen claves ni tipos de evento nuevos (avisa: puede haber datos que aprovechar o renombres)
//   3. cada acción de la progresión tiene jugador con dorsal (el parser de descripciones entiende el formato)
//   4. las acciones por jugador sacadas de la progresión = los totales oficiales de estadisticasJugador
//   5. los puntos de la progresión de cada set = su marcador final
//   6. todo jugador con acciones en un set está en el plantel de ese set (roster: formación + cambios)
//   7. el rival de un error forzado es un jugador del otro equipo
import { env } from './env.js'
import { HttpError } from './http.js'
import { findPartidos, getDetallePartido, getLiga } from './courtrack.js'
import type { CourtrackPartido } from './types.js'

/** Lo que conocemos de getDetallePartido: una clave fuera de esta lista es un cambio de CourtTrack a revisar. */
const KNOWN_DETALLE_KEYS = new Set(
  'id,id_cliente,numero,id_torneo,id_etapa,fecha,horario,id_club,nro_cancha,id_equipo_a,id_equipo_b,id_equipo_trabajo,ronda,sets_a,sets_b,duracion,status,instancia,version_id,etapa,etapa_formatted,id_rama,torneo,imagen_equipo_a,logo_equipo_a,imagen_equipo_b,logo_equipo_b,mvp_nombre,mvp_imagen,mvp_fecha_nacimiento,mvp_equipo,mvp_posicion,id_arbitro1,id_arbitro2,id_linea1,id_linea2,id_linea3,id_linea4,id_planillero,id_capitan_a,id_capitan_b,id_coordinador,mvp_fecha_nacimiento_formatted,fecha_formatted,horario_formatted,hora_inicio_formatted,hora_fin_formatted,arbitro1,arbitro2,linea1,linea2,linea3,linea4,planillero,coordinador,autoridades,fotos_versus,eventos,sets,estadisticas,estadisticasJugador,maximoAnotador,mejorAtacante,mejorSacador,mejorBloqueador,mvp,progresion'.split(','),
)
/** Coincide con EVENT_KINDS de api/_lib/courtrack.ts; las sanciones ("sanction:*") van aparte. */
const KNOWN_EVENT_TIPOS = new Set(['puntoAtaque', 'puntoSaque', 'puntoBloqueo', 'errorSaque', 'error', 'tiempo', 'cambio'])
/** Sanciones vistas; una nueva (amarilla, roja...) se trata como sanción, pero hay que confirmar si concede punto. */
const KNOWN_SANCTIONS = new Set(['sanction:green', 'sanction:delay'])

const STAT_OF = { attack: 'attacks', ace: 'aces', block: 'blocks', serve_error: 'serve_errors', unforced_error: 'unforced_errors' } as const

export type ContractTarget = { idCliente: number; ligaId: number }

export type ContractReport = {
  ok: boolean
  checked: number[]
  failures: string[]
  warnings: string[]
}

type Findings = { failures: string[]; warnings: string[] }

async function rawDetalle(id: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${env.courtrackBaseUrl}/api/torneo/getDetallePartido?id=${id}`, { headers: { Accept: 'application/json' } })
  return (await res.json()) as Record<string, unknown>
}

function checkRaw(id: number, raw: Record<string, unknown>, { failures, warnings }: Findings) {
  const newKeys = Object.keys(raw).filter((key) => !KNOWN_DETALLE_KEYS.has(key))
  if (newKeys.length) warnings.push(`partido ${id}: claves nuevas en getDetallePartido: ${newKeys.join(', ')}`)
  const tipos = new Map<string, string>()
  for (const entries of Object.values((raw.progresion ?? {}) as Record<string, unknown[]>)) {
    for (const entry of entries ?? []) {
      for (const evento of [(entry as { eventoA?: unknown }).eventoA, (entry as { eventoB?: unknown }).eventoB]) {
        const tipo = (evento as { tipo?: string } | null)?.tipo
        if (tipo && !KNOWN_EVENT_TIPOS.has(tipo) && !KNOWN_SANCTIONS.has(tipo)) tipos.set(tipo, String((evento as { descripcion?: unknown }).descripcion))
      }
    }
  }
  for (const [tipo, ejemplo] of tipos) {
    if (tipo.startsWith('sanction')) warnings.push(`partido ${id}: sanción nueva "${tipo}" (p. ej. ${JSON.stringify(ejemplo)}): confirmar si concede punto`)
    else failures.push(`partido ${id}: tipo de evento desconocido "${tipo}" (p. ej. ${JSON.stringify(ejemplo)}) → cae en 'other'`)
  }
}

function checkParsed(p: CourtrackPartido, { failures, warnings }: Findings) {
  const counts = new Map<string, Record<string, number>>()
  for (const set of p.sets) {
    let points = 0
    for (const event of set.events) {
      if (!['timeout', 'substitution', 'sanction'].includes(event.kind)) points += 1
      const stat = STAT_OF[event.kind as keyof typeof STAT_OF]
      if (!stat) continue
      if (!event.player || event.player.number === null) {
        failures.push(`partido ${p.id} set ${set.number}: ${event.kind} sin jugador reconocible (${JSON.stringify(event)})`)
        continue
      }
      const roster = event.side === 'a' ? set.roster_a : set.roster_b
      if (!roster?.some((player) => player.number === event.player!.number)) {
        failures.push(`partido ${p.id} set ${set.number}: #${event.player.number} ${event.player.name} tiene acciones pero no está en el plantel del set`)
      }
      if (event.opponent?.relation === 'forced_error') {
        const rivalTeam = event.side === 'a' ? p.team_b : p.team_a
        if (!p.players.some((player) => player.team === rivalTeam && player.number === event.opponent!.number)) {
          failures.push(`partido ${p.id} set ${set.number}: error forzado a #${event.opponent.number} ${event.opponent.name}, que no juega en ${rivalTeam}`)
        }
      }
      if (event.opponent?.relation === 'other') warnings.push(`partido ${p.id}: relación con el rival desconocida en "${event.detail}"`)
      const key = `${event.side === 'a' ? p.team_a : p.team_b}#${event.player.number}`
      const line = counts.get(key) ?? {}
      line[stat] = (line[stat] ?? 0) + 1
      counts.set(key, line)
    }
    if (set.events.length && points !== set.score_a + set.score_b) {
      failures.push(`partido ${p.id} set ${set.number}: la progresión suma ${points} puntos y el marcador ${set.score_a}-${set.score_b}`)
    }
  }
  for (const player of p.players) {
    const line = counts.get(`${player.team}#${player.number}`) ?? {}
    for (const stat of Object.values(STAT_OF)) {
      if ((line[stat] ?? 0) !== player[stat]) {
        failures.push(`partido ${p.id}: ${player.team} #${player.number} ${player.short_name} ${stat}: progresión ${line[stat] ?? 0} ≠ oficial ${player[stat]}`)
      }
    }
  }
}

const describe = (err: unknown) =>
  err instanceof HttpError ? `${err.code}: ${err.message} ${JSON.stringify(err.details ?? '')}` : String(err)

/** Ids de los últimos `last` partidos jugados de una liga, del más reciente al más antiguo. */
export async function latestPlayedIds(target: ContractTarget, last: number): Promise<number[]> {
  const liga = await getLiga(target.idCliente, target.ligaId)
  const played = (await findPartidos(liga)).filter((partido) => partido.status === 'played')
  played.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id - a.id)
  return played.slice(0, last).map((partido) => partido.id)
}

/**
 * Revisa los partidos indicados. `onMatch` recibe una línea por partido revisado (la CLI la imprime).
 * Un fallo al obtener un partido cuenta como falla de contrato: no se lanza, se anota en el informe.
 */
export async function checkMatches(ids: number[], onMatch?: (line: string) => void): Promise<ContractReport> {
  const findings: Findings = { failures: [], warnings: [] }
  for (const id of ids) {
    try {
      checkRaw(id, await rawDetalle(id), findings)
      const partido = await getDetallePartido(id)
      checkParsed(partido, findings)
      onMatch?.(`· ${id} ${partido.team_a} ${partido.sets_a}-${partido.sets_b} ${partido.team_b}: ${partido.sets.length} sets, ${partido.players.length} jugadores`)
    } catch (err) {
      findings.failures.push(`partido ${id}: ${describe(err)}`)
    }
  }
  return { ok: findings.failures.length === 0, checked: ids, ...findings }
}

/** Revisa los últimos partidos jugados de cada liga. Si una liga no responde, se anota como falla de esa liga. */
export async function checkLeagues(targets: ContractTarget[], last: number, onMatch?: (line: string) => void): Promise<ContractReport> {
  const report: ContractReport = { ok: true, checked: [], failures: [], warnings: [] }
  const seen = new Set<number>()
  for (const target of targets) {
    let ids: number[]
    try {
      ids = (await latestPlayedIds(target, last)).filter((id) => !seen.has(id))
    } catch (err) {
      report.failures.push(`liga ${target.ligaId} (cliente ${target.idCliente}): ${describe(err)}`)
      continue
    }
    ids.forEach((id) => seen.add(id))
    const partial = await checkMatches(ids, onMatch)
    report.checked.push(...partial.checked)
    report.failures.push(...partial.failures)
    report.warnings.push(...partial.warnings)
  }
  report.ok = report.failures.length === 0
  return report
}
