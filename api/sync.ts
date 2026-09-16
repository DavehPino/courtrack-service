// GET  /api/sync?org_id= → SyncStatus: cupo restante, ligas configuradas y últimas sincronizaciones.
// POST /api/sync { org_id, league_id?, dry_run? } → SyncResult de esa liga (sin league_id: la única activa).
//   429 `quota_exceeded` si se agotó el cupo diario · 404 `league_not_found` · 409 `league_inactive` · 400 `league_required`.
// Ambas exigen `Authorization: Bearer <SYNC_SECRET>`.
import { z } from 'zod'
import { requireSecret } from './_lib/auth.js'
import { handle, noStore, parseBody, parseQuery } from './_lib/http.js'
import { getSyncStatus, runSync } from './_lib/sync.js'

const orgId = z.string().trim().min(1).max(80)

const statusQuery = z.object({ org_id: orgId })

const syncInput = z.object({
  org_id: orgId,
  league_id: z.uuid().optional(),
  dry_run: z.boolean().default(false),
})

export const GET = handle(async (request) => {
  requireSecret(request)
  const { org_id } = parseQuery(request, statusQuery)
  return noStore(await getSyncStatus(org_id))
})

export const POST = handle(async (request) => {
  requireSecret(request)
  const input = await parseBody(request, syncInput)
  return noStore(await runSync({ orgId: input.org_id, leagueId: input.league_id, dryRun: input.dry_run }))
})
