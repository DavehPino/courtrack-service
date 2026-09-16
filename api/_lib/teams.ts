// Rivales: une los nombres de CourtTrack con la tabla `teams` del dashboard y crea los que falten.
import { db } from './supabase.js'
import { sameName, shortNameFor, slugify, titleCase } from './text.js'

const UNIQUE_VIOLATION = '23505'

export type TeamRef = { id: string; name: string; logo_url: string | null }

type TeamRow = TeamRef & { short_name: string | null; is_own_team: boolean }

type LinkRow = { normalized_name: string; team_id: string }

export type ResolvedRival = {
  team: TeamRef
  /** Nombre crudo en CourtTrack (para vincularlo a otro rival desde la vista previa). */
  courtrack_name: string
  created: boolean
  /** Nombre que tenía en el dashboard antes de que CourtTrack lo pisara (solo la primera vez). */
  renamed_from?: string
}

type ResolverOptions = {
  orgId: string
  /** No escribe: los rivales nuevos se anuncian con un id ficticio y no se crean vínculos. */
  dryRun: boolean
}

const TEAM_SELECT = 'id,name,short_name,logo_url,is_own_team'

async function loadTeams(): Promise<TeamRow[]> {
  const { data, error } = await db().from('teams').select(TEAM_SELECT)
  if (error) throw error
  return data
}

async function loadLinks(orgId: string): Promise<LinkRow[]> {
  const { data, error } = await db().from('courtrack_team_links').select('normalized_name,team_id').eq('org_id', orgId)
  if (error) throw error
  return data
}

/**
 * Resuelve cada rival una sola vez por ejecución: primero por vínculo guardado (courtrack_team_links), después por
 * nombre normalizado ("ONAS" = "Onas" = "onas") y, si no existe, lo crea. En los dos últimos casos guarda el vínculo
 * para la próxima vez. CourtTrack es la fuente de verdad: un rival existente pasa a tener su nombre y su logo (la
 * abreviatura se conserva, CourtTrack no la publica, y solo se genera si está vacía).
 */
export class RivalResolver {
  private constructor(
    private teams: TeamRow[],
    private readonly links: LinkRow[],
    private readonly options: ResolverOptions,
  ) {}

  static async load(options: ResolverOptions): Promise<RivalResolver> {
    const [teams, links] = await Promise.all([loadTeams(), loadLinks(options.orgId)])
    return new RivalResolver(teams, links, options)
  }

  /** Nombres de los rivales creados (o que se crearían) en esta ejecución. */
  readonly created: string[] = []

  private linked(courtrackName: string): TeamRow | undefined {
    const normalized = slugify(courtrackName)
    const link = this.links.find((item) => item.normalized_name === normalized)
    return link ? this.teams.find((team) => team.id === link.team_id && !team.is_own_team) : undefined
  }

  private byName(name: string): TeamRow | undefined {
    return this.teams.find((team) => !team.is_own_team && sameName(team.name, name))
  }

  private async link(courtrackName: string, teamId: string): Promise<void> {
    const normalized = slugify(courtrackName)
    if (this.links.some((item) => item.normalized_name === normalized)) return
    this.links.push({ normalized_name: normalized, team_id: teamId })
    if (this.options.dryRun) return
    const { error } = await db()
      .from('courtrack_team_links')
      .upsert(
        { org_id: this.options.orgId, courtrack_name: courtrackName, normalized_name: normalized, team_id: teamId },
        { onConflict: 'org_id,normalized_name', ignoreDuplicates: true },
      )
    if (error) console.error(error)
  }

  async resolve(courtrackName: string, logo: string | null): Promise<ResolvedRival> {
    const name = titleCase(courtrackName)

    const linked = this.linked(courtrackName)
    if (linked) return this.overwrite(linked, courtrackName, name, logo)

    const existing = this.byName(courtrackName)
    if (existing) {
      await this.link(courtrackName, existing.id)
      return this.overwrite(existing, courtrackName, name, logo)
    }

    this.created.push(name)
    if (this.options.dryRun) {
      const team: TeamRow = {
        id: `dry-run:${this.created.length}`,
        name,
        short_name: shortNameFor(name),
        logo_url: logo,
        is_own_team: false,
      }
      this.teams.push(team)
      return { team, courtrack_name: courtrackName, created: true }
    }

    const { data, error } = await db()
      .from('teams')
      .insert({ name, short_name: shortNameFor(name), logo_url: logo, is_own_team: false, category: null, city: null })
      .select(TEAM_SELECT)
      .single()
    if (error?.code === UNIQUE_VIOLATION) {
      // Lo creó otra ejecución (o existe con otra grafía que el índice único considera igual): se relee.
      this.teams = await loadTeams()
      const found = this.byName(courtrackName) ?? this.byName(name)
      if (found) {
        this.created.pop()
        await this.link(courtrackName, found.id)
        return { team: found, courtrack_name: courtrackName, created: false }
      }
    }
    if (error) throw error
    this.teams.push(data)
    await this.link(courtrackName, data.id)
    return { team: data, courtrack_name: courtrackName, created: true }
  }

  /** Pisa nombre y logo con los de CourtTrack. Si el nombre nuevo choca con otro equipo, se conserva el anterior. */
  private async overwrite(team: TeamRow, courtrackName: string, name: string, logo: string | null): Promise<ResolvedRival> {
    const base: ResolvedRival = { team, courtrack_name: courtrackName, created: false }
    const changes: { name?: string; short_name?: string; logo_url?: string } = {}
    if (team.name !== name) changes.name = name
    if (!team.short_name) changes.short_name = shortNameFor(name) ?? undefined
    if (logo && team.logo_url !== logo) changes.logo_url = logo
    if (Object.keys(changes).length === 0) return base

    const renamedFrom = changes.name ? team.name : undefined
    if (!this.options.dryRun) {
      const { error } = await db().from('teams').update(changes).eq('id', team.id)
      if (error?.code === UNIQUE_VIOLATION && changes.name) {
        console.error(`No se renombró "${team.name}" a "${name}": ya existe otro equipo con ese nombre`)
        delete changes.name
        const { error: retryError } = await db().from('teams').update(changes).eq('id', team.id)
        if (retryError) console.error(retryError)
        else Object.assign(team, changes)
        return base
      }
      if (error) throw error
    }
    Object.assign(team, changes)
    return renamedFrom ? { ...base, renamed_from: renamedFrom } : base
  }
}
