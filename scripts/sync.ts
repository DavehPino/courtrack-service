// CLI con la misma lógica que /api/sync. Usa las variables de `.env` (node --env-file).
//   npm run sync -- --list                       temporadas configuradas de la organización
//   npm run sync:dry                             vista previa de TODAS las ligas activas (no escribe ni gasta cupo)
//   npm run sync                                 sincroniza todas las activas (un cupo)
//   npm run sync -- --league <uuid>              solo esa temporada
//   --org <id> (default coyotes) · --force (ignora el cupo) · --json (salida completa)
import { HttpError } from '../api/_lib/http.js'
import { getSyncStatus, runSync, runSyncAll } from '../api/_lib/sync.js'
import type { SyncMatchReport, SyncResult } from '../api/_lib/types.js'

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(name)
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const orgId = option('--org') ?? 'coyotes'
const leagueId = option('--league')
const dryRun = flag('--dry-run')
const force = flag('--force')
const asJson = flag('--json')

const ACTION_LABELS: Record<SyncMatchReport['action'], string> = {
  created: 'nuevo',
  updated: 'actualizado',
  adopted: 'vinculado a un partido manual',
  unchanged: 'sin cambios',
  skipped: 'omitido',
}

function printLeague(result: Omit<SyncResult, 'quota'>): void {
  console.log(`${dryRun ? '[vista previa] ' : ''}${result.league.name} → ${result.league.competition.name} (temporada ${result.league.id})`)
  if (result.season_event) {
    const event = result.season_event
    console.log(
      event.kind === 'removed'
        ? `  ⚠ La liga ya no existe en CourtTrack: temporada "${event.archived_season}" archivada`
        : `  ⚠ CourtTrack reinició la liga: "${event.archived_season}" archivada, nueva temporada "${event.new_season}"` +
            (event.new_league_id ? ` (${event.new_league_id})` : ' (simulado)'),
    )
  }
  console.log(`  Partidos en la liga: ${result.scanned} · propios: ${result.own}`)
  for (const match of result.matches) {
    const score = match.status === 'played' ? `${match.home_sets ?? '–'}-${match.away_sets ?? '–'}` : 'vs'
    const detail = match.reason ? ` (${match.reason})` : match.slug ? ` → ${match.slug}` : ''
    const rival = match.opponent?.created
      ? ' · rival nuevo'
      : match.opponent?.renamed_from
        ? ` · rival renombrado: ${match.opponent.renamed_from} → ${match.opponent.name}`
        : ''
    console.log(`    ${match.played_on}  ${match.home} ${score} ${match.away}  [${ACTION_LABELS[match.action]}]${detail}${rival}`)
  }
  console.log(
    `  Resumen: ${result.created} nuevos, ${result.updated} actualizados, ${result.adopted} vinculados, ` +
      `${result.unchanged} sin cambios, ${result.skipped} omitidos`,
  )
  if (result.rivals_created.length > 0) console.log(`  Rivales ${dryRun ? 'a crear' : 'creados'}: ${result.rivals_created.join(', ')}`)
}

async function list(): Promise<void> {
  const status = await getSyncStatus(orgId)
  if (asJson) {
    console.log(JSON.stringify(status, null, 2))
    return
  }
  console.log(`Organización ${status.org_id} · cupo ${status.quota.used}/${status.quota.limit} en 24 h`)
  if (status.leagues.length === 0) console.log('  (sin ligas configuradas: se crean desde el dashboard)')
  for (const league of status.leagues) {
    const state = league.archived_at ? `archivada (${league.archive_reason})` : league.is_active ? 'activa' : 'pausada'
    const last = league.last_sync
      ? `último sync ${league.last_sync.started_at.slice(0, 16).replace('T', ' ')} (${league.last_sync.status})`
      : 'nunca sincronizada'
    console.log(
      `  ${league.id}  ${state.padEnd(18)}  ${league.season_label} [${league.cliente_name ?? league.id_cliente}]` +
        ` → ${league.competition.name} · equipo ${league.team_name} · ${last}`,
    )
  }
}

async function main(): Promise<void> {
  if (flag('--list')) return list()
  if (leagueId) {
    const result = await runSync({ orgId, leagueId, dryRun, skipQuota: force })
    if (asJson) console.log(JSON.stringify(result, null, 2))
    else {
      printLeague(result)
      console.log(`Cupo: ${result.quota.used}/${result.quota.limit} usados en 24 h (quedan ${result.quota.remaining})`)
    }
    return
  }
  const result = await runSyncAll({ orgId, dryRun, skipQuota: force })
  if (asJson) console.log(JSON.stringify(result, null, 2))
  else {
    for (const league of result.leagues) printLeague(league)
    const t = result.totals
    console.log(
      `Total (${result.leagues.length} ligas): ${t.created} nuevos, ${t.updated} actualizados, ${t.adopted} vinculados, ` +
        `${t.unchanged} sin cambios, ${t.skipped} omitidos`,
    )
    console.log(`Cupo: ${result.quota.used}/${result.quota.limit} usados en 24 h (quedan ${result.quota.remaining})`)
  }
}

main().catch((err: unknown) => {
  if (err instanceof HttpError) console.error(`✖ ${err.code}: ${err.message}`)
  else console.error('✖', err)
  process.exit(1)
})
