// Variables de entorno del servidor. Se leen en diferido para que un fallo de
// configuración devuelva un 500 claro en vez de romper el arranque de la función.

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Falta la variable de entorno ${name}`)
  return value
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined
}

function integer(name: string, fallback: number): number {
  const raw = optional(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} debe ser un entero positivo (recibido "${raw}")`)
  return value
}

/** `COURTRACK_TEAM_ALIASES={"ONAS":"Onas Vóley"}`: nombre en CourtTrack → nombre del rival en el dashboard. */
function aliases(name: string): Record<string, string> {
  const raw = optional(name)
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${name} debe ser un objeto JSON válido`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name} debe ser un objeto JSON`)
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`${name}: el alias de "${key}" debe ser un texto`)
    result[key] = value
  }
  return result
}

export const env = {
  get supabaseUrl() {
    return required('SUPABASE_URL')
  },
  get supabaseSecretKey() {
    return required('SUPABASE_SECRET_KEY')
  },
  /** Token que exige /api/sync. Sin él, el servicio queda cerrado (503). */
  get syncSecret() {
    return optional('SYNC_SECRET')
  },
  get sync() {
    return {
      orgId: optional('SYNC_ORG_ID') ?? 'coyotes',
      dailyLimit: integer('SYNC_DAILY_LIMIT', 3),
    }
  },
  get courtrack() {
    return {
      baseUrl: (optional('COURTRACK_BASE_URL') ?? 'https://api.courtrack.com').replace(/\/+$/, ''),
      idCliente: integer('COURTRACK_ID_CLIENTE', 5),
      ligaId: integer('COURTRACK_LIGA_ID', 605),
      team: optional('COURTRACK_TEAM') ?? 'COYOTES',
      competition: optional('COURTRACK_COMPETITION') ?? 'Liga Podio',
      aliases: aliases('COURTRACK_TEAM_ALIASES'),
    }
  },
}
