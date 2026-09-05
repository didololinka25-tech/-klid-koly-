import { createClient } from '@supabase/supabase-js'
import { handleSchoolCalendarRequest } from '../_shared/schoolCalendarHandler.ts'

declare const Deno: {
  env: { get(name: string): string | undefined }
  serve(handler: (request: Request) => Response | Promise<Response>): void
}

Deno.serve((request) => handleSchoolCalendarRequest(request, {
  authenticate: async (authorizationHeader) => {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (!supabaseUrl || !supabaseAnonKey) return 'unauthenticated'

    const token = authorizationHeader.replace(/^Bearer\s+/i, '')
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorizationHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: userData, error: userError } = await supabase.auth.getUser(token)
    if (userError || !userData.user) return 'unauthenticated'
    const { data: canView, error: permissionError } = await supabase.rpc('can_view_school_data')
    return !permissionError && canView === true ? 'allowed' : 'forbidden'
  },
  getSecret: (name) => Deno.env.get(name),
  fetch,
}))
