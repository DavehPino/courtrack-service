// GET  /api/sync?org_id= → SyncStatus: cupo restante, temporadas configuradas (abiertas y archivadas) y últimas ejecuciones.
// POST /api/sync { org_id, league_id?, dry_run? }
//   con league_id → SyncResult de esa temporada · sin league_id → SyncAllResult de todas las activas (un solo cupo).
//   404 `org_not_found` · 429 `quota_exceeded` · 404 `league_not_found` · 409 `league_inactive` | `league_archived`.
// `org_id` es el slug de la organización (organizations.slug). Ambas exigen `Authorization: Bearer <SYNC_SECRET>`: el
// token lo tiene el backend del dashboard, que autentica al usuario en su organización antes de llamar aquí.
import { z } from 'zod'
import { requireSecret } from './_lib/auth.js'
import { handle, noStore, parseBody, parseQuery } from './_lib/http.js'
import { resolveOrg } from './_lib/orgs.js'
import { getSyncStatus, runSync, runSyncAll } from './_lib/sync.js'

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
  return noStore(await getSyncStatus(await resolveOrg(org_id)))
})

export const POST = handle(async (request) => {
  requireSecret(request)
  const input = await parseBody(request, syncInput)
  const org = await resolveOrg(input.org_id)
  if (input.league_id) return noStore(await runSync({ org, leagueId: input.league_id, dryRun: input.dry_run }))
  return noStore(await runSyncAll({ org, dryRun: input.dry_run }))
})
