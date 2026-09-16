// Rivales: une los nombres de CourtTrack con la tabla `teams` del dashboard y crea los que falten.
import { db } from './supabase.js'
import { sameName, shortNameFor, titleCase } from './text.js'

const UNIQUE_VIOLATION = '23505'

export type TeamRef = { id: string; name: string; logo_url: string | null }

type TeamRow = TeamRef & { short_name: string | null; is_own_team: boolean }

export type ResolvedRival = {
  team: TeamRef
  created: boolean
  /** Nombre que tenía en el dashboard antes de que CourtTrack lo pisara (solo la primera vez). */
  renamed_from?: string
}

type ResolverOptions = {
  /** Nombre en CourtTrack → nombre en el dashboard (COURTRACK_TEAM_ALIASES). */
  aliases: Record<string, string>
  /** No escribe: los rivales nuevos se anuncian con un id ficticio. */
  dryRun: boolean
}

const TEAM_SELECT = 'id,name,short_name,logo_url,is_own_team'

async function loadTeams(): Promise<TeamRow[]> {
  const { data, error } = await db().from('teams').select(TEAM_SELECT)
  if (error) throw error
  return data
}

/**
 * Resuelve cada rival una sola vez por ejecución: primero por alias, después por nombre normalizado
 * ("ONAS" = "Onas" = "onas") y, si no existe, lo crea con el nombre en mayúscula inicial y el logo de CourtTrack.
 * CourtTrack es la fuente de verdad: un rival existente pasa a tener su nombre y su logo (la abreviatura se conserva,
 * CourtTrack no la publica, y solo se genera si está vacía).
 */
export class RivalResolver {
  private constructor(
    private teams: TeamRow[],
    private readonly options: ResolverOptions,
  ) {}

  static async load(options: ResolverOptions): Promise<RivalResolver> {
    return new RivalResolver(await loadTeams(), options)
  }

  /** Nombres de los rivales creados (o que se crearían) en esta ejecución. */
  readonly created: string[] = []

  private aliasFor(courtrackName: string): string | null {
    for (const [key, value] of Object.entries(this.options.aliases)) {
      if (sameName(key, courtrackName)) return value
    }
    return null
  }

  private find(courtrackName: string, alias: string | null): TeamRow | undefined {
    return this.teams.find(
      (team) => !team.is_own_team && ((alias !== null && sameName(team.name, alias)) || sameName(team.name, courtrackName)),
    )
  }

  async resolve(courtrackName: string, logo: string | null): Promise<ResolvedRival> {
    const alias = this.aliasFor(courtrackName)
    const existing = this.find(courtrackName, alias)
    const name = titleCase(courtrackName)
    if (existing) return this.overwrite(existing, name, logo)

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
      return { team, created: true }
    }

    const { data, error } = await db()
      .from('teams')
      .insert({ name, short_name: shortNameFor(name), logo_url: logo, is_own_team: false, category: null, city: null })
      .select(TEAM_SELECT)
      .single()
    if (error?.code === UNIQUE_VIOLATION) {
      // Lo creó otra ejecución (o existe con otra grafía que el índice único considera igual): se relee.
      this.teams = await loadTeams()
      const found = this.find(courtrackName, alias) ?? this.find(name, null)
      if (found) {
        this.created.pop()
        return { team: found, created: false }
      }
    }
    if (error) throw error
    this.teams.push(data)
    return { team: data, created: true }
  }

  /** Pisa nombre y logo con los de CourtTrack. Si el nombre nuevo choca con otro equipo, se conserva el anterior. */
  private async overwrite(team: TeamRow, name: string, logo: string | null): Promise<ResolvedRival> {
    const changes: { name?: string; short_name?: string; logo_url?: string } = {}
    if (team.name !== name) changes.name = name
    if (!team.short_name) changes.short_name = shortNameFor(name) ?? undefined
    if (logo && team.logo_url !== logo) changes.logo_url = logo
    if (Object.keys(changes).length === 0) return { team, created: false }

    const renamedFrom = changes.name ? team.name : undefined
    if (!this.options.dryRun) {
      const { error } = await db().from('teams').update(changes).eq('id', team.id)
      if (error?.code === UNIQUE_VIOLATION && changes.name) {
        console.error(`No se renombró "${team.name}" a "${name}": ya existe otro equipo con ese nombre`)
        delete changes.name
        const { error: retryError } = await db().from('teams').update(changes).eq('id', team.id)
        if (retryError) console.error(retryError)
        else Object.assign(team, changes)
        return { team, created: false }
      }
      if (error) throw error
    }
    Object.assign(team, changes)
    return { team, created: false, ...(renamedFrom ? { renamed_from: renamedFrom } : {}) }
  }
}
