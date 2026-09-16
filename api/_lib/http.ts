// Utilidades HTTP para Vercel Functions con la firma Web estándar (Request → Response).
// Mismo formato de error que el dashboard (`{ error: { code, message, details } }`) para que su proxy lo reenvíe tal cual.
import type { z } from 'zod'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details)
export const unauthorized = (message = 'No autorizado') => new HttpError(401, 'unauthorized', message)

export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } }

const NO_STORE = { 'Cache-Control': 'no-store' }

export function noStore<T>(data: T, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE })
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    const body: ApiErrorBody = { error: { code: err.code, message: err.message, details: err.details } }
    return Response.json(body, { status: err.status, headers: NO_STORE })
  }
  console.error(err)
  const message = err instanceof Error ? err.message : 'Error interno del servidor'
  const body: ApiErrorBody = { error: { code: 'internal_error', message } }
  return Response.json(body, { status: 500, headers: NO_STORE })
}

export type Handler = (request: Request) => Promise<Response>

/** Envuelve un handler para convertir cualquier excepción en una respuesta JSON coherente. */
export function handle(handler: Handler): Handler {
  return async (request) => {
    try {
      return await handler(request)
    } catch (err) {
      return errorResponse(err)
    }
  }
}

/** Cuerpo JSON validado con Zod. Un cuerpo vacío equivale a `{}`. */
export async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const text = await request.text()
  let raw: unknown = {}
  if (text.trim()) {
    try {
      raw = JSON.parse(text)
    } catch {
      throw badRequest('El cuerpo debe ser JSON válido')
    }
  }
  const result = schema.safeParse(raw)
  if (!result.success) throw badRequest('Datos inválidos', result.error.issues)
  return result.data
}
