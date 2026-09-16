// Subconjunto del esquema de Supabase que usa este servicio. La fuente de verdad es el repo del dashboard
// (coyotes-website/supabase/migrations y shared/database.types.ts, que se regenera con `npm run db:types`).
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

type TeamRow = {
  id: string
  name: string
  short_name: string | null
  is_own_team: boolean
  category: string | null
  city: string | null
  logo_url: string | null
  created_at: string
  updated_at: string
}

type MatchRow = {
  id: string
  slug: string
  played_on: string
  start_time: string | null
  opponent_team_id: string
  is_home: boolean
  location: string | null
  competition: string | null
  phase: string | null
  sets_won: number | null
  sets_lost: number | null
  set_scores: Json
  summary: string | null
  cover_image_url: string | null
  activity_id: string | null
  courtrack_id: string | null
  competition_id: string | null
  courtrack_league_id: string | null
  created_at: string
  updated_at: string
}

type SyncLogRow = {
  id: string
  org_id: string
  source: string
  status: string
  dry_run: boolean
  started_at: string
  finished_at: string | null
  result: Json | null
  error: string | null
  courtrack_league_id: string | null
}

type CompetitionRow = {
  id: string
  org_id: string
  name: string
  kind: string
  created_at: string
  updated_at: string
}

type CourtrackLeagueRow = {
  id: string
  org_id: string
  competition_id: string
  id_cliente: number
  cliente_name: string | null
  liga_id: number
  liga_name: string
  team_name: string
  team_logo_url: string | null
  is_active: boolean
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

type CourtrackTeamLinkRow = {
  id: string
  org_id: string
  courtrack_name: string
  normalized_name: string
  team_id: string
  created_at: string
}

type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

export type Database = {
  public: {
    Tables: {
      teams: {
        Row: TeamRow
        Insert: Optional<
          TeamRow,
          'id' | 'short_name' | 'is_own_team' | 'category' | 'city' | 'logo_url' | 'created_at' | 'updated_at'
        >
        Update: Partial<TeamRow>
        Relationships: []
      }
      matches: {
        Row: MatchRow
        Insert: Optional<
          MatchRow,
          | 'id'
          | 'start_time'
          | 'is_home'
          | 'location'
          | 'competition'
          | 'phase'
          | 'sets_won'
          | 'sets_lost'
          | 'set_scores'
          | 'summary'
          | 'cover_image_url'
          | 'activity_id'
          | 'courtrack_id'
          | 'competition_id'
          | 'courtrack_league_id'
          | 'created_at'
          | 'updated_at'
        >
        Update: Partial<MatchRow>
        Relationships: []
      }
      sync_log: {
        Row: SyncLogRow
        Insert: Optional<
          SyncLogRow,
          'id' | 'source' | 'status' | 'dry_run' | 'started_at' | 'finished_at' | 'result' | 'error' | 'courtrack_league_id'
        >
        Update: Partial<SyncLogRow>
        Relationships: []
      }
      competitions: {
        Row: CompetitionRow
        Insert: Optional<CompetitionRow, 'id' | 'kind' | 'created_at' | 'updated_at'>
        Update: Partial<CompetitionRow>
        Relationships: []
      }
      courtrack_leagues: {
        Row: CourtrackLeagueRow
        Insert: Optional<
          CourtrackLeagueRow,
          'id' | 'cliente_name' | 'team_logo_url' | 'is_active' | 'last_synced_at' | 'created_at' | 'updated_at'
        >
        Update: Partial<CourtrackLeagueRow>
        Relationships: [
          {
            foreignKeyName: 'courtrack_leagues_competition_id_fkey'
            columns: ['competition_id']
            isOneToOne: false
            referencedRelation: 'competitions'
            referencedColumns: ['id']
          },
        ]
      }
      courtrack_team_links: {
        Row: CourtrackTeamLinkRow
        Insert: Optional<CourtrackTeamLinkRow, 'id' | 'created_at'>
        Update: Partial<CourtrackTeamLinkRow>
        Relationships: []
      }
    }
    Views: Record<never, never>
    Functions: Record<never, never>
    Enums: Record<never, never>
    CompositeTypes: Record<never, never>
  }
}

export type Tables = Database['public']['Tables']
