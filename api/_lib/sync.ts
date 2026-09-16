// Orquestador: ligas → cupo → CourtTrack → detección de reseteo → partidos propios jugados → rivales → `matches` →
// instantánea → registro. Un sync puede ser de una liga o de todas las activas (un solo cupo).
import {
  findPartidos,
  getLiga,
  getPosiciones,
  partidoSets,
  teamsFromPartidos,
  type Liga,
  type Partido,
  type Side,
} from './courtrack.js'
import type { Json } from './database.types.js'
import { env } from './env.js'
import { HttpError } from './http.js'
import {
  archiveLeague,
  getLeague,
  listActiveLeagues,
  listLeagues,
  openNextSeason,
  saveSnapshot,
  storedCourtrackIds,
  touchLeague,
  type League,
} from './leagues.js'
import { findByCourtrackIds, findManualMatch, insertMatch, isUnchanged, updateMatch, type MatchRow, type MatchValues } from './matches.js'
import { beginSync, finishSync, getQuota, lastSyncs } from './syncLog.js'
import { RivalResolver } from './teams.js'
import { addDays, horarioToTime, matchSlugBase, sameName, tallySets, titleCase, todayIsoDate } from './text.js'
import type { SeasonEvent, SyncAllResult, SyncLogEntry, SyncMatchReport, SyncResult, SyncStatus, SyncSummary } from './types.js'

export type SyncOptions = {
  orgId: string
  /** Liga (courtrack_leagues.id). Sin ella se recorren todas las activas de la organización. */
  leagueId?: string
  /** Calcula y devuelve qué haría sin escribir nada (ni partidos, ni rivales, ni vínculos, ni sync_log). */
  dryRun: boolean
  /** Solo CLI: ignora el límite diario (el intento se registra igual). */
  skipQuota?: boolean
}

const LAST_SYNCS = 30

type LeagueResult = Omit<SyncResult, 'quota'>

type Context = { league: League; resolver: RivalResolver; existing: Map<string, MatchRow>; dryRun: boolean; today: string }

const cleanText = (value: string | null | undefined) => value?.trim() || null

function ownSide(partido: Partido, ownTeam: string): Side | null {
  if (sameName(partido.id_equipo_a, ownTeam)) return 'a'
  if (sameName(partido.id_equipo_b, ownTeam)) return 'b'
  return null
}

async function importPartido(partido: Partido, ours: Side, ctx: Context): Promise<SyncMatchReport> {
  const report: SyncMatchReport = {
    courtrack_id: String(partido.id),
    played_on: partido.fecha.slice(0, 10),
    start_time: horarioToTime(partido.horario),
    home: titleCase(partido.id_equipo_a),
    away: titleCase(partido.id_equipo_b),
    home_sets: partido.sets_a ?? null,
    away_sets: partido.sets_b ?? null,
    status: partido.status,
    action: 'skipped',
  }
  const skip = (reason: string): SyncMatchReport => ({ ...report, action: 'skipped', reason })

  if (partido.status !== 'played') return skip('Todavía no se jugó')
  // Tolerancia de un día: el reloj del servidor puede ir por detrás de la hora local del equipo.
  if (report.played_on > addDays(ctx.today, 1)) return skip('La fecha está en el futuro')

  const sets = partidoSets(partido, ours)
  if (sets.length === 0) return skip('Sin parciales cargados')

  const tally = tallySets(sets)
  const setsWon = (ours === 'a' ? partido.sets_a : partido.sets_b) ?? tally.won
  const setsLost = (ours === 'a' ? partido.sets_b : partido.sets_a) ?? tally.lost

  const rivalName = ours === 'a' ? partido.id_equipo_b : partido.id_equipo_a
  const rivalLogo = cleanText(ours === 'a' ? partido.logo_b : partido.logo_a)
  const rival = await ctx.resolver.resolve(rivalName, rivalLogo)
  report.opponent = {
    name: rival.team.name,
    courtrack_name: rival.courtrack_name,
    created: rival.created,
    ...(rival.renamed_from ? { renamed_from: rival.renamed_from } : {}),
  }

  const values: MatchValues = {
    courtrack_id: report.courtrack_id,
    courtrack_league_id: ctx.league.id,
    competition_id: ctx.league.competition.id,
    played_on: report.played_on,
    start_time: report.start_time,
    opponent_team_id: rival.team.id,
    is_home: ours === 'a',
    location: partido.id_cancha ? titleCase(partido.id_cancha) : null,
    phase: cleanText(partido.etapa_formatted),
    sets_won: setsWon,
    sets_lost: setsLost,
    set_scores: sets,
  }

  // Un rival recién creado no puede tener partidos manuales.
  const existing =
    ctx.existing.get(report.courtrack_id) ??
    (rival.created ? null : await findManualMatch(values.played_on, values.opponent_team_id, values.competition_id))

  if (existing) {
    report.slug = existing.slug
    report.action = existing.courtrack_id === null ? 'adopted' : isUnchanged(existing, values) ? 'unchanged' : 'updated'
    if (report.action !== 'unchanged' && !ctx.dryRun) await updateMatch(existing.id, values)
    return report
  }

  report.action = 'created'
  report.slug = ctx.dryRun ? matchSlugBase(values.played_on, rival.team.name) : (await insertMatch(values, rival.team.name)).slug
  return report
}

