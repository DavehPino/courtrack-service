# Integración CourtTrack → resultados de los Coyotes

> Plan para ingerir manualmente los resultados de los Coyotes desde la app CourtTrack a Supabase.
> Fase 1 (descubrimiento) ya está hecha y verificada. Falta implementar la Fase 2.

## Contexto

La liga publica los resultados en la app móvil **CourtTrack** (React Native/Expo, de Fundación
PODIO). Hoy los partidos de los Coyotes se cargan **a mano** en el dashboard
(`/api/admin/matches`); la idea es traerlos desde CourtTrack sin tipearlos.

No hizo falta interceptar tráfico: se descargó el APK de APKPure, se extrajo la API del bundle
Hermes y se confirmó en vivo (GET de solo lectura, sin auth). Son datos públicos de terceros; el
alcance se limita a los partidos de los Coyotes, volumen bajo y bajo demanda (**sin cron**).

Decisiones: **integrar** (no solo informe), **solo resultados de los Coyotes**, **sin cron por
ahora**, liga objetivo = **PODIO, "+21 Disidencias - NIVEL B - Clausura 2026"**.

## Contrato de la API de CourtTrack (verificado)

- **Base:** `https://api.courtrack.com`  ·  **Método:** `GET`  ·  **Auth:** ninguna para `/api/torneo/*`.
- **Imágenes:** `https://img.courtrack.com/...` (logos incluidos en las respuestas).
- Endpoints (`/api/auth/*` y `/api/usuario/*` requieren cuenta, no se usan):
  - `GET /api/torneo/getClientes` → asociaciones. **PODIO = `id_cliente=5`**.
  - `GET /api/torneo/getLigas?id_cliente=5` → ligas de PODIO. La nuestra: **liga 605**,
    `"+21 Disidencias - NIVEL B - Clausura 2026"`, **`id_torneos=934`**, `id_etapas=3730,3731`.
  - `GET /api/torneo/findPartidos?id_torneos=934` → **todos los partidos con parciales** (48).
  - Otros disponibles (no necesarios acá): `getEquipos?id_torneos=&id_etapas=`,
    `getDetallePartido`, `getPosiciones`, `getPodio`/`getPodioRanking`, `getDetalleJugador`,
    `getDetalleEquipo`, `getFotos`/`getFotosPartido`/`getAlbums`.
- **Forma de cada partido en `findPartidos`** (campos usados):
  `id` (id CourtTrack), `fecha` (ISO), `horario` (ej. `1600`=16:00), `id_equipo_a`/`id_equipo_b`
  (nombres tipo `"COYOTES"`, `"ONAS"`, `"TITANES VOLEY"`), `sets_a`/`sets_b`,
  `set1_a`…`set5_a` / `set1_b`…`set5_b` (parciales), `status` (`played`|`upcoming`),
  `id_cancha`, `torneo`, `etapa_formatted`, `logo_a`/`logo_b`.

### Ejemplo de datos reales ya obtenidos (equipo `COYOTES`)

| Fecha | Partido | Parciales | status |
|---|---|---|---|
| 2026-08-09 | DRAGONXS HIELO 3-2 COYOTES | 20-25, 26-28, 25-23, 25-18, 15-8 | played |
| 2026-08-30 | COYOTES 3-0 YACARES ZAFIR | 25-20, 25-14, 25-23 | played |
| 2026-09-06 | ONAS 3-0 COYOTES | 25-15, 25-17, 25-11 | played |
| 2026-09-13 | COYOTES 1-3 TITANES VOLEY | 28-30, 25-22, 23-25, 19-25 | played |
| 2026-09-20 | OTRXS vs COYOTES | — | upcoming |

`ONAS` ya existe como rival en `supabase/seed.sql`.

**Comprobación rápida (curl):**
```bash
curl -s "https://api.courtrack.com/api/torneo/findPartidos?id_torneos=934" | jq '.data[] | select((.id_equipo_a,.id_equipo_b)|test("COYOTES"))'
```

## Fase 2 — Ingesta manual hacia Supabase (a construir)

Lógica reutilizable en un lib nuevo + disparador por **script CLI** (nada de cron ni nueva Vercel
Function → no toca el límite de 12 del plan Hobby). El mismo lib podrá enchufarse luego a
`api/admin/[action].ts` o a un cron sin reescribirlo.

