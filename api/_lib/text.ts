// Normalización de nombres y reglas de partido. `slugify`, `matchSlugBase` y `tallySets` son copia de
// coyotes-website/shared/matches.ts: los slugs deben coincidir con los del dashboard (son URL y carpeta de videos).

/** "Las Ónas Vóley" → "las-onas-voley". Vacío si no queda ningún carácter válido. */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Slug base del partido: "2026-09-20-vs-las-onas". Se añade "-2", "-3"... si ya existe. */
export function matchSlugBase(playedOn: string, opponentName: string): string {
  const rival = slugify(opponentName).slice(0, 60).replace(/-+$/, '') || 'rival'
  return `${playedOn}-vs-${rival}`
}

export type SetScore = { us: number; them: number }

/** Sets ganados y perdidos a partir de los parciales. Los sets empatados no cuentan. */
export function tallySets(sets: SetScore[]): { won: number; lost: number } {
  let won = 0
  let lost = 0
  for (const set of sets) {
    if (set.us > set.them) won += 1
    else if (set.us < set.them) lost += 1
  }
  return { won, lost }
}

/** Dos nombres son el mismo equipo si coinciden sin acentos, mayúsculas ni signos: "ONAS" = "Onas". */
export const sameName = (a: string, b: string) => slugify(a) === slugify(b)

/** CourtTrack escribe todo en mayúsculas: "TITANES VOLEY" → "Titanes Voley". */
export function titleCase(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase('es')
    .replace(/(^|[\s\-/(])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toLocaleUpperCase('es'))
}

/** Abreviatura de un rival nuevo (máximo 4 caracteres, como en el dashboard): "Titanes Voley" → "TIT". */
export function shortNameFor(name: string): string | null {
  const word = slugify(name)
    .split('-')
    .find((part) => /[a-z]/.test(part))
  if (!word) return null
  return word.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase() || null
}

/** `horario` de CourtTrack (1600, 930) → "16:00", "09:30". Null si no es una hora válida. */
export function horarioToTime(horario: number | null | undefined): string | null {
  if (horario === null || horario === undefined || !Number.isInteger(horario)) return null
  const hours = Math.floor(horario / 100)
  const minutes = horario % 100
  if (hours < 0 || hours > 23 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** Fecha local de hoy como "YYYY-MM-DD". */
export function todayIsoDate(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}
