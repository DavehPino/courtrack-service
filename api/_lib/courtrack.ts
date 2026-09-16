// Cliente de la API de CourtTrack (app móvil de PODIO y otras asociaciones). API privada y sin documentar:
// todo lo frágil vive aquí. Contrato verificado en vivo: GET sin auth contra /api/torneo/*;
// `findPartidos` exige id_torneos e id_etapas; `getEquipos` no responde (los equipos se derivan de los partidos).
import { z } from 'zod'
import { env } from './env.js'
import { HttpError } from './http.js'
import { sameName, titleCase } from './text.js'
import type { CourtrackCliente, CourtrackDiscoveredLiga, CourtrackEquipo, CourtrackLiga } from './types.js'

const REQUEST_TIMEOUT_MS = 8_000
/** Un reintento ante fallo de red, timeout o 5xx. */
const ATTEMPTS = 2

const score = z.number().int().nullable().optional()

export const partidoSchema = z.object({
  id: z.number().int(),
  /** ISO a medianoche UTC: "2026-08-09T00:00:00.000Z". */
  fecha: z.string(),
  /** Hora como entero: 1600 = 16:00. */
  horario: z.number().int().nullable().optional(),
  id_equipo_a: z.string(),
  id_equipo_b: z.string(),
  /** "played" | "upcoming" (y cualquier otro que añadan: se trata como no jugado). */
  status: z.string(),
  sets_a: score,
  sets_b: score,
  set1_a: score,
  set1_b: score,
  set2_a: score,
  set2_b: score,
  set3_a: score,
  set3_b: score,
  set4_a: score,
  set4_b: score,
  set5_a: score,
  set5_b: score,
  id_cancha: z.string().nullable().optional(),
  etapa_formatted: z.string().nullable().optional(),
  torneo: z.string().nullable().optional(),
  logo_a: z.string().nullable().optional(),
  logo_b: z.string().nullable().optional(),
})
export type Partido = z.infer<typeof partidoSchema>

const findPartidosResponse = z.object({ data: z.array(partidoSchema) })

const text = z.string().nullish()

/** Asociación (getClientes). Laxo: una entrada rara no rompe el catálogo. */
const clienteSchema = z
  .object({ id: z.number().int(), nombre: text, titulo: text, descripcion: text, logo: text, deporte: text })
  .loose()

/** Liga dentro de una asociación (getLigas). Solo lo que hace falta para elegirla y sincronizarla. */
const ligaSchema = z
  .object({
    id: z.number().int(),
    nombre: z.string(),
    descripcion: text,
    logo: text,
    id_torneos: z.array(z.union([z.string(), z.number()])).min(1),
    /** "3730,3731": etapas separadas por coma. */
    id_etapas: z.union([z.string(), z.number()]),
    etapas: z
      .array(z.object({ id: z.number().int(), titulo: text, division: text, descripcion: text }).loose())
      .nullish(),
  })
  .loose()
export type Liga = z.infer<typeof ligaSchema>

const courtrackError = (message: string, details?: unknown) => new HttpError(502, 'courtrack_error', message, details)

async function fetchJson(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${env.courtrackBaseUrl}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  let lastError: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.status >= 500) {
        lastError = courtrackError(`CourtTrack respondió ${res.status} en ${path}`)
        continue
      }
      const body: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        const message = (body as { message?: unknown } | null)?.message
        throw courtrackError(
          `CourtTrack rechazó la petición a ${path} (${res.status})${typeof message === 'string' ? `: ${message}` : ''}`,
        )
      }
      return body
    } catch (err) {
      if (err instanceof HttpError && err.status !== 502) throw err
      lastError = err instanceof HttpError ? err : courtrackError(`No se pudo conectar con CourtTrack (${path})`, String(err))
    }
  }
  throw lastError
}

function parse<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new HttpError(502, 'courtrack_schema', `La respuesta de CourtTrack (${what}) no tiene el formato esperado`, result.error.issues)
  }
  return result.data
}

/** Elementos válidos de una lista; los que no cumplen el esquema se descartan (y se registran). */
function parseEach<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.infer<S>[] {
  const items = parse(z.array(z.unknown()), raw, what)
  return items.flatMap((item) => {
    const result = schema.safeParse(item)
    if (!result.success) console.warn(`CourtTrack (${what}): entrada descartada`, result.error.issues[0])
    return result.success ? [result.data] : []
  })
}

/** Asociaciones/ligas disponibles en CourtTrack (PODIO = 5, etc.). */
export async function getClientes(): Promise<CourtrackCliente[]> {
  const raw = await fetchJson('/api/torneo/getClientes', {})
  return parseEach(clienteSchema, raw, 'getClientes').map((item) => ({
    id: item.id,
    nombre: item.nombre ?? String(item.id),
    titulo: item.titulo ?? item.descripcion ?? null,
    logo: item.logo ?? null,
    deporte: item.deporte ?? null,
  }))
}