function summarize(scanned: number, matches: SyncMatchReport[], rivalsCreated: string[]): SyncSummary {
  const count = (action: SyncMatchReport['action']) => matches.filter((match) => match.action === action).length
  return {
    scanned,
    own: matches.length,
    created: count('created'),
    updated: count('updated'),
    adopted: count('adopted'),
    unchanged: count('unchanged'),
    skipped: count('skipped'),
    rivals_created: rivalsCreated,
  }
}

const EMPTY: SyncSummary = { scanned: 0, own: 0, created: 0, updated: 0, adopted: 0, unchanged: 0, skipped: 0, rivals_created: [] }

function leagueRef(league: League): LeagueResult['league'] {
  return {
    id: league.id,
    courtrack_id: league.liga_id,
    name: league.liga_name,
    season_label: league.season_label,
    competition: { id: league.competition.id, name: league.competition.name },
  }
}

/**
 * CourtTrack resetea la liga al terminar: si guardamos partidos de esta temporada y ninguno sigue publicado,
 * la temporada terminó. Se archiva (con su instantánea) y, si la liga sigue existiendo, se abre la siguiente.
 */
async function detectReset(league: League, partidos: Partido[]): Promise<boolean> {
  const stored = await storedCourtrackIds(league.id)
  if (stored.size === 0) return false
  return !partidos.some((partido) => stored.has(String(partido.id)))
}

/** Sincroniza una temporada. `resolver` se comparte entre ligas para no resolver el mismo rival dos veces. */
async function syncLeague(initial: League, dryRun: boolean, resolver: RivalResolver): Promise<LeagueResult> {
  let league = initial
  let seasonEvent: SeasonEvent | undefined

  // Torneos y etapas se resuelven en cada sync: CourtTrack añade etapas (playoffs) a mitad de temporada.
  let liga: Liga
  try {
    liga = await getLiga(league.id_cliente, league.liga_id)
  } catch (err) {
    if (!(err instanceof HttpError && err.code === 'courtrack_liga_not_found')) throw err
    if (!dryRun) await archiveLeague(league.id, 'removed')
    return {
      ...EMPTY,
      dry_run: dryRun,
      league: leagueRef(league),
      season_event: { kind: 'removed', archived_season: league.season_label },
      matches: [],
    }
  }

  const partidos = await findPartidos(liga)

  if (await detectReset(league, partidos)) {
    seasonEvent = { kind: 'reset', archived_season: league.season_label, new_season: liga.nombre, new_league_id: null }
    if (!dryRun) {
      await archiveLeague(league.id, 'reset')
      league = await openNextSeason(league, liga.nombre)
      seasonEvent.new_league_id = league.id
    }
  }

  const own = partidos
    .map((partido) => ({ partido, side: ownSide(partido, league.team_name) }))
    .filter((item): item is { partido: Partido; side: Side } => item.side !== null)
    .sort((x, y) => x.partido.fecha.localeCompare(y.partido.fecha) || x.partido.id - y.partido.id)

  const ctx: Context = {
    league,
    resolver,
    // Tras un reseteo simulado (dry run) los partidos viejos no cuentan: en la temporada nueva serían altas.
    existing: seasonEvent && dryRun ? new Map() : await findByCourtrackIds(own.map(({ partido }) => String(partido.id))),
    dryRun,
    today: todayIsoDate(),
  }

  const matches: SyncMatchReport[] = []
  for (const { partido, side } of own) matches.push(await importPartido(partido, side, ctx))
  const summary = summarize(partidos.length, matches, resolver.created)

  if (!dryRun) {
    const ownLogo = teamsFromPartidos(partidos).find((team) => sameName(team.name, league.team_name))?.logo ?? null
    await touchLeague(league.id, ownLogo)
    // La clasificación es lo único que no se puede reconstruir desde nuestros partidos: se guarda tal cual.
    const standings = await getPosiciones(liga).catch((err: unknown) => {
      console.warn('CourtTrack: no se pudo leer la clasificación', err)
      return null
    })
    await saveSnapshot(league.id, {
      liga_name: liga.nombre,
      standings: standings as Json | null,
      fixture: partidos as unknown as Json,
    })
  }

  return {
    ...summary,
    dry_run: dryRun,
    league: leagueRef(league),
    ...(seasonEvent ? { season_event: seasonEvent } : {}),
    matches,
  }
}

