// GET /api/health → { ok: true }. Sin auth: solo confirma que el servicio responde.
import { handle, noStore } from './_lib/http.js'

export const GET = handle(async () => noStore({ ok: true, service: 'courtrack-service' }))
