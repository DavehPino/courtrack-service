// Catálogo de CourtTrack para el asistente "Agregar liga" del dashboard. Una sola función para las rutas.
//   GET /api/courtrack/clientes                                  → CourtrackCliente[]
//   GET /api/courtrack/ligas?id_cliente=5                        → CourtrackLiga[]
//   GET /api/courtrack/equipos?id_cliente=5&liga_id=605          → CourtrackEquipo[] (derivados de los partidos)
//   GET /api/courtrack/descubrir?id_cliente=5&team=COYOTES       → CourtrackDiscoveredLiga[] (ligas donde juega el equipo)
// Todas exigen `Authorization: Bearer <SYNC_SECRET>`. Sin caché: las respuestas van con credenciales.
import { z } from 'zod'
import { requireSecret } from '../_lib/auth.js'
import { discoverLeagues, findPartidos, getClientes, getLiga, getLigas, teamsFromPartidos } from '../_lib/courtrack.js'
import { handle, noStore, parseQuery, pathParam, routeFor, type Handler } from '../_lib/http.js'

const id = z.coerce.number().int().positive()

const resources: Record<string, Handler> = {
  clientes: async () => noStore(await getClientes()),

  ligas: async (request) => {
    const { id_cliente } = parseQuery(request, z.object({ id_cliente: id }))
    return noStore(await getLigas(id_cliente))
  },

  equipos: async (request) => {
    const { id_cliente, liga_id } = parseQuery(request, z.object({ id_cliente: id, liga_id: id }))
    const liga = await getLiga(id_cliente, liga_id)
    return noStore(teamsFromPartidos(await findPartidos(liga)))
  },

  descubrir: async (request) => {
    const { id_cliente, team } = parseQuery(request, z.object({ id_cliente: id, team: z.string().trim().min(1).max(120) }))
    return noStore(await discoverLeagues(id_cliente, team))
  },
}

export const GET = handle(async (request) => {
  const resource = routeFor(resources, pathParam(request))
  requireSecret(request)
  return resource(request)
})