/** Registra el intento, comprueba el cupo, ejecuta y cierra el registro con el resumen. */
async function withQuota<T>(
  orgId: string,
  leagueId: string | null,
  { dryRun, skipQuota }: { dryRun: boolean; skipQuota: boolean },
  run: () => Promise<{ value: T; summary: SyncSummary; leagues?: Record<string, SyncSummary> }>,
): Promise<T> {
  const limit = env.dailyLimit
  let logId: string | null = null
  if (!dryRun) {
    logId = await beginSync(orgId, leagueId)
    if (!skipQuota) {
      // La cuenta incluye este intento (ya está en `running`): con el cupo agotado supera el límite.
      const quota = await getQuota(orgId, limit)
      if (quota.used > limit) {
        await finishSync(logId, 'rejected', null, 'Cupo diario agotado')
        const current = await getQuota(orgId, limit)
        throw new HttpError(429, 'quota_exceeded', `Ya se hicieron ${limit} sincronizaciones en las últimas 24 horas.`, {
          quota: current,
        })
      }
    }
  }
  try {
    const { value, summary, leagues } = await run()
    if (logId) await finishSync(logId, 'success', leagues ? { ...summary, leagues } : summary)
    return value
  } catch (err) {
    if (logId) {
      const message = err instanceof Error ? err.message : String(err)
      await finishSync(logId, 'error', null, message).catch((logError: unknown) => console.error(logError))
    }
    throw err
  }
}

function addSummaries(items: SyncSummary[]): SyncSummary {
  return items.reduce<SyncSummary>(
    (total, item) => ({
      scanned: total.scanned + item.scanned,
      own: total.own + item.own,
      created: total.created + item.created,
      updated: total.updated + item.updated,
      adopted: total.adopted + item.adopted,
      unchanged: total.unchanged + item.unchanged,
      skipped: total.skipped + item.skipped,
      rivals_created: [...new Set([...total.rivals_created, ...item.rivals_created])],
    }),
    EMPTY,
  )
}

const pickSummary = (result: LeagueResult): SyncSummary => ({
  scanned: result.scanned,
  own: result.own,
  created: result.created,
  updated: result.updated,
  adopted: result.adopted,
  unchanged: result.unchanged,
  skipped: result.skipped,
  rivals_created: result.rivals_created,
})

/** Sincroniza UNA temporada (404 si no es de la org, 409 si está pausada o archivada). */
export async function runSync({ orgId, leagueId, dryRun, skipQuota = false }: SyncOptions & { leagueId: string }): Promise<SyncResult> {
  const league = await getLeague(orgId, leagueId)
  if (league.archived_at) throw new HttpError(409, 'league_archived', `La temporada "${league.season_label}" ya está archivada`)
  if (!league.is_active) throw new HttpError(409, 'league_inactive', `La liga "${league.liga_name}" está pausada`)

  const result = await withQuota(orgId, league.id, { dryRun, skipQuota }, async () => {
    const value = await syncLeague(league, dryRun, await RivalResolver.load({ orgId, dryRun }))
    return { value, summary: pickSummary(value) }
  })
  return { ...result, quota: await getQuota(orgId, env.dailyLimit) }
}

/** Sincroniza TODAS las temporadas activas de la organización con un solo cupo. */
export async function runSyncAll({ orgId, dryRun, skipQuota = false }: Omit<SyncOptions, 'leagueId'>): Promise<SyncAllResult> {
  const leagues = await listActiveLeagues(orgId)
  if (leagues.length === 0) throw new HttpError(404, 'league_not_found', 'La organización no tiene ligas activas')

  const results = await withQuota(orgId, null, { dryRun, skipQuota }, async () => {
    const resolver = await RivalResolver.load({ orgId, dryRun })
    const value: LeagueResult[] = []
    for (const league of leagues) value.push(await syncLeague(league, dryRun, resolver))
    const perLeague = Object.fromEntries(value.map((item) => [item.league.id, pickSummary(item)]))
    return { value, summary: addSummaries(value.map(pickSummary)), leagues: perLeague }
  })

  return {
    dry_run: dryRun,
    leagues: results,
    totals: addSummaries(results.map(pickSummary)),
    quota: await getQuota(orgId, env.dailyLimit),
  }
}

/** Cupo restante, temporadas (abiertas y archivadas, con su último sync) y últimas ejecuciones de la organización. */
export async function getSyncStatus(orgId: string): Promise<SyncStatus> {
  const [quota, leagues, last] = await Promise.all([
    getQuota(orgId, env.dailyLimit),
    listLeagues(orgId),
    lastSyncs(orgId, LAST_SYNCS),
  ])
  const lastByLeague = new Map<string, SyncLogEntry>()
  for (const entry of last) {
    const ids = entry.league_id ? [entry.league_id] : Object.keys(entry.leagues ?? {})
    for (const id of ids) if (!lastByLeague.has(id)) lastByLeague.set(id, entry)
  }
  return {
    org_id: orgId,
    quota,
    leagues: leagues.map(({ org_id: _org, ...league }) => ({ ...league, last_sync: lastByLeague.get(league.id) ?? null })),
    last_syncs: last,
  }
}
