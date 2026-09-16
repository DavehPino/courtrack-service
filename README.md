# courtrack-service

Microservicio que trae los **resultados de Liga Podio** desde la app **CourtTrack** (Fundación PODIO) a la base de
datos del dashboard de los Coyotes. Es un proyecto aparte de [`coyotes-website`](https://github.com/DavehPino/coyotes-website)
(otro deploy en Vercel) que escribe en la **misma instancia de Supabase**.

- **Trigger:** el botón **Sincronizar** de la vista Partidos del dashboard (sin cron). También hay CLI.
- **Cupo:** máximo `SYNC_DAILY_LIMIT` sincronizaciones reales por organización en 24 h, contadas en la tabla `sync_log`.
- **Alcance:** solo los partidos del equipo propio (`COURTRACK_TEAM`) de una liga (`COURTRACK_LIGA_ID`) y solo los ya
  jugados. Los próximos se listan como omitidos.

Stack: Vercel Functions (Node.js, firma Web `Request → Response`), Supabase (`@supabase/supabase-js`), Zod, TypeScript.

## Cómo funciona

```
Dashboard (botón Sincronizar)
  └─ POST /api/admin/courtrack-sync  (coyotes-website, palabra clave del equipo)
       └─ POST /api/sync  (este servicio, Authorization: Bearer SYNC_SECRET)
            1. inserta la fila en sync_log (status = running) y cuenta las de las últimas 24 h → 429 si supera el cupo
            2. GET getLigas?id_cliente=5 → torneos y etapas de la liga
            3. GET findPartidos?id_torneos=…&id_etapas=… → todos los partidos con parciales
            4. filtra los del equipo propio con status = played
            5. resuelve el rival en `teams` (alias → nombre normalizado → lo crea con el logo de CourtTrack)
            6. crea o actualiza la fila de `matches` (clave: matches.courtrack_id)
            7. cierra la fila de sync_log con el resumen
```

### Reglas de importación

| Campo de `matches` | Origen en CourtTrack |
|---|---|
| `courtrack_id` | `id` |
| `played_on` · `start_time` | `fecha` (primeros 10 caracteres) · `horario` (`1600` → `16:00`) |
| `is_home` | `true` si el equipo propio es `id_equipo_a` |
| `opponent_team_id` | el otro equipo, resuelto o creado en `teams` (nombre en mayúscula inicial, `short_name` de 3 letras, `logo_url`) |
| `sets_won` · `sets_lost` | `sets_a` / `sets_b` según el lado propio |
| `set_scores` | `set1_a…set5_b` hasta el primer set 0-0, como `[{ us, them }]` |
| `competition` · `phase` · `location` | `COURTRACK_COMPETITION` · `etapa_formatted` · `id_cancha` |

- **Deduplicación:** cada partido se busca por `courtrack_id`. Si no existe pero hay un partido **cargado a mano** el
  mismo día contra el mismo rival (sin `courtrack_id`), se **vincula** (se le pone el id y se actualizan los datos de
  resultado) en vez de duplicarlo. `slug`, `summary`, `cover_image_url`, `activity_id` y los videos nunca se tocan.
- **Sin cambios:** si la fila ya tiene exactamente los datos de CourtTrack no se escribe nada.
- **Rivales:** CourtTrack es la fuente de verdad. Un rival existente pasa a tener el nombre de CourtTrack en
  mayúscula inicial (`DRAGONXS HIELO` → `Dragonxs Hielo`) y su logo; la abreviatura se conserva (CourtTrack no la
  publica) y solo se genera si está vacía. Si el nombre nuevo choca con otro equipo, se conserva el anterior. Para
  que un rival cargado a mano con otra grafía (`ONAS` ↔ `Las Onas`) se reconozca la primera vez, usa
  `COURTRACK_TEAM_ALIASES`; después del primer sync ya coincide por nombre. Revisa siempre la **vista previa** antes
  de la primera sincronización para no crear rivales duplicados.
- **Omitidos:** partidos `upcoming`, con fecha futura o sin parciales.

## Puesta en marcha

### 1. Base de datos (una sola vez)

El esquema vive en el repo del dashboard. Aplica sus dos migraciones nuevas y regenera los tipos:

```bash
cd ../coyotes-website
npx supabase db push          # 20260916000000_matches_courtrack_id.sql y 20260916000100_sync_log.sql
npm run db:types
```

### 2. Variables de entorno

```bash
cp .env.example .env          # y rellena los valores
```

| Variable | Descripción |
|---|---|
| `SUPABASE_URL` · `SUPABASE_SECRET_KEY` | Los mismos del dashboard (clave secreta, solo servidor) |
| `SYNC_SECRET` | Token que exige `/api/sync`. El mismo valor va en `COURTRACK_SYNC_SECRET` del dashboard |
| `SYNC_DAILY_LIMIT` · `SYNC_ORG_ID` | Cupo por 24 h (3) · organización en `sync_log` (`coyotes`) |
| `COURTRACK_ID_CLIENTE` · `COURTRACK_LIGA_ID` | Asociación (PODIO = 5) y liga (605 = "+21 Disidencias - NIVEL B - Clausura 2026"). **La liga cambia cada temporada** |
| `COURTRACK_TEAM` · `COURTRACK_COMPETITION` | Nombre propio en CourtTrack (`COYOTES`) · valor de `matches.competition` (`Liga Podio`) |
| `COURTRACK_TEAM_ALIASES` | Opcional, JSON `{"NOMBRE EN COURTRACK":"Nombre en el dashboard"}` |

Para encontrar el id de la liga de la temporada siguiente:

```bash
curl -s "https://api.courtrack.com/api/torneo/getLigas?id_cliente=5" | jq '.[] | {id, nombre, id_torneos, id_etapas}'
```

### 3. Desarrollo y CLI

```bash
npm install
npm run typecheck
npm run sync:dry              # vista previa: no escribe nada ni gasta cupo
npm run sync                  # sincroniza (respeta el cupo)
npm run sync -- --force       # ignora el cupo (el intento se registra igual)
npm run sync -- --json        # salida JSON completa
npm run dev                   # vercel dev en el puerto 3100 (el dashboard usa el 3000) → http://localhost:3100/api/health
```

### 4. Deploy en Vercel

Proyecto nuevo (plan Hobby admite hasta 200), sin framework. Carga las variables de `.env` en Settings → Environment
Variables. Después, en el proyecto del dashboard, define `COURTRACK_SYNC_URL=https://<este-deploy>.vercel.app` y
`COURTRACK_SYNC_SECRET=<SYNC_SECRET>`.

## API

Todas las rutas de `/api/sync` exigen `Authorization: Bearer <SYNC_SECRET>`. Errores en JSON: `{ error: { code, message, details } }`.

| Método | Ruta | Respuesta |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` (sin auth) |
| GET | `/api/sync` | `SyncStatus`: `{ org_id, quota, last_syncs }` |
| POST | `/api/sync` | `SyncResult`. Cuerpo opcional `{ "dry_run": true }`. **429 `quota_exceeded`** con `details.quota` si se agotó el cupo |

```jsonc
// POST /api/sync → 200
{
  "dry_run": false,
  "league": { "id": 605, "name": "+21 Disidencias - NIVEL B - Clausura 2026" },
  "scanned": 48, "own": 5,
  "created": 4, "updated": 0, "adopted": 0, "unchanged": 0, "skipped": 1,
  "rivals_created": ["Dragonxs Hielo", "Yacares Zafir", "Onas", "Titanes Voley"],
  "matches": [
    { "courtrack_id": "55550", "played_on": "2026-08-09", "start_time": "16:00", "home": "Dragonxs Hielo", "away": "Coyotes",
      "home_sets": 3, "away_sets": 2, "status": "played", "action": "created", "slug": "2026-08-09-vs-dragonxs-hielo",
      "opponent": { "name": "Dragonxs Hielo", "created": true } },
    { "courtrack_id": "61930", "played_on": "2026-09-20", "start_time": "18:00", "home": "Otrxs", "away": "Coyotes",
      "home_sets": 0, "away_sets": 0, "status": "upcoming", "action": "skipped", "reason": "Todavía no se jugó" }
  ],
  "quota": { "limit": 3, "used": 1, "remaining": 2, "resets_at": "2026-09-17T14:02:11.000Z" }
}
```

Los contratos están en `api/_lib/types.ts` (el dashboard los copia en `shared/schemas.ts`).

### Cupo y `sync_log`

Cada sync real inserta una fila **antes** de empezar (`status = running`) y cuenta las filas `running | success | error`
de su `org_id` en las últimas 24 h: si superan `SYNC_DAILY_LIMIT`, la fila pasa a `rejected` (no consume cupo) y se
responde 429. Las vistas previas no se registran ni cuentan. La tabla sirve además de historial: `result` guarda el
resumen y `error` el motivo de un fallo.

## Contrato de CourtTrack (verificado)

- Base `https://api.courtrack.com`, `GET`, sin auth para `/api/torneo/*`. Imágenes en `https://img.courtrack.com`.
- `GET /api/torneo/getClientes` → asociaciones (PODIO = 5).
- `GET /api/torneo/getLigas?id_cliente=5` → ligas con `id_torneos` (array) e `id_etapas` ("3730,3731").
- `GET /api/torneo/findPartidos?id_torneos=934&id_etapas=3730,3731` → `{ data: [...] }`. **Los dos parámetros son
  obligatorios** (400 "Debe especificar id_etapas" si falta uno).
- Cada partido: `id`, `fecha` (ISO a medianoche UTC), `horario` (1600), `id_equipo_a` / `id_equipo_b` (nombres en
  mayúsculas), `status` (`played` | `upcoming`), `sets_a` / `sets_b`, `set1_a…set5_b` (0 en los no jugados),
  `id_cancha`, `etapa_formatted`, `torneo`, `logo_a` / `logo_b`.

Es una API privada sin documentar: puede cambiar sin aviso. Todo lo que depende de su forma está en
`api/_lib/courtrack.ts` (validado con Zod; un cambio de formato responde 502 `courtrack_schema`).

## Estructura

```
api/
  health.ts          GET /api/health
  sync.ts            GET|POST /api/sync
  _lib/              (no cuenta como función en Vercel)
    env.ts           variables de entorno
    http.ts          errores y respuestas JSON
    auth.ts          Bearer SYNC_SECRET
    supabase.ts      cliente con la clave secreta
    database.types.ts subconjunto del esquema (teams, matches, sync_log)
    courtrack.ts     cliente + esquemas Zod de CourtTrack
    text.ts          slugify, matchSlugBase, tallySets (copia de coyotes-website/shared/matches.ts), titleCase…
    teams.ts         RivalResolver: alias → nombre normalizado → alta
    matches.ts       búsqueda por courtrack_id, adopción de partidos manuales, alta y edición
    syncLog.ts       sync_log: cupo e historial
    sync.ts          orquestador (runSync, getSyncStatus)
    types.ts         contratos de /api/sync
scripts/sync.ts      CLI
public/index.html    página estática mínima (Vercel necesita un output directory)
```
