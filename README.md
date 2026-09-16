# courtrack-service

Microservicio que trae los **resultados de las ligas de CourtTrack** (la app de PODIO y otras asociaciones) a la base
de datos del dashboard. Es un proyecto aparte de [`coyotes-website`](https://github.com/DavehPino/coyotes-website)
(otro deploy en Vercel) que escribe en la **misma instancia de Supabase**.

- **Multi-liga:** cada organización (`org_id`; hoy solo `coyotes`) configura desde el dashboard las ligas de CourtTrack
  en las que juega (tabla `courtrack_leagues`), cada una colgada de una competición del dashboard (`competitions`).
  El dashboard puede **descubrirlas** (`/api/courtrack/descubrir`): ligas de una asociación donde aparece el equipo.
- **Temporadas e histórico:** CourtTrack resetea las ligas al terminar. Cada fila de `courtrack_leagues` es una
  temporada; cuando el sync detecta el reseteo la archiva y abre la siguiente, y en cada sync guarda una instantánea
  de la clasificación y del fixture. Los partidos quedan colgados de su temporada: nada se pierde.
- **Trigger:** el botón **Sincronizar** de Partidos recorre todas las ligas activas con un solo cupo (sin cron); desde
  Ligas se puede sincronizar una sola. También hay CLI.
- **Cupo:** máximo `SYNC_DAILY_LIMIT` sincronizaciones reales por organización en 24 h, contadas en `sync_log`.
- **Alcance:** solo los partidos del equipo propio de cada liga (`team_name`) y solo los ya jugados.

Stack: Vercel Functions (Node.js, firma Web `Request → Response`), Supabase (`@supabase/supabase-js`), Zod, TypeScript.

## Cómo funciona

```
Dashboard (Partidos → Sincronizar)
  └─ POST /api/admin/courtrack-sync { league_id? }  (coyotes-website, palabra clave del equipo)
       └─ POST /api/sync { org_id, league_id? }     (este servicio, Authorization: Bearer SYNC_SECRET)
            1. temporadas a recorrer: la indicada (404 si no es de la org, 409 si está pausada o archivada)
               o todas las activas de la organización
            2. inserta la fila en sync_log (running) y cuenta las de las últimas 24 h → 429 si supera el cupo
            por cada temporada:
            3. GET getLigas?id_cliente= → torneos y etapas ACTUALES de la liga (cambian con los playoffs).
               Si la liga ya no existe → temporada archivada ('removed')
            4. GET findPartidos?id_torneos=…&id_etapas=… → todos los partidos con parciales.
               Si guardamos partidos de la temporada y ninguno sigue publicado → reseteo: se archiva ('reset')
               y se abre la temporada siguiente bajo la misma competición
            5. filtra los del equipo propio con status = played
            6. resuelve el rival en `teams`: vínculo guardado → nombre normalizado → alta (y guarda el vínculo)
            7. crea o actualiza la fila de `matches` (clave: matches.courtrack_id) con competition_id y courtrack_league_id
            8. GET getPosiciones por etapa → instantánea (standings + fixture) en la temporada, last_synced_at y escudo propio
            9. cierra la fila de sync_log con el resumen (por liga si fue un sync de todas)
```

### Reglas de importación

| Campo de `matches` | Origen |
|---|---|
| `courtrack_id` · `courtrack_league_id` · `competition_id` | `id` del partido · liga configurada · competición de esa liga |
| `played_on` · `start_time` | `fecha` (primeros 10 caracteres) · `horario` (`1600` → `16:00`) |
| `is_home` | `true` si el equipo propio es `id_equipo_a` |
| `opponent_team_id` | el otro equipo, resuelto o creado en `teams` |
| `sets_won` · `sets_lost` | `sets_a` / `sets_b` según el lado propio |
| `set_scores` | `set1_a…set5_b` hasta el primer set 0-0, como `[{ us, them }]` |
| `phase` · `location` | `etapa_formatted` · `id_cancha` |

- **Deduplicación:** cada partido se busca por `courtrack_id`. Si no existe pero hay un partido **cargado a mano** el
  mismo día contra el mismo rival, de la misma competición o sin competición, se **vincula** (se le pone el id y se
  actualizan los datos de resultado) en vez de duplicarlo. `slug`, `summary`, `cover_image_url`, `activity_id` y los
  videos nunca se tocan.
- **Sin cambios:** si la fila ya tiene exactamente los datos de CourtTrack no se escribe nada.
- **Rivales:** CourtTrack es la fuente de verdad. Un rival existente pasa a tener el nombre de CourtTrack en
  mayúscula inicial (`DRAGONXS HIELO` → `Dragonxs Hielo`) y su logo; la abreviatura se conserva y solo se genera si
  está vacía. Si el nombre nuevo choca con otro equipo, se conserva el anterior. Los vínculos nombre en CourtTrack →
  equipo se guardan en `courtrack_team_links` (se crean solos al resolver por nombre o al dar de alta; desde la vista
  previa del dashboard se puede vincular un rival "a crear" a uno existente con otra grafía).
- **Omitidos:** partidos `upcoming`, con fecha futura o sin parciales.

## Puesta en marcha

### 1. Base de datos

El esquema vive en el repo del dashboard (`coyotes-website/supabase/migrations`): `matches.courtrack_id`, `sync_log`,
`competitions`, `courtrack_leagues`, `courtrack_team_links`. Tras cada migración, en el dashboard `npm run db:types` y
aquí actualizar a mano el subconjunto `api/_lib/database.types.ts`.

### 2. Variables de entorno

```bash
cp .env.example .env          # y rellena los valores
```

| Variable | Descripción |
|---|---|
| `SUPABASE_URL` · `SUPABASE_SECRET_KEY` | Los mismos del dashboard (clave secreta, solo servidor) |
| `SYNC_SECRET` | Token que exigen `/api/sync` y `/api/courtrack/*`. El mismo valor va en `COURTRACK_SYNC_SECRET` del dashboard |
| `SYNC_DAILY_LIMIT` | Cupo de syncs reales por organización en 24 h (5) |
| `COURTRACK_BASE_URL` | Opcional, `https://api.courtrack.com` |

La liga, el equipo propio y la competición **no** son variables: se configuran en el dashboard (Partidos → Ligas).

### 3. Desarrollo y CLI

```bash
npm install
npm run typecheck
npm run sync -- --list                    # temporadas configuradas de la organización (abiertas y archivadas)
npm run sync:dry                          # vista previa de todas las ligas activas: no escribe nada ni gasta cupo
npm run sync                              # sincroniza todas las activas (un cupo)
npm run sync -- --league <uuid>           # solo esa temporada (también con --dry-run)
npm run sync -- --force                   # ignora el cupo (el intento se registra igual)
npm run sync -- --json                    # salida JSON completa · --org <id> (default coyotes)
npm run dev                               # vercel dev en el puerto 3100 (el dashboard usa el 3000)
```

### 4. Deploy en Vercel

Proyecto sin framework. Carga las variables de `.env` en Settings → Environment Variables. En el proyecto del
dashboard, `COURTRACK_SYNC_URL=https://<este-deploy>.vercel.app` y `COURTRACK_SYNC_SECRET=<SYNC_SECRET>`.

## API

Todas las rutas salvo `/api/health` exigen `Authorization: Bearer <SYNC_SECRET>`. Errores en JSON:
`{ error: { code, message, details } }`.

| Método | Ruta | Respuesta |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` (sin auth) |
| GET | `/api/sync?org_id=` | `SyncStatus`: `{ org_id, quota, leagues, last_syncs }` (temporadas abiertas y archivadas, con `season_label`, `archived_at`, `archive_reason`, `snapshot_at` y `last_sync`) |
| POST | `/api/sync` | Cuerpo `{ org_id, league_id?, dry_run? }`. Con `league_id` → `SyncResult` de esa temporada; sin él → `SyncAllResult` `{ leagues, totals, quota }` de todas las activas (un cupo). Cada resultado puede traer `season_event` (`reset` \| `removed`). **429 `quota_exceeded`** (con `details.quota`), 404 `league_not_found`, 409 `league_inactive` \| `league_archived` |
| GET | `/api/courtrack/clientes` | Asociaciones de CourtTrack `{ id, nombre, titulo, logo, deporte }[]` |
| GET | `/api/courtrack/ligas?id_cliente=5` | Ligas de una asociación `{ id, nombre, descripcion, logo, etapas }[]` |
| GET | `/api/courtrack/equipos?id_cliente=5&liga_id=605` | Equipos de la liga `{ name, display_name, logo, matches }[]` (derivados de los partidos; `getEquipos` no responde) |
| GET | `/api/courtrack/descubrir?id_cliente=5&team=COYOTES` | Ligas de la asociación donde juega el equipo `{ liga, team, total_matches, played_matches }[]` (recorre sus partidos, ~2 s para PODIO) |
| GET | `/api/courtrack/partido?id=61320` | `CourtrackPartido`: progresión punto a punto, estadísticas por set y por jugador y formaciones iniciales de un partido jugado (`id` = `matches.courtrack_id`). Los lados son `a`/`b` como en CourtTrack; quien llama decide cuál es el propio. Un id inexistente cierra la conexión: 502 `courtrack_error` |

```jsonc
// POST /api/sync → 200
{
  "dry_run": false,
  "league": { "id": "c9f8efe0-…", "courtrack_id": 605, "name": "+21 Disidencias - NIVEL B - Clausura 2026",
              "competition": { "id": "c37a6884-…", "name": "Liga Podio" } },
  "scanned": 48, "own": 5,
  "created": 0, "updated": 0, "adopted": 4, "unchanged": 0, "skipped": 1, "rivals_created": [],
  "matches": [
    { "courtrack_id": "55550", "played_on": "2026-08-09", "start_time": "16:00", "home": "Dragonxs Hielo", "away": "Coyotes",
      "home_sets": 3, "away_sets": 2, "status": "played", "action": "adopted", "slug": "2026-08-09-vs-dragons-de-hielo",
      "opponent": { "name": "Dragonxs Hielo", "courtrack_name": "DRAGONXS HIELO", "created": false, "renamed_from": "Dragons de Hielo" } },
    { "courtrack_id": "61930", "played_on": "2026-09-20", "start_time": "18:00", "home": "Otrxs", "away": "Coyotes",
      "home_sets": 0, "away_sets": 0, "status": "upcoming", "action": "skipped", "reason": "Todavía no se jugó" }
  ],
  "quota": { "limit": 5, "used": 1, "remaining": 4, "resets_at": "2026-09-17T14:02:11.000Z" }
}
```

Los contratos están en `api/_lib/types.ts` (el dashboard los copia en `shared/schemas.ts`).

### Temporadas y reseteo de ligas

PODIO (y otras asociaciones) reinician la liga cuando termina: los partidos desaparecen de CourtTrack. Para no perder
el histórico, cada fila de `courtrack_leagues` es una **temporada** y el sync:

- Detecta el reseteo cuando la temporada tiene partidos guardados y **ninguno** de sus `courtrack_id` sigue en
  `findPartidos`. Entonces archiva la fila (`archived_at`, `archive_reason = 'reset'`), abre otra con el mismo
  `liga_id`, competición, asociación y equipo (`season_label` = nombre actual de la liga) y sigue sincronizando en la
  nueva. Si `getLigas` ya no devuelve la liga, la archiva con `'removed'`.
- Guarda en cada sync una **instantánea** (`standings` = `getPosiciones` de todas las etapas, `fixture` =
  `findPartidos` completo, `snapshot_at`). Al archivar queda congelada: es la clasificación final de la temporada.
- Los partidos importados apuntan a su temporada (`matches.courtrack_league_id`), así que el dashboard puede filtrar
  por competición y por temporada, y mostrar la clasificación archivada.

Índice único parcial `(org_id, liga_id) where archived_at is null`: solo una temporada abierta por liga.

### Cupo y `sync_log`

Cada sync real inserta una fila **antes** de empezar (`status = running`; `courtrack_league_id` de la temporada, o
null si fue un sync de todas las activas, cuyo `result.leagues` trae el resumen por liga) y cuenta las filas
`running | success | error` de su `org_id` en las últimas 24 h: si superan `SYNC_DAILY_LIMIT`, la fila pasa a
`rejected` (no consume cupo) y se responde 429. Las vistas previas no se registran ni cuentan.

### Seguridad

El token es único y compartido con el backend del dashboard (nunca llega al navegador). Como `org_id` viaja en la
petición, el servicio comprueba que la liga pertenece a esa organización, pero cualquier poseedor del token puede
sincronizar cualquier organización: con el multitenant el token pasará a ser por organización.

## Contrato de CourtTrack (verificado)

- Base `https://api.courtrack.com`, `GET`, sin auth para `/api/torneo/*`. Imágenes en `https://img.courtrack.com`.
- `GET /api/torneo/getClientes` → asociaciones (PODIO = 5).
- `GET /api/torneo/getLigas?id_cliente=5` → ligas con `id_torneos` (array) e `id_etapas` ("3730,3731"). Las etapas
  cambian a mitad de temporada (playoffs): por eso no se guardan y se leen en cada sync.
- `GET /api/torneo/findPartidos?id_torneos=934&id_etapas=3730,3731` → `{ data: [...] }`. **Los dos parámetros son
  obligatorios** (400 "Debe especificar id_etapas" si falta uno).
- `GET /api/torneo/getEquipos` no responde: los equipos de una liga se derivan de `findPartidos`.
- `GET /api/torneo/getDetallePartido?id=<id>` → un partido con `sets[]` (marcador, duración en minutos, tiempos,
  cambios y `formacionA/B` con `posicion` 1–6 y 0 para líberos, `saque` marca quién saca primero), `estadisticas`
  (`set1…setN` y `total`, con `ataques/aces/bloqueos/erroresSaque/erroresNoForzados/total` por lado A/B; ojo:
  `erroresSaqueA` y `erroresNoForzadosA` son puntos que **recibió** A por errores de B, de modo que `totalA` es la
  suma de los cinco; el servicio los devuelve como errores cometidos por cada equipo),
  `progresion` (`set1…setN`: cada entrada trae el marcador **antes** de la acción y `eventoA` o `eventoB` según el
  equipo que la protagoniza, con `tipo` puntoAtaque|puntoSaque|puntoBloqueo|errorSaque|error|tiempo|cambio y
  `descripcion` "12-GRASSI"; la última entrada es el marcador final), `estadisticasJugador` (los dos equipos, con
  `tipo` "jugador,capitan"/"jugador,libero", `puntosDisputados` y el `AIScore` propio de CourtTrack), MVP, duración
  y horas reales. Los totales por jugador coinciden con los que se derivan de la progresión. Un id inexistente
  **cierra la conexión** sin respuesta.
- Cada partido: `id`, `fecha` (ISO a medianoche UTC), `horario` (1600), `id_equipo_a` / `id_equipo_b` (nombres en
  mayúsculas), `status` (`played` | `upcoming`), `sets_a` / `sets_b`, `set1_a…set5_b` (0 en los no jugados),
  `id_cancha`, `etapa_formatted`, `torneo`, `logo_a` / `logo_b`.

Es una API privada sin documentar: puede cambiar sin aviso. Todo lo que depende de su forma está en
`api/_lib/courtrack.ts` (validado con Zod; un cambio de formato responde 502 `courtrack_schema`).

## Estructura

```
api/
  health.ts               GET /api/health
  sync.ts                 GET|POST /api/sync
  courtrack/[resource].ts GET /api/courtrack/clientes|ligas|equipos|descubrir|partido
  _lib/                   (no cuenta como función en Vercel)
    env.ts                variables de entorno
    http.ts               errores, respuestas JSON, parseo de query/body, rutas agrupadas
    auth.ts               Bearer SYNC_SECRET
    supabase.ts           cliente con la clave secreta
    database.types.ts     subconjunto del esquema (a mano)
    courtrack.ts          cliente + esquemas Zod de CourtTrack, catálogo
    leagues.ts            ligas configuradas (courtrack_leagues)
    text.ts               slugify, matchSlugBase, tallySets (copia de coyotes-website/shared/matches.ts), titleCase…
    teams.ts              RivalResolver: vínculo → nombre normalizado → alta
    matches.ts            búsqueda por courtrack_id, adopción de partidos manuales, alta y edición
    syncLog.ts            sync_log: cupo e historial
    sync.ts               orquestador (runSync, getSyncStatus)
    types.ts              contratos
scripts/sync.ts           CLI
public/index.html         página estática mínima (Vercel necesita un output directory)
```
