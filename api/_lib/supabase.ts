// Cliente de Supabase SOLO para servidor (clave secreta, ignora RLS). Misma instancia que el dashboard.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types.js'
import { env } from './env.js'

export type Db = SupabaseClient<Database>

let client: Db | undefined

export function db(): Db {
  client ??= createClient<Database>(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return client
}
