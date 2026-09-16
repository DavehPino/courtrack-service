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
          'id' | 'source' | 'status' | 'dry_run' | 'started_at' | 'finished_at' | 'result' | 'error'
        >
        Update: Partial<SyncLogRow>
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
