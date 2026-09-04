export const APP_HISTORY_KEY = 'klidKolyNavigation'

export type AppHistoryState = {
  section?: string
  layer?: string
  token?: string
}

export function appHistoryState(state: unknown): AppHistoryState {
  if (!state || typeof state !== 'object') return {}
  const value = (state as Record<string, unknown>)[APP_HISTORY_KEY]
  return value && typeof value === 'object' ? value as AppHistoryState : {}
}

export function withAppHistoryState(state: unknown, navigation: AppHistoryState) {
  const base = state && typeof state === 'object' ? state as Record<string, unknown> : {}
  return { ...base, [APP_HISTORY_KEY]: navigation }
}

export function shouldReloadIdentity(previousUserId: string | null, nextUserId: string | null) {
  return previousUserId !== nextUserId
}

export function shouldRunResumeRefresh(lastRefreshAt: number, now: number, cooldownMs = 25_000) {
  return now - lastRefreshAt >= cooldownMs
}

export type RealtimeRefreshArea = 'today' | 'attendance' | 'cleaning-days' | 'operations' | 'manual' | 'worker-planning' | 'plan-options'

export function refreshAreasForRealtimeTable(table: string): RealtimeRefreshArea[] {
  if (table === 'cleaning_completions') return ['today']
  if (table === 'attendance') return ['attendance']
  if (table === 'cleaning_day_exceptions') return ['cleaning-days', 'today']
  if (table === 'stock_items' || table === 'incidents') return ['operations']
  if (table === 'manual_entries') return ['manual']
  if (table === 'cleaning_tasks' || table === 'rooms' || table === 'floors') return ['plan-options', 'today']
  if (table === 'planning_workers' || table === 'worker_work_assignments' || table === 'worker_schedule_exceptions' || table === 'cleaning_rotation_slot_assignments' || table === 'worker_weekly_responsibilities') return ['worker-planning', 'today']
  return []
}
