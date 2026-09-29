// Variables de entorno del servidor. Se leen en diferido para que un fallo de
// configuración devuelva un 500 claro en vez de romper el arranque de la función.
// La configuración de cada liga (asociación, liga, equipo propio) ya no vive aquí:
// está en la tabla courtrack_leagues de cada organización.

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

export const env = {
  get supabaseUrl() {
    return required('SUPABASE_URL')
  },
  get supabaseSecretKey() {
    return required('SUPABASE_SECRET_KEY')
  },
  /** Token que exigen /api/sync y /api/courtrack/*. Sin él, el servicio queda cerrado (503). */
  get syncSecret() {
    return optional('SYNC_SECRET')
  },
  /** Syncs reales permitidos por organización en 24 h. */
  get dailyLimit() {
    return integer('SYNC_DAILY_LIMIT', 3)
  },
  /** Secreto que Vercel Cron envía como `Authorization: Bearer`. Sin él, el cron solo acepta SYNC_SECRET. */
  get cronSecret() {
    return optional('CRON_SECRET')
  },
  /** Clave de Resend (https://resend.com) para el aviso por email cuando el contrato falla. Opcional. */
  get resendApiKey() {
    return optional('RESEND_API_KEY')
  },
  /** Destinatario(s) del aviso, separados por coma. */
  get alertEmailTo() {
    return optional('ALERT_EMAIL_TO')
  },
  /** Remitente del aviso. Con `onboarding@resend.dev` (prueba) Resend solo entrega al dueño de la cuenta. */
  get alertEmailFrom() {
    return optional('ALERT_EMAIL_FROM') ?? 'CourtTrack Service <onboarding@resend.dev>'
  },
  get courtrackBaseUrl() {
    return (optional('COURTRACK_BASE_URL') ?? 'https://api.courtrack.com').replace(/\/+$/, '')
  },
}
