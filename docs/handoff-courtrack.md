# Handoff: reparar la integración cuando CourtTrack cambia

La API de CourtTrack es privada y sin documentar: cambia sin aviso (el 2026-09-27 las descripciones de la progresión
pasaron de `"12-GRASSI"` a `"10-RODAS Fuerza Error\r\nde 50-VELASQUEZ FLORES"` y el dashboard mostró jugadas enteras
como nombres de jugador). Este documento es el procedimiento para que cualquier sesión (o persona) detecte el cambio,
lo repare en los tres repos y lo deje verificado. En Claude Code se lanza con **`/courtrack-repair`**
(`.claude/skills/courtrack-repair/SKILL.md`), opcionalmente con el síntoma: `/courtrack-repair el partido de hoy muestra X`.

## Vigilancia automática (viernes)

El chequeo corre solo cada viernes 12:00 UTC (`api/cron/contract-check.ts`, Vercel Cron). Si falla, llega un email con las
fallas: entonces lanzar `/courtrack-repair` y seguir el procedimiento. Detalle y variables en el README (§5).

## Dónde vive cada cosa

| Repo | Qué toca de CourtTrack |
|---|---|
| `courtrack-service` (este) | **Todo el contrato**: `api/_lib/courtrack.ts` (esquemas Zod, `EVENT_KINDS`, `parseEventDescription`, `toEvents`, `toStatLine`) y `api/_lib/types.ts` |
| `teamhub-api` | Solo reenvía: `api/_lib/courtrackSync.ts` llama a `/api/courtrack/partido`, `api/_lib/matchStats.ts` lo orienta a `us`/`them`. Copia de los tipos en `shared/schemas.ts` |
| `coyotes-website` | Lo pinta: `src/dashboard/matches/stats/` (`setStats.ts` calcula las líneas por jugador desde `events`). Copia de los tipos en `shared/schemas.ts` |

Los datos del detalle **no se guardan** en Supabase: se piden en vivo a CourtTrack en cada apertura (caché privada de
1 h en el navegador). Arreglar el servicio arregla también los partidos viejos; no hay nada que migrar. El sync de
resultados (`findPartidos` → `matches`) sí escribe en Supabase: si lo que cambia es eso, revisar `sync.ts` y hacer
`npm run sync:dry` antes de un sync real.

## Procedimiento

1. **Detectar.** En `courtrack-service`: `npm run check:courtrack` (últimos 4 partidos de la liga 605) o
   `npm run check:courtrack -- --partido <id>[,<id>]` para el partido del síntoma. Para toda la liga, pasar todos los
   ids jugados. El script comprueba:
   - que `getLigas`, `findPartidos` y `getDetallePartido` pasen los esquemas;
   - claves nuevas en `getDetallePartido` y tipos de evento desconocidos (`KNOWN_DETALLE_KEYS`, `KNOWN_EVENT_TIPOS`,
     `KNOWN_SANCTIONS`);
   - que toda acción tenga jugador con dorsal;
   - que las acciones por jugador sacadas de la progresión sumen igual que `estadisticasJugador` (la verdad oficial);
   - que los puntos de la progresión de cada set sumen su marcador final.
2. **Mirar el crudo.** `curl -s "https://api.courtrack.com/api/torneo/getDetallePartido?id=<id>"` (sin auth) en el
   scratchpad, y comparar el partido roto con uno anterior que funcionaba: claves, `progresion.setN[].eventoA/B`
   (`tipo`, `titulo`, `descripcion`), `estadisticas`, `estadisticasJugador`, `sets[].formacionA/B`. Los ids de la liga
   salen de `findPartidos?id_torneos=934&id_etapas=3730,3731` (vía `getLigas?id_cliente=5`, liga 605; cambian cada
   temporada: los actuales están en `courtrack_leagues`).
3. **Reparar en `courtrack-service`,** manteniendo compatibilidad con el formato viejo (los partidos anteriores siguen
   publicados con él). El contrato hacia afuera (`CourtrackPartido`) no cambia salvo que haga falta; si cambia
   (p. ej. un `kind` nuevo), actualizar la unión de tipos **en los tres** `types.ts`/`shared/schemas.ts` y, en
   `coyotes-website`, `EVENT_KIND_LABELS` y `NON_POINT_KINDS` de `setStats.ts` (el `Record` obliga a tener todas).
   Desplegar primero dashboard y API, y el servicio al final, para que nunca llegue un valor que el dashboard no conoce.
4. **Actualizar el chequeo** con lo aprendido (claves o tipos conocidos, nuevas invariantes) y dejar anotado el cambio
   en la tabla de abajo y en el comentario de `parseEventDescription`/`EVENT_KINDS` si corresponde.
5. **Verificar:** `npm run typecheck` en los tres repos y `npm run check:courtrack` sobre **todos** los partidos jugados
   de la liga (formato viejo y nuevo) con salida 0.
6. **Commit** en cada repo tocado (mensajes en castellano, estilo de `git log`), push y deploy: todo con el visto bueno
   del usuario, en el orden del paso 3. Recordarle que el navegador puede tener cacheada 1 h la respuesta vieja (recarga forzada).

## Historial de cambios de CourtTrack

| Fecha | Cambio | Arreglo |
|---|---|---|
| 2026-09-27 | `progresion[].evento.descripcion` pasa a incluir la técnica y el rival: `"Punto Directo 1-ROJAS"`, `"10-RODAS Fuerza Error\r\nde 50-VELASQUEZ FLORES"`, `"6-REYNOSO Del Ataque\r\nde 14-TORRES"`, `"Afuera 86-SUAREZ"` | `parseEventDescription`: protagonista = primer jugador citado; el resto va a `detail` ("Fuerza error de #50 Velasquez Flores") |
| 2026-09-27 (detectado) | Sanciones en la progresión (`sanction:green` "#1 ALONSO", `sanction:delay` sin descripción) caían en `other` y contaban como punto | `kind: 'sanction'` (no mueve el marcador) en los tres repos; si una sanción concede punto, `toEvents` añade el punto `other` por el cambio de marcador |
| 2026-09-27 (aprovechado) | El formato nuevo nombra al rival de la acción | `opponent` en cada evento (`forced_error`, `used_block`, `blocked`), `roster_a/b` por set (formación + cambios) y `play_detail` en el partido; el dashboard muestra la columna «E. F» (errores forzados) solo si `play_detail` |
