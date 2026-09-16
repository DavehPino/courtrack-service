// Ligas de CourtTrack configuradas por cada organización (tabla courtrack_leagues, la gestiona el dashboard).
// El servicio solo las lee y anota last_synced_at.
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
  team_name: string
  team_logo_url: string | null
  is_active: boolean
  last_synced_at: string | null
}

// Un único literal: el cliente de Supabase infiere el tipo del select solo desde literales, no desde concatenaciones.
const SELECT =
  'id,org_id,id_cliente,cliente_name,liga_id,liga_name,team_name,team_logo_url,is_active,last_synced_at,competition:competitions!courtrack_leagues_competition_id_fkey(id,name,kind)'

type Row = Omit<League, 'competition'> & { competition: League['competition'] | null }

function toLeague(row: Row): League {
  if (!row.competition) throw new Error(`La liga ${row.id} no tiene competición`)
  return { ...row, competition: row.competition }
}

export async function listLeagues(orgId: string): Promise<League[]> {
  const { data, error } = await db()
    .from('courtrack_leagues')
    .select(SELECT)
    .eq('org_id', orgId)
    .order('is_active', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data.map(toLeague)
}

/** 404 si no existe o pertenece a otra organización (el secreto es compartido: no se revela que exista). */
export async function getLeague(orgId: string, leagueId: string): Promise<League> {
  const { data, error } = await db().from('courtrack_leagues').select(SELECT).eq('id', leagueId).maybeSingle()
  if (error) throw error
  if (!data || data.org_id !== orgId) throw new HttpError(404, 'league_not_found', 'La liga no existe')
  return toLeague(data)
}

/**
 * Liga por defecto cuando no se indica una: la única activa de la organización.
 * Compatibilidad con clientes que aún no envían league_id.
 */
export async function resolveDefaultLeague(orgId: string): Promise<League> {
  const active = (await listLeagues(orgId)).filter((league) => league.is_active)
  if (active.length === 1) return active[0]!
  if (active.length === 0) throw new HttpError(404, 'league_not_found', 'La organización no tiene ligas activas')
  throw new HttpError(400, 'league_required', 'Hay varias ligas activas: indica league_id')
}

export async function touchLeague(id: string): Promise<void> {
  const { error } = await db().from('courtrack_leagues').update({ last_synced_at: new Date().toISOString() }).eq('id', id)
  if (error) console.error(error)
}
