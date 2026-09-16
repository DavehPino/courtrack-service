// GET  /api/sync → SyncStatus: cupo restante y últimas sincronizaciones.
// POST /api/sync { dry_run?: boolean } → SyncResult. 429 `quota_exceeded` si se agotó el cupo diario.
// Ambas exigen `Authorization: Bearer <SYNC_SECRET>`.
import { z } from 'zod'
import { requireSecret } from './_lib/auth.js'
import { handle, noStore, parseBody } from './_lib/http.js'
import { getSyncStatus, runSync } from './_lib/sync.js'

const syncInput = z.object({ dry_run: z.boolean().default(false) })

export const GET = handle(async (request) => {
  requireSecret(request)
  return noStore(await getSyncStatus())
})

export const POST = handle(async (request) => {
  requireSecret(request)
  const input = await parseBody(request, syncInput)
  return noStore(await runSync({ dryRun: input.dry_run }))
})