### 2.1 Cliente — `api/_lib/courtrack.ts` (nuevo)
- `fetch` GET contra `env.courtrack.baseUrl` con las rutas de arriba. Config por env:
  `COURTRACK_BASE_URL` (default `https://api.courtrack.com`), `COURTRACK_ID_TORNEOS` (`934`),
  `COURTRACK_TEAM` (`COYOTES`) → agregar a `api/_lib/env.ts` con el patrón `optional()` y a `.env.example`.
- Validar la respuesta con **Zod** (ya es dependencia) y quedarse con los partidos donde
  `id_equipo_a` o `id_equipo_b` == equipo propio y `status === 'played'` (los `upcoming` se omiten:
  `matches` es solo de jugados y `assertPlayed` rechaza fechas futuras).

### 2.2 Mapeo `findPartidos` → fila `matches`
- `played_on` = `fecha.slice(0,10)`; `start_time` = `horario` → `"HH:MM"`.
- Lado propio: si `id_equipo_a === COYOTES` → `is_home = true`, `us = *_a`, `them = *_b`; si no, al revés.
- `set_scores` = `[{us, them}]` por set con marcador; `sets_won/lost` con **`tallySets`** (`shared/matches.ts`).
- Rival = lado contrario; `competition` = `torneo`; `phase` = `etapa_formatted`;
  `location` = `id_cancha`; logo del rival = `logo_a`/`logo_b`.
- Rival → **`resolveOpponentByName(name)`** (helper nuevo en `api/_lib/teams.ts`) que normaliza con
  **`slugify`** y busca por `lower(name)` antes de crear; **reutiliza `createRivalTeam`** y el índice
  único `lower(name)+category`. Así `ONAS`/`TITANES VOLEY` se mapean o se crean una sola vez.

### 2.3 Deduplicación (requiere migración)
Para no chocar ni pisar partidos hechos a mano: columna **`matches.courtrack_id text unique`**
(nullable) y `upsert` con `onConflict: 'courtrack_id'` (solo toca filas importadas).
- Migración: `supabase/migrations/20260916000000_matches_courtrack_id.sql`
  (`alter table matches add column courtrack_id text;` + índice único parcial `where courtrack_id is not null`).
- Regenerar tipos: `npm run db:types` (actualiza `shared/database.types.ts`).
- El slug se sigue generando con `matchSlugBase` (compatibilidad con carpetas de video en el bucket).

### 2.4 Disparador — `scripts/import-courtrack.ts` (nuevo)
- CLI fino que llama a `syncCourtrackMatches()` e imprime `{ scanned, created, updated, skipped }`;
  flag `--dry-run` para ver qué haría sin escribir.
- Añadir **`tsx`** como devDependency y script `"import:courtrack": "tsx scripts/import-courtrack.ts"`
  (permite reusar los libs TS de `api/_lib` sin duplicar lógica; `scripts/` hoy usa `.mjs`).
- Ejecuta con las envs del `.env` (misma `SUPABASE_SECRET_KEY` del servidor).

### Archivos
- **Nuevos:** `api/_lib/courtrack.ts`, `scripts/import-courtrack.ts`,
  `supabase/migrations/20260916000000_matches_courtrack_id.sql`.
- **Editar:** `api/_lib/env.ts` (+`COURTRACK_*`), `.env.example`, `package.json` (`tsx` + script),
  `api/_lib/teams.ts` (`resolveOpponentByName`), `shared/database.types.ts` (regenerado).

## Riesgos
- API privada y no documentada: puede cambiar sin aviso → todo lo frágil aislado en `courtrack.ts`.
- Nombres de rivales en MAYÚSCULAS y sin acentos (`ONAS` vs `Ónas` del seed): la normalización con
  `slugify` los une, pero conviene revisar el primer `--dry-run` para no duplicar rivales.

## Verificación
1. Aplicar migración en local (`supabase migration up` o `supabase db reset`) y `npm run db:types`.
2. `npm run import:courtrack -- --dry-run` → revisar el resumen (rivales a crear, partidos nuevos).
3. Correr sin `--dry-run`; verificar en el dashboard (`/matches`, `/matches/:slug`) que los 4
   partidos jugados aparecen con parciales, resultado, rival, competición y fase correctos.
4. Re-ejecutar: debe reportar `updated`/`skipped`, **sin** duplicar ni pisar partidos manuales.
5. `npm run build` (corre `check-functions.mjs` + `tsc -b`).
