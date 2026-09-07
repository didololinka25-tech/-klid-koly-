import { supabase } from '../supabase'

export type ApprovalModule = 'cafeteria' | 'cleaning'
export type ApprovalAssignment = {
  module: ApprovalModule
  role: string
  familyId?: string | null
}
export type PendingAccessUser = {
  id: string
  fullName: string
  email: string | null
  firstSignedInAt: string
}
export type ApprovalFamily = { id: string; displayName: string }
export type ApprovalLoad = {
  available: boolean
  users: PendingAccessUser[]
  families: ApprovalFamily[]
}

type SupabaseError = { code?: string; message?: string }

function client() {
  if (!supabase) throw new Error('Supabase není nakonfigurovaný.')
  return supabase
}

const missingApprovalWorkflow = (error: SupabaseError | null) =>
  Boolean(error && ['42883', 'PGRST202'].includes(error.code ?? ''))

export function approvalErrorMessage(error: unknown): string {
  const message = typeof error === 'object' && error && 'message' in error
    ? String((error as { message?: unknown }).message ?? '')
    : ''
  const safeMessages = [
    'Uživatele může schválit pouze hlavní správce.',
    'Sami sebe tímto formulářem schválit nemůžete.',
    'Uživatel už má přidělený přístup.',
    'Neplatný modul.',
    'Neplatná role Jídelny.',
    'Neplatná role Úklidu.',
    'Vybraná rodina není aktivní.',
    'Pro Úklid lze při schválení vybrat jen jednu roli.',
    'Stejná role je ve formuláři vícekrát.',
  ]
  return safeMessages.find((item) => message.includes(item))
    ?? 'Schválení se nepodařilo. Obnovte seznam a zkuste to znovu.'
}

export const accessApprovalRepository = {
  load: async (): Promise<ApprovalLoad> => {
    const pendingResult = await client().rpc('school_pending_access_users')
    if (missingApprovalWorkflow(pendingResult.error)) {
      return { available: false, users: [], families: [] }
    }
    if (pendingResult.error) throw pendingResult.error

    const familyResult = await client()
      .from('cafeteria_families')
      .select('id,display_name')
      .eq('active', true)
      .order('display_name')
    if (familyResult.error) throw familyResult.error

    return {
      available: true,
      users: ((pendingResult.data ?? []) as Array<{
        user_id: string
        full_name: string
        email: string | null
        first_signed_in_at: string
      }>).map((row) => ({
        id: row.user_id,
        fullName: row.full_name,
        email: row.email,
        firstSignedInAt: row.first_signed_in_at,
      })),
      families: ((familyResult.data ?? []) as Array<{ id: string; display_name: string }>).map((row) => ({
        id: row.id,
        displayName: row.display_name,
      })),
    }
  },
  approve: async (userId: string, assignments: ApprovalAssignment[]): Promise<void> => {
    const requestedAssignments = assignments.map((assignment) => ({
      module: assignment.module,
      role: assignment.role,
      ...(assignment.module === 'cafeteria' && assignment.role === 'parent' && assignment.familyId
        ? { family_id: assignment.familyId }
        : {}),
    }))
    const result = await client().rpc('school_approve_user_access', {
      target_user_id: userId,
      requested_assignments: requestedAssignments,
    })
    if (result.error) throw result.error
  },
}
