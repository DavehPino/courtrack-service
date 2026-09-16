// Cliente de la API de CourtTrack (app móvil de PODIO). API privada y sin documentar: todo lo frágil vive aquí.
// Contrato verificado en vivo: GET sin auth contra /api/torneo/*; `findPartidos` exige id_torneos e id_etapas.
import { z } from 'zod'
import { env } from './env.js'
import { HttpError } from './http.js'

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

const ligaSchema = z.object({
  id: z.number().int(),
  nombre: z.string(),
  id_torneos: z.array(z.union([z.string(), z.number()])).min(1),
  /** "3730,3731": etapas separadas por coma. */
  id_etapas: z.union([z.string(), z.number()]),
})
export type Liga = z.infer<typeof ligaSchema>

const courtrackError = (message: string, details?: unknown) => new HttpError(502, 'courtrack_error', message, details)

async function fetchJson(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${env.courtrack.baseUrl}${path}`)
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

/** Liga configurada (COURTRACK_LIGA_ID) dentro de la asociación (COURTRACK_ID_CLIENTE): trae sus torneos y etapas. */
export async function getLiga(): Promise<Liga> {
  const { idCliente, ligaId } = env.courtrack
  const raw = await fetchJson('/api/torneo/getLigas', { id_cliente: String(idCliente) })
  const ligas = parse(z.array(z.object({ id: z.number().int() }).loose()), raw, 'getLigas')
  const liga = ligas.find((item) => item.id === ligaId)
  if (!liga) {
    throw new HttpError(502, 'courtrack_liga_not_found', `La liga ${ligaId} no existe en CourtTrack para el cliente ${idCliente}`)
  }
  return parse(ligaSchema, liga, `liga ${ligaId}`)
}

/** Todos los partidos de la liga (todas sus etapas), jugados y por jugar, con parciales. */
export async function findPartidos(liga: Liga): Promise<Partido[]> {
  const raw = await fetchJson('/api/torneo/findPartidos', {
    id_torneos: liga.id_torneos.map(String).join(','),
    id_etapas: String(liga.id_etapas),
  })
  return parse(findPartidosResponse, raw, 'findPartidos').data
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
