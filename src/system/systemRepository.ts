import type { Session } from '@supabase/supabase-js'
import { accessRole, schoolRepository, type Profile } from '../schoolRepository'
import { supabase } from '../supabase'
import { isMissingCafeteriaSchema, type ModuleRole } from './access'

export type SystemIdentity = {
  profile: Profile
  cleaningAccessRole: string
  moduleRoles: ModuleRole[]
  cafeteriaAvailable: boolean
}

function client() {
  if (!supabase) throw new Error('Supabase není nakonfigurovaný.')
  return supabase
}

export const systemRepository = {
  getSession: schoolRepository.getSession,
  onAuthChange: schoolRepository.onAuthChange,
  signInWithGoogle: schoolRepository.signInWithGoogle,
  signOut: schoolRepository.signOut,
  identity: async (session: Session): Promise<SystemIdentity | null> => {
    const profile = await schoolRepository.profile(session.user.id)
    if (!profile) return null
    const { data, error } = await client()
      .from('user_module_roles')
      .select('module,role')
      .eq('user_id', session.user.id)
    if (isMissingCafeteriaSchema(error)) {
      return { profile, cleaningAccessRole: accessRole(profile), moduleRoles: [], cafeteriaAvailable: false }
    }
    if (error) throw error
    return {
      profile,
      cleaningAccessRole: accessRole(profile),
      moduleRoles: (data ?? []) as ModuleRole[],
      cafeteriaAvailable: true,
    }
  },
}
