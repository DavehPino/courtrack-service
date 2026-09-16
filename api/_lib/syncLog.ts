// Registro de sincronizaciones (tabla sync_log): auditoría y límite de syncs por ventana de 24 h.
// Contar en Supabase en vez de en memoria: las funciones no comparten estado y el historial queda visible.
import type { Json } from './database.types.js'
import { db } from './supabase.js'
import type { SyncLogEntry, SyncQuota, SyncSummary } from './types.js'

const SOURCE = 'courtrack'
const WINDOW_MS = 24 * 60 * 60 * 1000
/** Estados que consumen cupo. Los rechazados por cupo no cuentan (si no, un rechazo alargaría el bloqueo). */
const COUNTED = ['running', 'success', 'error']

/** Registra el intento antes de empezar: así dos clics simultáneos se ven el uno al otro al contar. */
export async function beginSync(orgId: string): Promise<string> {
  const { data, error } = await db()
    .from('sync_log')
    .insert({ org_id: orgId, source: SOURCE, status: 'running', dry_run: false })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function finishSync(
  id: string,
  status: 'success' | 'error' | 'rejected',
  result: SyncSummary | null,
  errorMessage: string | null = null,
): Promise<void> {
  const { error } = await db()
    .from('sync_log')
    .update({ status, finished_at: new Date().toISOString(), result: result as Json | null, error: errorMessage })
    .eq('id', id)
  if (error) throw error
}

/** Cupo de la organización en las últimas 24 h. */
export async function getQuota(orgId: string, limit: number): Promise<SyncQuota> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString()
  const { data, error } = await db()
    .from('sync_log')
    .select('started_at')
    .eq('org_id', orgId)
    .eq('source', SOURCE)
    .eq('dry_run', false)
    .in('status', COUNTED)
    .gte('started_at', since)
    .order('started_at', { ascending: true })
  if (error) throw error
  const used = data.length
  const oldest = data[0]?.started_at
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resets_at: oldest ? new Date(new Date(oldest).getTime() + WINDOW_MS).toISOString() : null,
  }
}

function toEntry(row: {
  id: string
  status: string
  started_at: string
  finished_at: string | null
  result: Json | null
  error: string | null
}): SyncLogEntry {
  const status = (['running', 'success', 'error', 'rejected'] as const).find((value) => value === row.status) ?? 'error'
  const summary =
    row.result && typeof row.result === 'object' && !Array.isArray(row.result) ? (row.result as unknown as SyncSummary) : null
  return { id: row.id, status, started_at: row.started_at, finished_at: row.finished_at, summary, error: row.error }
}

/** Últimas sincronizaciones reales, de la más reciente a la más antigua. */
export async function lastSyncs(orgId: string, limit: number): Promise<SyncLogEntry[]> {
  const { data, error } = await db()
    .from('sync_log')
    .select('id,status,started_at,finished_at,result,error')
    .eq('org_id', orgId)
    .eq('source', SOURCE)
    .eq('dry_run', false)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data.map(toEntry)
}
