// Rivales: une los nombres de CourtTrack con la tabla `teams` del dashboard y crea los que falten.
import { db } from './supabase.js'
import { sameName, shortNameFor, titleCase } from './text.js'

const UNIQUE_VIOLATION = '23505'

export type TeamRef = { id: string; name: string; logo_url: string | null }

type TeamRow = TeamRef & { is_own_team: boolean }

export type ResolvedRival = { team: TeamRef; created: boolean }

type ResolverOptions = {
  /** Nombre en CourtTrack → nombre en el dashboard (COURTRACK_TEAM_ALIASES). */
  aliases: Record<string, string>
  /** No escribe: los rivales nuevos se anuncian con un id ficticio. */
  dryRun: boolean
}

async function loadTeams(): Promise<TeamRow[]> {
  const { data, error } = await db().from('teams').select('id,name,logo_url,is_own_team')
  if (error) throw error
  return data
}

/**
 * Resuelve cada rival una sola vez por ejecución: primero por alias, después por nombre normalizado
 * ("ONAS" = "Onas" = "onas") y, si no existe, lo crea con el nombre en mayúscula inicial y el logo de CourtTrack.
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
    if (existing) {
      // Un rival cargado a mano sin escudo hereda el de CourtTrack.
      if (!existing.logo_url && logo && !this.options.dryRun) {
        const { error } = await db().from('teams').update({ logo_url: logo }).eq('id', existing.id)
        if (error) console.error(error)
        else existing.logo_url = logo
      }
      return { team: existing, created: false }
    }

    const name = alias ?? titleCase(courtrackName)
    this.created.push(name)
    if (this.options.dryRun) {
      const team: TeamRow = { id: `dry-run:${this.created.length}`, name, logo_url: logo, is_own_team: false }
      this.teams.push(team)
      return { team, created: true }
    }

    const { data, error } = await db()
      .from('teams')
      .insert({ name, short_name: shortNameFor(name), logo_url: logo, is_own_team: false, category: null, city: null })
      .select('id,name,logo_url,is_own_team')
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
}
