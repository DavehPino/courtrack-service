// Contratos de /api/sync y /api/courtrack/*. El dashboard (coyotes-website/shared/schemas.ts) copia estos tipos.

// ─── Catálogo de CourtTrack ──────────────────────────────────────────────────
export type CourtrackCliente = {
  id: number
  nombre: string
  titulo: string | null
  logo: string | null
  deporte: string | null
}

export type CourtrackLiga = {
  id: number
  nombre: string
  descripcion: string | null
  logo: string | null
  etapas: { id: number; titulo: string }[]
}

export type CourtrackEquipo = {
  /** Nombre tal como lo escribe CourtTrack (mayúsculas): es el que se guarda en courtrack_leagues.team_name. */
  name: string
  display_name: string
  logo: string | null
  matches: number
}

// ─── Ligas configuradas por la organización ──────────────────────────────────
export type SyncLeague = {
  id: string
  competition: { id: string; name: string; kind: string }
  id_cliente: number
  cliente_name: string | null
  liga_id: number
  liga_name: string
  team_name: string
  team_logo_url: string | null
  is_active: boolean
  last_synced_at: string | null
  /** Último sync real de esta liga, si lo hubo. */
  last_sync: SyncLogEntry | null
}

// ─── Sincronización ──────────────────────────────────────────────────────────
export type SyncQuota = {
  /** Syncs reales permitidos en 24 h (SYNC_DAILY_LIMIT). */
  limit: number
  used: number
  remaining: number
  /** Cuándo sale de la ventana el sync más antiguo que cuenta (libera un cupo). Null si no se usó ninguno. */
  resets_at: string | null
}

export type SyncMatchAction = 'created' | 'updated' | 'adopted' | 'unchanged' | 'skipped'

export type SyncMatchReport = {
  courtrack_id: string
  played_on: string
  start_time: string | null
  /** Equipos en el orden de CourtTrack (a = local). */
  home: string
  away: string
  home_sets: number | null
  away_sets: number | null
  /** Estado en CourtTrack: "played" | "upcoming". */
  status: string
  action: SyncMatchAction
  /** Motivo cuando `action` es "skipped". */
  reason?: string
  /** Slug del partido en el dashboard (previsto, si es dry run). */
  slug?: string
  /** `courtrack_name`: nombre crudo en CourtTrack, para vincularlo a un rival existente. */
  opponent?: { name: string; courtrack_name: string; created: boolean; renamed_from?: string }
}

export type SyncSummary = {
  scanned: number
  own: number
  created: number
  updated: number
  adopted: number
  unchanged: number
  skipped: number
  rivals_created: string[]
}

export type SyncResult = SyncSummary & {
  dry_run: boolean
  league: {
    id: string
    courtrack_id: number
    name: string
    competition: { id: string; name: string }
  }
  matches: SyncMatchReport[]
  quota: SyncQuota
}

export type SyncLogEntry = {
  id: string
  league_id: string | null
  status: 'running' | 'success' | 'error' | 'rejected'
  started_at: string
  finished_at: string | null
  summary: SyncSummary | null
  error: string | null
}

export type SyncStatus = {
  org_id: string
  quota: SyncQuota
  leagues: SyncLeague[]
  last_syncs: SyncLogEntry[]
}
