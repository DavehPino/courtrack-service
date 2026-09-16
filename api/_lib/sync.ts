// Orquestador: liga → cupo → CourtTrack → filtrar partidos propios jugados → rivales → alta/edición en `matches` → registro.
import { findPartidos, getLiga, partidoSets, teamsFromPartidos, type Partido, type Side } from './courtrack.js'
import { env } from './env.js'
import { HttpError } from './http.js'
import { getLeague, listLeagues, resolveDefaultLeague, touchLeague, type League } from './leagues.js'
import { findByCourtrackIds, findManualMatch, insertMatch, isUnchanged, updateMatch, type MatchRow, type MatchValues } from './matches.js'
import { beginSync, finishSync, getQuota, lastSyncs } from './syncLog.js'
import { RivalResolver } from './teams.js'
import { addDays, horarioToTime, matchSlugBase, sameName, tallySets, titleCase, todayIsoDate } from './text.js'
import type { SyncLogEntry, SyncMatchReport, SyncResult, SyncStatus, SyncSummary } from './types.js'

export type SyncOptions = {
  orgId: string
  /** Liga (courtrack_leagues.id). Si falta, la única activa de la organización. */
  leagueId?: string
  /** Calcula y devuelve qué haría sin escribir nada (ni partidos, ni rivales, ni vínculos, ni sync_log). */
  dryRun: boolean
  /** Solo CLI: ignora el límite diario (el intento se registra igual). */
  skipQuota?: boolean
}

const LAST_SYNCS = 20

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

/** El instante en que se libera cupo viaja en `details.quota.resets_at`; quien llama lo formatea en hora local. */
const quotaMessage = (limit: number) => `Ya se hicieron ${limit} sincronizaciones en las últimas 24 horas.`

export async function runSync({ orgId, leagueId, dryRun, skipQuota = false }: SyncOptions): Promise<SyncResult> {
  const limit = env.dailyLimit
  const league = leagueId ? await getLeague(orgId, leagueId) : await resolveDefaultLeague(orgId)
  if (!league.is_active) throw new HttpError(409, 'league_inactive', `La liga "${league.liga_name}" está pausada`)

  let logId: string | null = null
  if (!dryRun) {
    logId = await beginSync(orgId, league.id)
    if (!skipQuota) {
      // La cuenta incluye este intento (ya está en `running`): con el cupo agotado supera el límite.
      const quota = await getQuota(orgId, limit)
      if (quota.used > limit) {
        await finishSync(logId, 'rejected', null, 'Cupo diario agotado')
        const current = await getQuota(orgId, limit)
        throw new HttpError(429, 'quota_exceeded', quotaMessage(limit), { quota: current })
      }
    }
  }

  try {
    // Torneos y etapas se resuelven en cada sync: CourtTrack añade etapas (playoffs) a mitad de temporada.
    const liga = await getLiga(league.id_cliente, league.liga_id)
    const partidos = await findPartidos(liga)

    const own = partidos
      .map((partido) => ({ partido, side: ownSide(partido, league.team_name) }))
      .filter((item): item is { partido: Partido; side: Side } => item.side !== null)
      .sort((x, y) => x.partido.fecha.localeCompare(y.partido.fecha) || x.partido.id - y.partido.id)

    const ctx: Context = {
      league,
      resolver: await RivalResolver.load({ orgId, dryRun }),
      existing: await findByCourtrackIds(own.map(({ partido }) => String(partido.id))),
      dryRun,
      today: todayIsoDate(),
    }

    const matches: SyncMatchReport[] = []
    for (const { partido, side } of own) matches.push(await importPartido(partido, side, ctx))

    const summary = summarize(partidos.length, matches, ctx.resolver.created)
    if (logId) {
      await finishSync(logId, 'success', summary)
      // El escudo propio tal como lo publica CourtTrack en esta liga (lo muestra el gestor de ligas del dashboard).
      const ownLogo = teamsFromPartidos(partidos).find((team) => sameName(team.name, league.team_name))?.logo ?? null
      await touchLeague(league.id, ownLogo)
    }

    return {
      ...summary,
      dry_run: dryRun,
      league: {
        id: league.id,
        courtrack_id: league.liga_id,
        name: league.liga_name,
        competition: { id: league.competition.id, name: league.competition.name },
      },
      matches,
      quota: await getQuota(orgId, limit),
    }
  } catch (err) {
    if (logId) {
      const message = err instanceof Error ? err.message : String(err)
      await finishSync(logId, 'error', null, message).catch((logError: unknown) => console.error(logError))
    }
    throw err
  }
}

/** Cupo restante, ligas configuradas (con su último sync) y últimas ejecuciones de la organización. */
export async function getSyncStatus(orgId: string): Promise<SyncStatus> {
  const [quota, leagues, last] = await Promise.all([
    getQuota(orgId, env.dailyLimit),
    listLeagues(orgId),
    lastSyncs(orgId, LAST_SYNCS),
  ])
  const lastByLeague = new Map<string, SyncLogEntry>()
  for (const entry of last) {
    if (entry.league_id && !lastByLeague.has(entry.league_id)) lastByLeague.set(entry.league_id, entry)
  }
  return {
    org_id: orgId,
    quota,
    leagues: leagues.map(({ org_id: _org, ...league }) => ({ ...league, last_sync: lastByLeague.get(league.id) ?? null })),
    last_syncs: last,
  }
}
