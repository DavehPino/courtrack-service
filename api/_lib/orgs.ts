// Organizaciones (tabla organizations, la gestiona teamhub-api). El servicio recibe el slug (`org_id`) del backend del
// dashboard, que ya autenticó al usuario en esa organización; aquí se traduce a su id y se comprueba que existe, para
// que un slug inventado no cree datos ni consuma cupo. Todo el aislamiento de datos se hace con el id (uuid).
import { env } from './env.js'
import { HttpError } from './http.js'
import { db } from './supabase.js'

export type Org = {
  id: string
  slug: string
  /** Syncs reales permitidos en 24 h: el de la organización o, si no tiene, el de SYNC_DAILY_LIMIT. */
  dailyLimit: number
}

/** 404 `org_not_found` si el slug no corresponde a ninguna organización. */
export async function resolveOrg(slug: string): Promise<Org> {
  const { data, error } = await db().from('organizations').select('id,slug,courtrack_daily_limit').eq('slug', slug).maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404, 'org_not_found', 'La organización no existe')
  return { id: data.id, slug: data.slug, dailyLimit: data.courtrack_daily_limit ?? env.dailyLimit }
}
