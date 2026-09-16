// Acceso al servicio: un token compartido con quien lo llama (el backend del dashboard o la CLI).
// No es un sistema de usuarios: el token nunca llega al navegador.
import { createHash, timingSafeEqual } from 'node:crypto'
import { env } from './env.js'
import { HttpError, unauthorized } from './http.js'

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()

/** Lanza 503 si no hay SYNC_SECRET configurado y 401 si la cabecera no lo trae (comparación en tiempo constante). */
export function requireSecret(request: Request): void {
  const expected = env.syncSecret
  if (!expected) {
    throw new HttpError(503, 'sync_disabled', 'El servicio no está configurado en el servidor (falta SYNC_SECRET).')
  }
  const header = request.headers.get('authorization') ?? ''
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  if (given && timingSafeEqual(digest(given), digest(expected))) return
  throw unauthorized('Token inválido')
}