async function fetchLigas(idCliente: number): Promise<Liga[]> {
  const raw = await fetchJson('/api/torneo/getLigas', { id_cliente: String(idCliente) })
  return parseEach(ligaSchema, raw, 'getLigas')
}

export function ligaSummary(liga: Liga): CourtrackLiga {
  return {
    id: liga.id,
    nombre: liga.nombre,
    descripcion: liga.descripcion ?? null,
    logo: liga.logo ?? null,
    etapas: (liga.etapas ?? []).map((etapa) => ({
      id: etapa.id,
      titulo: [etapa.descripcion, etapa.division, etapa.titulo].filter(Boolean).join(' · ') || String(etapa.id),
    })),
  }
}

/** Ligas de una asociación, para elegir cuál sincronizar. */
export async function getLigas(idCliente: number): Promise<CourtrackLiga[]> {
  return (await fetchLigas(idCliente)).map(ligaSummary)
}

/** Ligas de la asociación en las que juega el equipo (busca su nombre en los partidos de cada liga). */
export async function discoverLeagues(idCliente: number, teamName: string): Promise<CourtrackDiscoveredLiga[]> {
  const ligas = await fetchLigas(idCliente)
  const found: CourtrackDiscoveredLiga[] = []
  // De cuatro en cuatro: PODIO tiene ~13 ligas y cada findPartidos tarda medio segundo.
  const pending = [...ligas]
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      for (let liga = pending.shift(); liga; liga = pending.shift()) {
        try {
          const partidos = await findPartidos(liga)
          const team = teamsFromPartidos(partidos).find((item) => sameName(item.name, teamName))
          if (!team) continue
          found.push({
            liga: ligaSummary(liga),
            team,
            total_matches: partidos.length,
            played_matches: partidos.filter((partido) => partido.status === 'played').length,
          })
        } catch (err) {
          console.warn(`CourtTrack: no se pudo leer la liga ${liga.id}`, err)
        }
      }
    }),
  )
  return found.sort((a, b) => a.liga.id - b.liga.id)
}

/** Clasificación de cada etapa de la liga, tal cual la devuelve CourtTrack (se guarda como instantánea). */
export async function getPosiciones(liga: Liga): Promise<unknown[]> {
  const etapas = String(liga.id_etapas)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const tables: unknown[] = []
  for (const etapa of etapas) {
    const raw = await fetchJson('/api/torneo/getPosiciones', {
      id_torneos: liga.id_torneos.map(String).join(','),
      id_etapas: etapa,
    })
    const items = Array.isArray(raw) ? raw : (raw as { data?: unknown[] } | null)?.data
    if (Array.isArray(items)) tables.push(...items)
  }
  return tables
}

/** Liga concreta con sus torneos y etapas actuales (cambian a mitad de temporada: se resuelven en cada sync). */
export async function getLiga(idCliente: number, ligaId: number): Promise<Liga> {
  const liga = (await fetchLigas(idCliente)).find((item) => item.id === ligaId)
  if (!liga) {
    throw new HttpError(502, 'courtrack_liga_not_found', `La liga ${ligaId} no existe en CourtTrack para la asociación ${idCliente}`)
  }
  return liga
}

/** Todos los partidos de la liga (todas sus etapas), jugados y por jugar, con parciales. */
export async function findPartidos(liga: Liga): Promise<Partido[]> {
  const raw = await fetchJson('/api/torneo/findPartidos', {
    id_torneos: liga.id_torneos.map(String).join(','),
    id_etapas: String(liga.id_etapas),
  })
  return parse(findPartidosResponse, raw, 'findPartidos').data
}

/** Equipos que participan en la liga, derivados de sus partidos (getEquipos no responde). */
export function teamsFromPartidos(partidos: Partido[]): CourtrackEquipo[] {
  const teams = new Map<string, CourtrackEquipo>()
  for (const partido of partidos) {
    for (const [name, logo] of [
      [partido.id_equipo_a, partido.logo_a],
      [partido.id_equipo_b, partido.logo_b],
    ] as const) {
      const current = teams.get(name) ?? { name, display_name: titleCase(name), logo: null, matches: 0 }
      current.matches += 1
      current.logo ??= logo?.trim() || null
      teams.set(name, current)
    }
  }
  return [...teams.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'))
}

export type Side = 'a' | 'b'

/** Parciales jugados de un partido: se corta en el primer set 0-0 (CourtTrack rellena con ceros los no jugados). */
export function partidoSets(partido: Partido, ours: Side): { us: number; them: number }[] {
  const sets: { us: number; them: number }[] = []
  for (const n of [1, 2, 3, 4, 5] as const) {
    const a = partido[`set${n}_a`] ?? 0
    const b = partido[`set${n}_b`] ?? 0
    if (a === 0 && b === 0) break
    sets.push(ours === 'a' ? { us: a, them: b } : { us: b, them: a })
  }
  return sets
}
