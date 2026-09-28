// Chequeo de contrato contra la API de CourtTrack (privada y sin documentar: cambia sin aviso). Solo lee CourtTrack,
// no toca Supabase. Sale con código 1 si algo no cuadra; es el primer paso del handoff de docs/handoff-courtrack.md.
//   npm run check:courtrack                                   últimos 4 partidos jugados de la liga 605 (PODIO)
//   npm run check:courtrack -- --cliente 5 --liga 605 --last 8 --partido 62526,61930
// Invariantes:
//   1. getLigas, findPartidos y getDetallePartido pasan los esquemas de api/_lib/courtrack.ts
//   2. no aparecen claves ni tipos de evento nuevos (avisa: puede haber datos que aprovechar o renombres)
//   3. cada acción de la progresión tiene jugador con dorsal (el parser de descripciones entiende el formato)
//   4. las acciones por jugador sacadas de la progresión = los totales oficiales de estadisticasJugador
//   5. los puntos de la progresión de cada set = su marcador final
import { env } from '../api/_lib/env.js'
import { HttpError } from '../api/_lib/http.js'
import { findPartidos, getDetallePartido, getLiga } from '../api/_lib/courtrack.js'
import type { CourtrackPartido } from '../api/_lib/types.js'

const argv = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const idCliente = Number(option('--cliente') ?? 5)
const ligaId = Number(option('--liga') ?? 605)
const last = Number(option('--last') ?? 4)
const explicitIds = (option('--partido') ?? '').split(',').map(Number).filter(Boolean)

/** Lo que conocemos de getDetallePartido: una clave fuera de esta lista es un cambio de CourtTrack a revisar. */
const KNOWN_DETALLE_KEYS = new Set(
  'id,id_cliente,numero,id_torneo,id_etapa,fecha,horario,id_club,nro_cancha,id_equipo_a,id_equipo_b,id_equipo_trabajo,ronda,sets_a,sets_b,duracion,status,instancia,version_id,etapa,etapa_formatted,id_rama,torneo,imagen_equipo_a,logo_equipo_a,imagen_equipo_b,logo_equipo_b,mvp_nombre,mvp_imagen,mvp_fecha_nacimiento,mvp_equipo,mvp_posicion,id_arbitro1,id_arbitro2,id_linea1,id_linea2,id_linea3,id_linea4,id_planillero,id_capitan_a,id_capitan_b,id_coordinador,mvp_fecha_nacimiento_formatted,fecha_formatted,horario_formatted,hora_inicio_formatted,hora_fin_formatted,arbitro1,arbitro2,linea1,linea2,linea3,linea4,planillero,coordinador,autoridades,fotos_versus,eventos,sets,estadisticas,estadisticasJugador,maximoAnotador,mejorAtacante,mejorSacador,mejorBloqueador,mvp,progresion'.split(','),
)
/** Coincide con EVENT_KINDS de api/_lib/courtrack.ts; las sanciones ("sanction:*") van aparte. */
const KNOWN_EVENT_TIPOS = new Set(['puntoAtaque', 'puntoSaque', 'puntoBloqueo', 'errorSaque', 'error', 'tiempo', 'cambio'])
/** Sanciones vistas; una nueva (amarilla, roja...) se trata como sanción, pero hay que confirmar si concede punto. */
const KNOWN_SANCTIONS = new Set(['sanction:green', 'sanction:delay'])

const STAT_OF = { attack: 'attacks', ace: 'aces', block: 'blocks', serve_error: 'serve_errors', unforced_error: 'unforced_errors' } as const

const failures: string[] = []
const warnings: string[] = []
const fail = (message: string) => failures.push(message)
const warn = (message: string) => warnings.push(message)

async function rawDetalle(id: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${env.courtrackBaseUrl}/api/torneo/getDetallePartido?id=${id}`, { headers: { Accept: 'application/json' } })
  return (await res.json()) as Record<string, unknown>
}

function checkRaw(id: number, raw: Record<string, unknown>) {
  const newKeys = Object.keys(raw).filter((key) => !KNOWN_DETALLE_KEYS.has(key))
  if (newKeys.length) warn(`partido ${id}: claves nuevas en getDetallePartido: ${newKeys.join(', ')}`)
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
    if (tipo.startsWith('sanction')) warn(`partido ${id}: sanción nueva "${tipo}" (p. ej. ${JSON.stringify(ejemplo)}): confirmar si concede punto`)
    else fail(`partido ${id}: tipo de evento desconocido "${tipo}" (p. ej. ${JSON.stringify(ejemplo)}) → cae en 'other'`)
  }
}

function checkParsed(p: CourtrackPartido) {
  const counts = new Map<string, Record<string, number>>()
  for (const set of p.sets) {
    let points = 0
    for (const event of set.events) {
      if (!['timeout', 'substitution', 'sanction'].includes(event.kind)) points += 1
      const stat = STAT_OF[event.kind as keyof typeof STAT_OF]
      if (!stat) continue
      if (!event.player || event.player.number === null) {
        fail(`partido ${p.id} set ${set.number}: ${event.kind} sin jugador reconocible (${JSON.stringify(event)})`)
        continue
      }
      const key = `${event.side === 'a' ? p.team_a : p.team_b}#${event.player.number}`
      const line = counts.get(key) ?? {}
      line[stat] = (line[stat] ?? 0) + 1
      counts.set(key, line)
    }
    if (set.events.length && points !== set.score_a + set.score_b) {
      fail(`partido ${p.id} set ${set.number}: la progresión suma ${points} puntos y el marcador ${set.score_a}-${set.score_b}`)
    }
  }
  for (const player of p.players) {
    const line = counts.get(`${player.team}#${player.number}`) ?? {}
    for (const stat of Object.values(STAT_OF)) {
      if ((line[stat] ?? 0) !== player[stat]) {
        fail(`partido ${p.id}: ${player.team} #${player.number} ${player.short_name} ${stat}: progresión ${line[stat] ?? 0} ≠ oficial ${player[stat]}`)
      }
    }
  }
}

async function main() {
  let ids = explicitIds
  if (!ids.length) {
    const liga = await getLiga(idCliente, ligaId)
    const played = (await findPartidos(liga)).filter((partido) => partido.status === 'played')
    played.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id - a.id)
    ids = played.slice(0, last).map((partido) => partido.id)
    console.log(`Liga ${ligaId}: ${played.length} partidos jugados; se revisan ${ids.join(', ')}`)
  }
  for (const id of ids) {
    try {
      checkRaw(id, await rawDetalle(id))
      const partido = await getDetallePartido(id)
      checkParsed(partido)
      console.log(`· ${id} ${partido.team_a} ${partido.sets_a}-${partido.sets_b} ${partido.team_b}: ${partido.sets.length} sets, ${partido.players.length} jugadores`)
    } catch (err) {
      fail(`partido ${id}: ${err instanceof HttpError ? `${err.code}: ${err.message} ${JSON.stringify(err.details ?? '')}` : String(err)}`)
    }
  }
  for (const message of warnings) console.warn(`AVISO  ${message}`)
  for (const message of failures) console.error(`FALLA  ${message}`)
  console.log(failures.length ? `\n${failures.length} fallas: el contrato con CourtTrack cambió.` : '\nContrato con CourtTrack OK.')
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err instanceof HttpError ? `${err.code}: ${err.message} ${JSON.stringify(err.details ?? '')}` : err)
  process.exit(1)
})
