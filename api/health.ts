// GET /api/health → { ok: true, version }. Sin auth: solo confirma que el servicio responde y qué versión corre.
import { handle, noStore } from './_lib/http.js'

/** Se sube a mano en cada cambio de contrato (coincide con package.json). */
export const VERSION = '0.3.0'

export const GET = handle(async () => noStore({ ok: true, service: 'courtrack-service', version: VERSION }))
