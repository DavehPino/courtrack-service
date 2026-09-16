// Partidos en Supabase: búsqueda por id de CourtTrack, adopción de partidos manuales, alta y edición.
import type { Json, Tables } from './database.types.js'
import { db } from './supabase.js'
import { matchSlugBase, type SetScore } from './text.js'

export type MatchRow = Tables['matches']['Row']

/** Campos que gobierna CourtTrack. Nunca se tocan `slug`, `summary`, `cover_image_url` ni `activity_id`. */
export type MatchValues = {
  courtrack_id: string
  courtrack_league_id: string
  competition_id: string
  played_on: string
  start_time: string | null
  opponent_team_id: string
  is_home: boolean
  location: string | null
  phase: string | null
  sets_won: number
  sets_lost: number
  set_scores: SetScore[]
}

const UNIQUE_VIOLATION = '23505'
const SLUG_ATTEMPTS = 3

/** Partidos ya importados, por id de CourtTrack. */
export async function findByCourtrackIds(ids: string[]): Promise<Map<string, MatchRow>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await db().from('matches').select('*').in('courtrack_id', ids)
  if (error) throw error
  return new Map(data.map((row) => [row.courtrack_id as string, row]))
}

/**
 * Partido cargado a mano (sin courtrack_id) el mismo día contra el mismo rival, de la misma competición o sin
 * competición: es el mismo partido. Un amistoso manual ese día no se adopta.
 */
export async function findManualMatch(playedOn: string, opponentTeamId: string, competitionId: string): Promise<MatchRow | null> {
  const { data, error } = await db()
    .from('matches')
    .select('*')
    .eq('played_on', playedOn)
    .eq('opponent_team_id', opponentTeamId)
    .is('courtrack_id', null)
    .or(`competition_id.is.null,competition_id.eq.${competitionId}`)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

/** Primer slug libre: base, base-2, base-3... (misma regla que el dashboard). */
async function freeSlug(base: string): Promise<string> {
  const { data, error } = await db().from('matches').select('slug').like('slug', `${base}%`)
  if (error) throw error
  const taken = new Set(data.map((row) => row.slug))
  let slug = base
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`
  return slug
}

export async function insertMatch(values: MatchValues, opponentName: string): Promise<{ id: string; slug: string }> {
  const base = matchSlugBase(values.played_on, opponentName)
  for (let attempt = 1; ; attempt += 1) {
    const slug = await freeSlug(base)
    const { data, error } = await db()
      .from('matches')
      .insert({ ...values, slug, set_scores: values.set_scores as unknown as Json })
      .select('id,slug')
      .single()
    // Un alta simultánea se quedó con el mismo slug: se recalcula.
    if (error?.code === UNIQUE_VIOLATION && attempt < SLUG_ATTEMPTS) continue
    if (error) throw error
    return data
  }
}

export async function updateMatch(id: string, values: MatchValues): Promise<void> {
  const { error } = await db()
    .from('matches')
    .update({ ...values, set_scores: values.set_scores as unknown as Json })
    .eq('id', id)
  if (error) throw error
}

function normalizeSets(raw: Json): SetScore[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const { us, them } = item as { us?: unknown; them?: unknown }
    return typeof us === 'number' && typeof them === 'number' ? [{ us, them }] : []
  })
}

/** true si la fila ya tiene exactamente los datos de CourtTrack (no hace falta escribir). */
export function isUnchanged(row: MatchRow, values: MatchValues): boolean {
  return (
    row.courtrack_id === values.courtrack_id &&
    row.courtrack_league_id === values.courtrack_league_id &&
    row.competition_id === values.competition_id &&
    row.played_on === values.played_on &&
    (row.start_time?.slice(0, 5) ?? null) === values.start_time &&
    row.opponent_team_id === values.opponent_team_id &&
    row.is_home === values.is_home &&
    row.location === values.location &&
    row.phase === values.phase &&
    row.sets_won === values.sets_won &&
    row.sets_lost === values.sets_lost &&
    JSON.stringify(normalizeSets(row.set_scores)) === JSON.stringify(values.set_scores)
  )
}
