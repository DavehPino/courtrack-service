---
name: courtrack-repair
description: Detecta y repara cambios de la API privada de CourtTrack en courtrack-service (y, si hace falta, en teamhub-api y coyotes-website). Usar cuando el dashboard muestre datos raros de un partido de CourtTrack (progresión, estadísticas por set o por jugador, formaciones), cuando falle el sync o como revisión periódica del contrato.
argument-hint: "[síntoma o id de partido]"
---

# Reparar la integración con CourtTrack

Síntoma o partido indicado por el usuario (puede venir vacío): $ARGUMENTS

Sigue el procedimiento de `docs/handoff-courtrack.md` de este repo, de principio a fin. Léelo entero antes de tocar nada.

Resumen del bucle:

1. `npm run check:courtrack` (y `-- --partido <id>` si el síntoma nombra un partido; los de hoy salen de `findPartidos`).
   Si sale 0 y hay síntoma, el problema está en otro sitio: mira `teamhub-api/api/_lib/matchStats.ts` y
   `coyotes-website/src/dashboard/matches/stats/`.
2. Compara el JSON crudo del partido roto con uno anterior que funcione (curl al scratchpad, sin auth).
3. Arregla en `api/_lib/courtrack.ts` sin romper el formato viejo; si cambia el contrato `CourtrackPartido`,
   actualiza los tipos en los tres repos y los `Record` de `setStats.ts`.
4. Amplía `scripts/check-courtrack.ts` para que el cambio quede cubierto y añade una fila al historial del handoff.
5. `npm run typecheck` en cada repo tocado y `npm run check:courtrack -- --partido <todos los jugados>` en 0.
6. Propón commit por repo, push y deploy (dashboard y API antes que el servicio), y hazlos solo con el visto bueno del
   usuario. Recuérdale la caché de 1 h del navegador.

Informa al usuario en castellano: qué cambió CourtTrack (con un ejemplo del crudo), qué se arregló y dónde, y el
resultado del chequeo.
