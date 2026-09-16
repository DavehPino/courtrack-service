// CLI: `npm run sync:dry` (vista previa) · `npm run sync` (escribe) · `npm run sync -- --force` (ignora el cupo).
// Usa las variables de `.env` (node --env-file) y la misma lógica que /api/sync.
import { HttpError } from '../api/_lib/http.js'
import { runSync } from '../api/_lib/sync.js'
import type { SyncMatchReport, SyncResult } from '../api/_lib/types.js'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const force = args.has('--force')
const asJson = args.has('--json')

const ACTION_LABELS: Record<SyncMatchReport['action'], string> = {
  created: 'nuevo',
  updated: 'actualizado',
  adopted: 'vinculado a un partido manual',
  unchanged: 'sin cambios',
  skipped: 'omitido',
}

function print(result: SyncResult): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`${dryRun ? '[vista previa] ' : ''}${result.league.name} (liga ${result.league.id})`)
  console.log(`Partidos en la liga: ${result.scanned} · propios: ${result.own}`)
  for (const match of result.matches) {
    const score = match.status === 'played' ? `${match.home_sets ?? '–'}-${match.away_sets ?? '–'}` : 'vs'
    const detail = match.reason ? ` (${match.reason})` : match.slug ? ` → ${match.slug}` : ''
    const rival = match.opponent?.created
      ? ' · rival nuevo'
      : match.opponent?.renamed_from
        ? ` · rival renombrado: ${match.opponent.renamed_from} → ${match.opponent.name}`
        : ''
    console.log(`  ${match.played_on}  ${match.home} ${score} ${match.away}  [${ACTION_LABELS[match.action]}]${detail}${rival}`)
  }
  console.log(
    `Resumen: ${result.created} nuevos, ${result.updated} actualizados, ${result.adopted} vinculados, ` +
      `${result.unchanged} sin cambios, ${result.skipped} omitidos`,
  )
  if (result.rivals_created.length > 0) console.log(`Rivales ${dryRun ? 'a crear' : 'creados'}: ${result.rivals_created.join(', ')}`)
  console.log(`Cupo: ${result.quota.used}/${result.quota.limit} usados en 24 h (quedan ${result.quota.remaining})`)
}

runSync({ dryRun, skipQuota: force })
  .then(print)
  .catch((err: unknown) => {
    if (err instanceof HttpError) console.error(`✖ ${err.code}: ${err.message}`)
    else console.error('✖', err)
    process.exit(1)
  })
