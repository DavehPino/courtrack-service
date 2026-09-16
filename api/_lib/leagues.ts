// Ligas de CourtTrack configuradas por cada organización (tabla courtrack_leagues, la gestiona el dashboard).
// Cada fila es UNA temporada: el servicio la lee, anota el sync, guarda la instantánea y, cuando CourtTrack
// resetea la liga, la archiva y abre la temporada siguiente.
import type { Json } from './database.types.js'
import { HttpError } from './http.js'
import { db } from './supabase.js'

export type League = {
  id: string
  org_id: string
  competition: { id: string; name: string; kind: string }
  id_cliente: number
  cliente_name: string | null
  liga_id: number
  liga_name: string
  season_label: string
  team_name: string
  team_logo_url: string | null
  is_active: boolean
  last_synced_at: string | null
  archived_at: string | null
  archive_reason: 'reset' | 'removed' | null
  snapshot_at: string | null
}

// Un único literal: el cliente de Supabase infiere el tipo del select solo desde literales, no desde concatenaciones.
const SELECT =
  'id,org_id,id_cliente,cliente_name,liga_id,liga_name,season_label,team_name,team_logo_url,is_active,last_synced_at,archived_at,archive_reason,snapshot_at,competition:competitions!courtrack_leagues_competition_id_fkey(id,name,kind)'

type Row = Omit<League, 'competition' | 'archive_reason'> & {
  competition: League['competition'] | null
  archive_reason: string | null
}

const REASONS = ['reset', 'removed'] as const

function toLeague(row: Row): League {
  if (!row.competition) throw new Error(`La liga ${row.id} no tiene competición`)
  const reason = REASONS.find((value) => value === row.archive_reason) ?? null
  return { ...row, competition: row.competition, archive_reason: reason }
}

/** Todas las temporadas de la organización: abiertas primero (activas antes que pausadas), archivadas al final. */
export async function listLeagues(orgId: string): Promise<League[]> {
  const { data, error } = await db()
    .from('courtrack_leagues')
    .select(SELECT)
    .eq('org_id', orgId)
    .order('archived_at', { ascending: false, nullsFirst: true })
    .order('is_active', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data.map(toLeague)
}

/** Temporadas abiertas y activas: las que recorre "Sincronizar todo". */
export async function listActiveLeagues(orgId: string): Promise<League[]> {
  return (await listLeagues(orgId)).filter((league) => league.is_active && !league.archived_at)
}

/** 404 si no existe o pertenece a otra organización (el secreto es compartido: no se revela que exista). */
export async function getLeague(orgId: string, leagueId: string): Promise<League> {
  const { data, error } = await db().from('courtrack_leagues').select(SELECT).eq('id', leagueId).maybeSingle()
  if (error) throw error
  if (!data || data.org_id !== orgId) throw new HttpError(404, 'league_not_found', 'La liga no existe')
  return toLeague(data)
}

/** Anota el sync y, si CourtTrack publica el escudo propio, lo guarda para mostrarlo en el dashboard. */
export async function touchLeague(id: string, teamLogoUrl: string | null): Promise<void> {
  const changes: { last_synced_at: string; team_logo_url?: string } = { last_synced_at: new Date().toISOString() }
  if (teamLogoUrl) changes.team_logo_url = teamLogoUrl
  const { error } = await db().from('courtrack_leagues').update(changes).eq('id', id)
  if (error) console.error(error)
}

export type Snapshot = {
  liga_name: string
  standings: Json | null
  fixture: Json
}

/** Instantánea de CourtTrack tras cada sync (queda congelada cuando la temporada se archiva). */
export async function saveSnapshot(id: string, snapshot: Snapshot): Promise<void> {
  const { error } = await db()
    .from('courtrack_leagues')
    .update({
      liga_name: snapshot.liga_name,
      season_label: snapshot.liga_name,
      standings: snapshot.standings,
      fixture: snapshot.fixture,
      snapshot_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) console.error(error)
}

/** Cierra la temporada: conserva partidos, instantánea y nombre; deja de sincronizarse. */
export async function archiveLeague(id: string, reason: 'reset' | 'removed'): Promise<void> {
  const { error } = await db()
    .from('courtrack_leagues')
    .update({ archived_at: new Date().toISOString(), archive_reason: reason, is_active: false })
    .eq('id', id)
  if (error) throw error
}

/** Abre la temporada siguiente de la misma liga (misma competición, asociación y equipo). */
export async function openNextSeason(previous: League, seasonLabel: string): Promise<League> {
  const { data, error } = await db()
    .from('courtrack_leagues')
    .insert({
      org_id: previous.org_id,
      competition_id: previous.competition.id,
      id_cliente: previous.id_cliente,
      cliente_name: previous.cliente_name,
      liga_id: previous.liga_id,
      liga_name: seasonLabel,
      season_label: seasonLabel,
      team_name: previous.team_name,
      team_logo_url: previous.team_logo_url,
      is_active: true,
    })
    .select(SELECT)
    .single()
  if (error) throw error
  return toLeague(data)
}

/** Ids de CourtTrack de los partidos guardados en esta temporada: sirven para detectar el reseteo. */
export async function storedCourtrackIds(leagueId: string): Promise<Set<string>> {
  const { data, error } = await db()
    .from('matches')
    .select('courtrack_id')
    .eq('courtrack_league_id', leagueId)
    .not('courtrack_id', 'is', null)
  if (error) throw error
  return new Set(data.map((row) => row.courtrack_id as string))
}
