// Contratos de /api/sync. El dashboard (coyotes-website/shared/schemas.ts) copia estos tipos para su proxy y su UI.

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
  opponent?: { name: string; created: boolean }
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
  league: { id: number; name: string }
  matches: SyncMatchReport[]
  quota: SyncQuota
}

export type SyncLogEntry = {
  id: string
  status: 'running' | 'success' | 'error' | 'rejected'
  started_at: string
  finished_at: string | null
  summary: SyncSummary | null
  error: string | null
}

export type SyncStatus = {
  org_id: string
  quota: SyncQuota
  last_syncs: SyncLogEntry[]
}
