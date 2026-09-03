import type { RealtimeChannel, Session } from '@supabase/supabase-js'
import type { Attendance, Task } from './types'
import { supabase } from './supabase'
import {
  isTaskDueForCleaningDay,
  dateRangeChunks,
  resolveCleaningDay,
  type CleaningDayContext,
  type CleaningDayException,
} from './scheduling'
import { isSameTaskDefinition } from './taskValidation'
import { pragueDateKey, validateAttendanceInterval } from './attendanceTime'
import { attendanceStartValues } from './buildingScope'
import { inferredBulkCompletable, isBulkCompletableTask } from './cleaningBulk'
import { workerPlanningSaveError, type CleaningRotationSlot, type PlanningWorker, type WorkerPlanningData, type WorkerScheduleException, type WorkerWorkAssignment } from './workerPlanning'

export type AccessRole = 'pending' | 'cleaning_team' | 'admin' | 'visitor'
export type LegacyRole = 'cleaner' | 'caretaker'
export type Profile = {
  id: string
  full_name: string
  role: AccessRole | LegacyRole
  access_role?: AccessRole
  active: boolean
  is_owner?: boolean
  email?: string | null
  created_at?: string
  first_signed_in_at?: string
  last_signed_in_at?: string | null
}
export type UserProfile = {
  id: string
  fullName: string
  email: string
  role: AccessRole
  active: boolean
  isOwner: boolean
  firstSignedInAt: string
  lastSignedInAt?: string
}
export type BulkCompletionAction = {
  id: string
  roomId: string
  workerId: string
  workerName: string
  createdAt: string
  taskIds: string[]
  canUndo: boolean
}
export type TaskLoad = { dateKey: string; tasks: Task[]; bulkActions: BulkCompletionAction[]; cleaningDay: CleaningDayContext; cleaningDaysAvailable: boolean }
export type DynamicSchoolPlanItem = {
  taskId: string
  scheduledDate: string
  planReason: Task['plannerReason']
  dueFrom: string | null
  dueTo: string | null
  assignedWorkerId: string | null
  plannerPriority: number | null
}
export type CleaningDayRecord = CleaningDayException & {
  buildingId: string
  scopeType: 'whole_school'
  createdBy: string
}
export type CleaningDayDraft = {
  id?: string
  buildingId: string
  kind: 'extraordinary' | 'rescheduled'
  executionDate: string
  sourceDate?: string | null
  title: string
  note?: string | null
  selectedTaskIds?: string[]
}
export type StockItem = { id: string; name: string; note: string; status: 'needed' | 'resolved'; buildingId?: string | null; createdBy?: string | null }
export type Incident = { id: string; date: string; title: string; note: string; status: string; buildingId?: string | null; building: string; roomId?: string | null; room: string; floor: string; createdBy?: string | null }
export type OperationRoom = { id: string; buildingId: string; building: string; name: string; floor: string }
export type OperationsData = { stock: StockItem[]; incidents: Incident[]; rooms: OperationRoom[]; buildings: Workplace[]; editable: boolean; buildingScopeAvailable: boolean }
export type ManagedRoom = { id: string; buildingId: string; floorId: string | null; name: string; active: boolean; sortOrder: number }
export type ManagedFloor = { id: string; buildingId: string; name: string; sortOrder: number }
export type ManualEntryType = 'guide' | 'practical' | 'arrival'
export type ManualEntry = {
  id: string; entryType: ManualEntryType; title: string; category: string; body: string
  supplies: string; steps: string; warnings: string; schoolNote: string; markerColor: string
  activityTypes: string[]; featured: boolean; active: boolean; sortOrder: number
}
export type ManualData = { entries: ManualEntry[]; available: boolean; editable: boolean }
export type AttendanceWorker = { id: string; name: string; role: AccessRole }
export type AttendanceSettings = { plannedShiftsPerWeek: number; configurable: boolean }
export type AttendanceAuditEntry = {
  id: string
  attendanceId: string
  oldDate: string
  oldStart: string
  oldEnd?: string
  newDate: string
  newStart: string
  newEnd?: string
  changedByName: string
  changedAt: string
  changeKind: 'clock_out' | 'correction'
}
export type ContractType = 'dpp' | 'dpc' | 'other'
export type WorkerContract = { id: string; workerId: string; contractType: ContractType; validFrom: string; validTo?: string; hourlyRate?: number; note: string; active: boolean; createdAt?: string; updatedAt?: string }
export type AppSettings = { dppAnnualLimitHours: number; dpcWeeklyHoursReference: number; dpcReferencePeriodWeeks: number; dpcMonthlyInsuranceThreshold: number; available: boolean; contractsAvailable: boolean; compensationAvailable: boolean }
export type Workplace = { id: string; name: string; active: boolean }
export type PlanOptions = {
  buildings: { id: string; name: string }[]
  floors: { id: string; buildingId: string; name: string; sortOrder: number }[]
  rooms: { id: string; buildingId: string; floorId: string | null; name: string; floor: string; floorSort: number; building: string; active: boolean; sortOrder: number }[]
}

const mapWorkAssignment = (row: any): WorkerWorkAssignment => ({
  id: row.id, workerId: row.worker_id, workerName: row.worker_name, buildingId: row.building_id,
  buildingName: row.building_name, floorId: row.floor_id, floorName: row.floor_name,
  areaLabel: row.area_label, weekdays: row.weekdays ?? [], validFrom: row.valid_from,
  validTo: row.valid_to, active: Boolean(row.active),
  linkedProfileId: row.linked_profile_id ?? null,
})
const mapScheduleException = (row: any): WorkerScheduleException => ({
  id: row.id, workerId: row.worker_id, workerName: row.worker_name, date: row.exception_date,
  planned: Boolean(row.planned), buildingId: row.building_id, buildingName: row.building_name,
  floorId: row.floor_id, floorName: row.floor_name, areaLabel: row.area_label,
  note: row.note ?? '', active: Boolean(row.active),
  linkedProfileId: row.linked_profile_id ?? null,
})
const mapRotationSlot = (row: any): CleaningRotationSlot => ({
  id: row.id, rotationKey: row.rotation_key, slotIndex: Number(row.slot_index), workerId: row.worker_id,
  workerName: row.worker_name, validFrom: row.valid_from, validTo: row.valid_to, active: Boolean(row.active),
})

const localToday = () => pragueDateKey(new Date())
const missingRelation = (error: { code?: string; message?: string } | null) =>
  Boolean(error && ['42P01', 'PGRST205'].includes(error.code ?? ''))
const missingColumn = (error: { code?: string; message?: string } | null) =>
  Boolean(error && ['42703', 'PGRST204'].includes(error.code ?? ''))
const missingFunction = (error: { code?: string; message?: string } | null) =>
  Boolean(error && ['42883', 'PGRST202'].includes(error.code ?? ''))
const frequency: Record<string, Task['frequency']> = { cleaning_day: 'denně', weekly: 'týdně', once_or_twice_weekly: '1–2× týdně', monthly: 'měsíčně', extraordinary: 'mimořádně' }
export const isTestCleaningDay = new URLSearchParams(window.location.search).get('testCleaningDay') === '1'

export function accessRole(profile: Profile): AccessRole {
  if (profile.access_role) return profile.access_role
  if (profile.role === 'caretaker') return 'admin'
  if (profile.role === 'cleaner') return 'cleaning_team'
  return profile.role
}
export const canWork = (profile: Profile) => ['cleaning_team', 'admin'].includes(accessRole(profile))
export const canManageOperations = (profile: Profile) => accessRole(profile) === 'admin'
export const canViewSchool = (profile: Profile) => ['cleaning_team', 'admin', 'visitor'].includes(accessRole(profile))

function client() {
  if (!supabase) throw new Error('Supabase není nakonfigurovaný.')
  return supabase
}

function mappedProfile(row: any): UserProfile {
  const role: AccessRole = row.access_role ?? (row.role === 'caretaker' ? 'admin' : 'cleaning_team')
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email ?? '',
    role,
    active: row.active,
    isOwner: row.is_owner ?? false,
    firstSignedInAt: row.first_signed_in_at ?? row.created_at,
    lastSignedInAt: row.last_signed_in_at ?? undefined,
  }
}

export const schoolRepository = {
  getSession: async (): Promise<Session | null> => (await client().auth.getSession()).data.session,
  onAuthChange: (callback: (session: Session | null) => void) => client().auth.onAuthStateChange((_event, session) => callback(session)),
  signInWithGoogle: async () => {
    const { error } = await client().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}${window.location.pathname}${window.location.search}` } })
    if (error) throw error
  },
  signOut: async () => { const { error } = await client().auth.signOut(); if (error) throw error },
  updateOwnProfileName: async (fullName: string) => {
    const cleanedName = fullName.trim()
    if (cleanedName.length < 2 || cleanedName.length > 100) throw new Error('Zobrazované jméno musí mít 2 až 100 znaků.')
    if (/[\u0000-\u001f\u007f]/.test(cleanedName)) throw new Error('Zobrazované jméno nesmí obsahovat nové řádky ani řídicí znaky.')
    const { data, error } = await client().rpc('update_own_profile_name', { new_full_name: cleanedName })
    if (missingFunction(error)) throw new Error('Ukládání profilu ještě není v databázi aktivní. Aplikujte migraci 02900.')
    if (error) throw new Error(error.message || 'Profil se nepodařilo uložit.')
    return String(data)
  },
  profile: async (id: string): Promise<Profile | null> => {
    const extended = await client().from('profiles').select('id,full_name,role,access_role,active,is_owner,email,created_at,first_signed_in_at,last_signed_in_at').eq('id', id).maybeSingle()
    if (!extended.error) return extended.data as Profile | null
    if (extended.error.code !== '42703' && !extended.error.message.includes('access_role')) throw extended.error
    const legacy = await client().from('profiles').select('id,full_name,role,active,created_at').eq('id', id).maybeSingle()
    if (legacy.error) throw legacy.error
    return legacy.data as Profile | null
  },
  users: async (): Promise<UserProfile[]> => {
    const { data, error } = await client().from('profiles').select('id,full_name,email,role,access_role,active,is_owner,created_at,first_signed_in_at,last_signed_in_at').order('first_signed_in_at')
    if (error) throw error
    return (data ?? []).map(mappedProfile).sort((a, b) => {
      const pendingOrder = Number(b.role === 'pending') - Number(a.role === 'pending')
      return pendingOrder || a.firstSignedInAt.localeCompare(b.firstSignedInAt)
    })
  },
  updateUserAccess: async (userId: string, role: AccessRole, active: boolean) => {
    const { error } = await client().rpc('owner_set_user_access', { target_user_id: userId, new_access_role: role, new_active: active })
    if (error) throw error
  },
  tasks: async (profile: Profile, includeAll = false, requestedDate?: string): Promise<TaskLoad> => {
    const db = client()
    const date = requestedDate ?? localToday()
    let taskResult: any = await db.from('cleaning_tasks').select('id,plan_key,name,activity_type,frequency,active,sort_order,requires_task_id,schedule_days,monthly_day,room_id,cleaning_cycle_length,cleaning_cycle_offset,period_months,period_week,period_anchor_month,bulk_completable').order('sort_order')
    if (missingColumn(taskResult.error)) {
      taskResult = await db.from('cleaning_tasks').select('id,plan_key,name,activity_type,frequency,active,sort_order,requires_task_id,schedule_days,monthly_day,room_id,cleaning_cycle_length,cleaning_cycle_offset,period_months,period_week,period_anchor_month').order('sort_order')
    }
    if (missingColumn(taskResult.error)) {
      taskResult = await db.from('cleaning_tasks').select('id,name,activity_type,frequency,active,sort_order,requires_task_id,schedule_days,monthly_day,room_id').order('sort_order')
    }
    const [{ data: rooms, error: roomsError }, { data: floors, error: floorsError }, { data: buildings, error: buildingsError }, { data: completions, error: completionError }] = await Promise.all([
      db.from('rooms').select('id,name,active,floor_id,building_id'),
      db.from('floors').select('id,name,sort_order,building_id'),
      db.from('buildings').select('id,name'),
      db.from('cleaning_completions').select('task_id,completed,completed_at,worker_id').eq('completion_date', date),
    ])
    const rows = taskResult.data
    if (taskResult.error || roomsError || floorsError || buildingsError || completionError) throw taskResult.error ?? roomsError ?? floorsError ?? buildingsError ?? completionError
    const exceptionResult = await db.from('cleaning_day_exceptions')
      .select('id,building_id,kind,execution_date,source_date,title,note,scope_type,status,created_by')
      .or(`execution_date.eq.${date},source_date.eq.${date}`)
    if (exceptionResult.error && !missingRelation(exceptionResult.error)) throw exceptionResult.error
    const exceptionIds = (exceptionResult.data ?? []).map((row: any) => row.id)
    const overrideResult = exceptionIds.length
      ? await db.from('cleaning_day_exception_tasks')
        .select('cleaning_day_exception_id,task_id,included,active')
        .in('cleaning_day_exception_id', exceptionIds)
        .eq('active', true)
      : { data: [], error: null }
    if (overrideResult.error && !missingRelation(overrideResult.error)) throw overrideResult.error
    const overrides = mapCleaningDayOverrides(overrideResult.data ?? [])
    const exceptions = (exceptionResult.data ?? []).map((row: any) => mapCleaningDay(row, overrides.get(row.id)))
    const defaultBuildingId = (buildings ?? []).find((item: any) => item.name === 'Škola')?.id
    const cleaningDay = resolveCleaningDay(date, exceptions.filter((item) => item.buildingId === defaultBuildingId), isTestCleaningDay)
    const dynamicDates = [...new Set([date, cleaningDay.kind === 'rescheduled' ? cleaningDay.scheduleDate : null].filter((value): value is string => Boolean(value)))]
    const dynamicPlanResults = isTestCleaningDay ? [] : await Promise.all(dynamicDates.map((target) =>
      db.rpc('get_dynamic_school_cleaning_plan', { target_from: target, target_to: target })))
    const dynamicPlanError = dynamicPlanResults.find((result) => result.error && !missingFunction(result.error))?.error
    if (dynamicPlanError) throw dynamicPlanError
    const dynamicRows = dynamicPlanResults.flatMap((result) => result.error ? [] : (result.data ?? []) as any[])
    const dynamicSchoolRows = dynamicPlanResults.some((result) => !result.error)
      ? new Map(dynamicRows.map((item) => [item.task_id, item]))
      : null
    const roomById = new Map((rooms ?? []).map((room: any) => [room.id, room]))
    const floorById = new Map((floors ?? []).map((floor: any) => [floor.id, floor]))
    const buildingById = new Map((buildings ?? []).map((building: any) => [building.id, building]))
    let completionRows: any[] = completions ?? []
    const completionStatus = await db.rpc('get_cleaning_completion_status', { target_date: date })
    if (!completionStatus.error) completionRows = completionStatus.data ?? []
    else if (!missingFunction(completionStatus.error)) throw completionStatus.error
    const completionByTask = new Map(completionRows.map((completion: any) => [completion.task_id, completion]))
    const bulkActionResult = await db.rpc('get_cleaning_bulk_actions', { target_date: date })
    if (bulkActionResult.error && !missingFunction(bulkActionResult.error)) throw bulkActionResult.error
    const bulkActions: BulkCompletionAction[] = (bulkActionResult.data ?? []).map((action: any) => ({
      id: action.action_id,
      roomId: action.room_id,
      workerId: action.worker_id,
      workerName: action.worker_name,
      createdAt: action.created_at,
      taskIds: action.task_ids ?? [],
      canUndo: Boolean(action.can_undo),
    }))
    const tasks = (rows ?? []).filter((row: any) => {
      if (row.activity_type === 'disinfect') return false
      const room: any = row.room_id ? roomById.get(row.room_id) : null
      return includeAll || (row.active && (!room || room.active))
    }).map((row: any): Task => {
      const room: any = row.room_id ? roomById.get(row.room_id) : null
      const floor: any = room?.floor_id ? floorById.get(room.floor_id) : null
      const building: any = room?.building_id ? buildingById.get(room.building_id) : null
      const scheduleDays = Array.isArray(row.schedule_days) ? row.schedule_days.map(Number) : []
      const mapped: Task = {
        id: row.id, planKey: row.plan_key ?? null, roomId: room?.id, room: room?.name ?? 'Společný úkol', floorId: floor?.id ?? null, floor: floor?.name ?? 'Společné úkoly', floorSort: floor?.sort_order ?? -1,
        buildingId: building?.id ?? defaultBuildingId, building: building?.name ?? 'Škola', title: row.name, activityType: row.activity_type ?? 'other', frequency: frequency[row.frequency] ?? 'mimořádně',
        assignedTo: 'Úklidový tým', done: completionByTask.get(row.id)?.completed ?? false, prerequisite: row.requires_task_id,
        canComplete: canWork(profile) && !isTestCleaningDay && (!(completionByTask.get(row.id)?.completed ?? false) || completionByTask.get(row.id)?.worker_id === profile.id || accessRole(profile) === 'admin'),
        dueToday: room?.active !== false && (() => {
          const context = resolveCleaningDay(date, exceptions.filter((item) => item.buildingId === (building?.id ?? defaultBuildingId)), isTestCleaningDay)
          if (building?.name === 'Škola' && dynamicSchoolRows && ['standard', 'rescheduled'].includes(context.kind)) return dynamicSchoolRows.has(row.id)
          return isTaskDueForCleaningDay(row, context)
        })(), sortOrder: row.sort_order, scheduleDays, monthlyDay: row.monthly_day,
        active: row.active, roomActive: room?.active ?? true,
        cleaningCycleLength: row.cleaning_cycle_length, cleaningCycleOffset: row.cleaning_cycle_offset,
        periodMonths: row.period_months, periodWeek: row.period_week, periodAnchorMonth: row.period_anchor_month,
        completedBy: completionByTask.get(row.id)?.worker_name ?? null,
        completedById: completionByTask.get(row.id)?.worker_id ?? null,
        completedAt: completionByTask.get(row.id)?.completed_at ?? null,
        plannerReason: dynamicSchoolRows?.get(row.id)?.plan_reason ?? null,
        plannerAssignedWorkerId: dynamicSchoolRows?.get(row.id)?.assigned_worker_id ?? null,
        plannerPriority: dynamicSchoolRows?.get(row.id)?.planner_priority ?? null,
      }
      mapped.bulkCompletable = typeof row.bulk_completable === 'boolean' ? row.bulk_completable : inferredBulkCompletable(mapped)
      return mapped
    })
    return { dateKey: date, tasks, bulkActions, cleaningDay, cleaningDaysAvailable: !exceptionResult.error }
  },
  dynamicSchoolPlan: async (from: string, to: string): Promise<Map<string, Map<string, DynamicSchoolPlanItem>> | null> => {
    // PostgREST commonly caps one RPC response at 1,000 rows. A six-week
    // calendar can exceed that limit and silently lose later floors/extras.
    // Weekly chunks stay well below the cap while preserving one interval load
    // from the component and the server planner remains the only source of truth.
    const results = await Promise.all(dateRangeChunks(from, to).map((chunk) =>
      client().rpc('get_dynamic_school_cleaning_plan', { target_from: chunk.from, target_to: chunk.to })))
    if (results.some((result) => missingFunction(result.error))) return null
    const failed = results.find((result) => result.error)
    if (failed?.error) throw failed.error
    if (results.some((result) => (result.data?.length ?? 0) >= 1000)) {
      throw new Error('Dynamický plán překročil bezpečný limit načtení. Zkuste načtení zopakovat.')
    }
    const byDate = new Map<string, Map<string, DynamicSchoolPlanItem>>()
    for (const row of results.flatMap((result) => result.data ?? [])) {
      const date = String((row as any).scheduled_date)
      const items = byDate.get(date) ?? new Map<string, DynamicSchoolPlanItem>()
      const item: DynamicSchoolPlanItem = {
        taskId: String((row as any).task_id),
        scheduledDate: date,
        planReason: (row as any).plan_reason ?? null,
        dueFrom: (row as any).due_from ?? null,
        dueTo: (row as any).due_to ?? null,
        assignedWorkerId: (row as any).assigned_worker_id ?? null,
        plannerPriority: (row as any).planner_priority == null ? null : Number((row as any).planner_priority),
      }
      items.set(item.taskId, item)
      byDate.set(date, items)
    }
    return byDate
  },
  planOptions: async (buildingId?: string): Promise<PlanOptions> => {
    const db = client()
    let floorQuery = db.from('floors').select('id,building_id,name,sort_order').order('sort_order')
    let roomQuery = db.from('rooms').select('id,building_id,floor_id,name,active,sort_order').order('sort_order')
    if (buildingId) {
      floorQuery = floorQuery.eq('building_id', buildingId)
      roomQuery = roomQuery.eq('building_id', buildingId)
    }
    const [{ data: buildings, error: buildingsError }, { data: floors, error: floorsError }, { data: rooms, error: roomsError }] = await Promise.all([
      db.from('buildings').select('id,name').eq('active', true).order('name'),
      floorQuery,
      roomQuery,
    ])
    if (buildingsError || floorsError || roomsError) throw buildingsError ?? floorsError ?? roomsError
    const floorById = new Map((floors ?? []).map((floor: any) => [floor.id, floor]))
    const buildingById = new Map((buildings ?? []).map((building: any) => [building.id, building]))
    return {
      buildings: (buildings ?? []).map((building: any) => ({ id: building.id, name: building.name })),
      floors: (floors ?? []).map((floor: any) => ({ id: floor.id, buildingId: floor.building_id, name: floor.name, sortOrder: floor.sort_order })),
      rooms: (rooms ?? []).map((room: any) => { const floor: any = floorById.get(room.floor_id); const building: any = buildingById.get(room.building_id); return { id: room.id, buildingId: room.building_id, floorId: room.floor_id, name: room.name, floor: floor?.name ?? 'Bez patra', floorSort: floor?.sort_order ?? 0, building: building?.name ?? 'Škola', active: room.active, sortOrder: room.sort_order } }),
    }
  },
  workplaces: async (): Promise<Workplace[]> => {
    const { data, error } = await client().from('buildings').select('id,name,active').order('name')
    if (error) throw error
    return (data ?? []).map((row: any) => ({ id: row.id, name: row.name, active: row.active }))
  },
  saveWorkplace: async (workplace: Workplace) => {
    const name = workplace.name.trim()
    if (name.length < 2) throw new Error('Název pracoviště musí mít alespoň 2 znaky.')
    const db = client()
    if (!workplace.active) {
      let countQuery = db.from('buildings').select('id', { count: 'exact', head: true }).eq('active', true)
      if (workplace.id) countQuery = countQuery.neq('id', workplace.id)
      const { count, error: countError } = await countQuery
      if (countError) throw countError
      if (!count) throw new Error('Alespoň jedno pracoviště musí zůstat aktivní.')
    }
    const result = workplace.id
      ? await db.from('buildings').update({ name, active: workplace.active }).eq('id', workplace.id)
      : await db.from('buildings').insert({ name, active: workplace.active })
    if (result.error) throw result.error
  },
  appSettings: async (): Promise<AppSettings> => {
    const { data, error } = await client().from('app_settings').select('dpp_annual_limit_hours,dpc_weekly_hours_reference,dpc_reference_period_weeks,dpc_monthly_insurance_threshold').eq('id', true).maybeSingle()
    if (error && missingColumn(error)) {
      const legacy = await client().from('app_settings').select('dpp_annual_limit_hours').eq('id', true).maybeSingle()
      if (legacy.error) throw legacy.error
      return { dppAnnualLimitHours: Number(legacy.data?.dpp_annual_limit_hours ?? 300), dpcWeeklyHoursReference: 20, dpcReferencePeriodWeeks: 26, dpcMonthlyInsuranceThreshold: 4500, available: true, contractsAvailable: false, compensationAvailable: false }
    }
    if (error && missingRelation(error)) return { dppAnnualLimitHours: 300, dpcWeeklyHoursReference: 20, dpcReferencePeriodWeeks: 26, dpcMonthlyInsuranceThreshold: 4500, available: false, contractsAvailable: false, compensationAvailable: false }
    if (error) throw error
    return {
      dppAnnualLimitHours: Number(data?.dpp_annual_limit_hours ?? 300),
      dpcWeeklyHoursReference: Number(data?.dpc_weekly_hours_reference ?? 20),
      dpcReferencePeriodWeeks: Number(data?.dpc_reference_period_weeks ?? 26),
      dpcMonthlyInsuranceThreshold: Number(data?.dpc_monthly_insurance_threshold ?? 4500),
      available: true,
      contractsAvailable: true,
      compensationAvailable: true,
    }
  },
  saveDppAnnualLimit: async (value: number) => {
    const { error } = await client().rpc('set_dpp_annual_limit', { value })
    if (error) throw error
  },
  saveRoom: async (room: ManagedRoom) => {
    const values = { building_id: room.buildingId, floor_id: room.floorId, name: room.name.trim(), active: room.active, sort_order: room.sortOrder }
    if (!values.name) throw new Error('Název místnosti nesmí být prázdný.')
    const { error } = room.id ? await client().from('rooms').update(values).eq('id', room.id) : await client().from('rooms').insert(values)
    if (error) throw error
  },
  saveFloor: async (floor: ManagedFloor) => {
    const values = { building_id: floor.buildingId, name: floor.name.trim(), sort_order: floor.sortOrder }
    if (!values.name) throw new Error('Název patra nebo sekce nesmí být prázdný.')
    const { error } = floor.id
      ? await client().from('floors').update(values).eq('id', floor.id)
      : await client().from('floors').insert(values)
    if (error) throw error
  },
  setRoomActive: async (roomId: string, active: boolean) => {
    const rpc = active ? 'restore_cleaning_room' : 'soft_delete_cleaning_room'
    const { error } = await client().rpc(rpc, { target_room_id: roomId })
    if (error) throw error
  },
  saveTask: async (task: Task) => {
    const db = client()
    const name = task.title.trim()
    const frequencyKey = Object.entries(frequency).find(([, label]) => label === task.frequency)?.[0]
    if (!name) throw new Error('Název úkolu nesmí být prázdný.')
    if (!frequencyKey) throw new Error('Vyberte platnou frekvenci úkolu.')

    let duplicateQuery = db.from('cleaning_tasks')
      .select('id,room_id,name,frequency,schedule_days,monthly_day')
      .eq('active', true)
      .ilike('name', name)
    duplicateQuery = task.roomId ? duplicateQuery.eq('room_id', task.roomId) : duplicateQuery.is('room_id', null)
    const { data: candidates, error: duplicateError } = await duplicateQuery
    if (duplicateError) throw duplicateError
    const duplicate = (candidates ?? []).some((candidate: any) => candidate.id !== task.id && isSameTaskDefinition(
      { id: candidate.id, roomId: candidate.room_id ?? undefined, title: candidate.name, frequency: frequency[candidate.frequency] ?? candidate.frequency, scheduleDays: candidate.schedule_days ?? [], monthlyDay: candidate.monthly_day },
      task,
    ))
    if (duplicate) throw new Error('Stejný aktivní úkol se stejným harmonogramem už v této místnosti existuje.')

    const values: Record<string, unknown> = { room_id: task.roomId ?? null, name, activity_type: task.activityType, frequency: frequencyKey, active: task.active, sort_order: task.sortOrder, schedule_days: task.scheduleDays, monthly_day: task.periodMonths ? null : task.monthlyDay ?? null, requires_task_id: task.prerequisite ?? null, bulk_completable: isBulkCompletableTask(task) }
    const departureCheck = task.planKey?.startsWith('admin|final|') || task.planKey?.startsWith('v2026|school|common|final-')
    if (departureCheck) {
      values.room_id = null; values.frequency = 'cleaning_day'; values.schedule_days = [1, 3, 5]
      values.monthly_day = null; values.requires_task_id = null; values.period_months = null
      values.period_week = null; values.period_anchor_month = null
    }
    if (!task.id && task.planKey?.startsWith('admin|final|')) values.plan_key = task.planKey
    if (task.periodMonths !== undefined) {
      values.period_months = task.periodMonths
      values.period_week = task.periodWeek ?? null
      values.period_anchor_month = task.periodAnchorMonth ?? null
    }
    let result = task.id ? await db.from('cleaning_tasks').update(values).eq('id', task.id).select('id').single() : await db.from('cleaning_tasks').insert(values).select('id').single()
    if (missingColumn(result.error)) {
      delete values.bulk_completable
      result = task.id ? await db.from('cleaning_tasks').update(values).eq('id', task.id).select('id').single() : await db.from('cleaning_tasks').insert(values).select('id').single()
    }
    if (result.error) throw result.error
    if (!result.data?.id) throw new Error('Databáze nepotvrdila uložení úkolu.')
    return String(result.data.id)
  },
  setTaskActive: async (taskId: string, active: boolean) => {
    const { error } = await client().rpc('set_cleaning_task_active', {
      target_task_id: taskId,
      target_active: active,
    })
    if (error) throw error
  },
  setCompletion: async (taskId: string, completed: boolean) => {
    const { error } = await client().rpc('set_cleaning_task_completion', { target_task_id: taskId, target_completion_date: localToday(), target_completed: completed })
    if (error) throw error
  },
  setCompletions: async (taskIds: string[]) => {
    if (!taskIds.length) return
    const bulk = await client().rpc('complete_cleaning_tasks_bulk', { target_task_ids: taskIds, target_completion_date: localToday() })
    if (!bulk.error) return
    if (!missingFunction(bulk.error)) throw bulk.error
    for (const taskId of taskIds) {
      const { error } = await client().rpc('set_cleaning_task_completion', { target_task_id: taskId, target_completion_date: localToday(), target_completed: true })
      if (error) throw error
    }
  },
  cleaningDays: async (): Promise<{ records: CleaningDayRecord[]; available: boolean; taskSelectionAvailable: boolean }> => {
    const { data, error } = await client().from('cleaning_day_exceptions')
      .select('id,building_id,kind,execution_date,source_date,title,note,scope_type,status,created_by')
      .order('execution_date')
    if (missingRelation(error)) return { records: [], available: false, taskSelectionAvailable: false }
    if (error) throw error
    const ids = (data ?? []).map((row: any) => row.id)
    const overrideQuery = client().from('cleaning_day_exception_tasks')
      .select('cleaning_day_exception_id,task_id,included,active')
      .eq('active', true)
    const overrideResult = ids.length ? await overrideQuery.in('cleaning_day_exception_id', ids) : await overrideQuery.limit(1)
    if (overrideResult.error && !missingRelation(overrideResult.error)) throw overrideResult.error
    const overrides = mapCleaningDayOverrides(overrideResult.data ?? [])
    return {
      records: (data ?? []).map((row: any) => mapCleaningDay(row, overrides.get(row.id))),
      available: true,
      taskSelectionAvailable: !overrideResult.error,
    }
  },
  saveCleaningDay: async (draft: CleaningDayDraft) => {
    if (draft.kind === 'extraordinary' && draft.selectedTaskIds) {
      const { error } = await client().rpc('save_extraordinary_cleaning_day', {
        target_exception_id: draft.id ?? null,
        target_building_id: draft.buildingId,
        target_execution_date: draft.executionDate,
        target_title: draft.title.trim(),
        target_note: draft.note?.trim() || '',
        selected_task_ids: draft.selectedTaskIds,
      })
      if (error) throw error
      return
    }
    const values = {
      building_id: draft.buildingId,
      kind: draft.kind,
      execution_date: draft.executionDate,
      source_date: draft.kind === 'rescheduled' ? draft.sourceDate : null,
      title: draft.title.trim(),
      note: draft.note?.trim() || null,
      scope_type: 'whole_school',
      status: 'active',
    }
    const result = draft.id
      ? await client().from('cleaning_day_exceptions').update(values).eq('id', draft.id).select('id').single()
      : await client().from('cleaning_day_exceptions').insert(values).select('id').single()
    if (result.error) throw result.error
  },
  cancelCleaningDay: async (id: string) => {
    const { error } = await client().from('cleaning_day_exceptions').update({ status: 'cancelled' }).eq('id', id)
    if (error) throw error
  },
  manuals: async (profile: Profile): Promise<ManualData> => {
    const { data, error } = await client().from('manual_entries')
      .select('id,entry_type,title,category,body,supplies,steps,warnings,school_note,marker_color,activity_types,featured,active,sort_order')
      .order('sort_order').order('title')
    if (missingRelation(error)) return { entries: [], available: false, editable: false }
    if (error) throw error
    return {
      entries: (data ?? []).map((row: any) => ({
        id: row.id, entryType: row.entry_type, title: row.title, category: row.category,
        body: row.body ?? '', supplies: row.supplies ?? '', steps: row.steps ?? '', warnings: row.warnings ?? '',
        schoolNote: row.school_note ?? '', markerColor: row.marker_color ?? '', activityTypes: row.activity_types ?? [],
        featured: row.featured, active: row.active, sortOrder: row.sort_order,
      })),
      available: true,
      editable: canManageOperations(profile),
    }
  },
  saveManualEntry: async (entry: ManualEntry, userId: string) => {
    const values = {
      entry_type: entry.entryType, title: entry.title.trim(), category: entry.category.trim() || 'Ostatní',
      body: entry.body.trim() || null, supplies: entry.supplies.trim() || null, steps: entry.steps.trim() || null,
      warnings: entry.warnings.trim() || null, school_note: entry.schoolNote.trim() || null,
      marker_color: entry.markerColor || null, activity_types: entry.activityTypes,
      featured: entry.featured, active: entry.active, sort_order: entry.sortOrder, updated_by: userId,
    }
    if (!values.title) throw new Error('Název položky nesmí být prázdný.')
    const result = entry.id
      ? await client().from('manual_entries').update(values).eq('id', entry.id)
      : await client().from('manual_entries').insert({ ...values, created_by: userId })
    if (result.error) throw result.error
  },
  setManualEntryActive: async (id: string, active: boolean, userId: string) => {
    const { error } = await client().from('manual_entries').update({ active, updated_by: userId }).eq('id', id)
    if (error) throw error
  },
  operations: async (): Promise<OperationsData> => {
    const db = client()
    let stockResult = await db.from('stock_items').select('id,name,note,status,building_id,created_by').eq('active', true).order('created_at', { ascending: false })
    let buildingScopeAvailable = true
    if (stockResult.error && missingColumn(stockResult.error)) {
      buildingScopeAvailable = false
      stockResult = await db.from('stock_items').select('id,name,note,status,created_by').eq('active', true).order('created_at', { ascending: false }) as typeof stockResult
    }
    const [incidentResult, roomResult, floorResult, buildingResult] = await Promise.all([
      db.from('incidents').select('id,incident_date,title,note,status,building_id,room_id,worker_id').eq('active', true).order('incident_date', { ascending: false }).limit(100),
      db.from('rooms').select('id,name,floor_id,building_id').eq('active', true).order('sort_order'),
      db.from('floors').select('id,name,sort_order').order('sort_order'),
      db.from('buildings').select('id,name,active').eq('active', true).order('name'),
    ])
    const schemaMissing = [stockResult.error, incidentResult.error].some((error) => error?.code === '42703' || error?.message.includes('column'))
    if (schemaMissing) {
      const [legacyStock, legacyIncidents] = await Promise.all([
        db.from('stock_items').select('id,name').eq('active', true).order('name'),
        db.from('incidents').select('id,incident_date,description,status,room_id,worker_id').order('incident_date', { ascending: false }).limit(30),
      ])
      if (legacyStock.error || legacyIncidents.error) throw legacyStock.error ?? legacyIncidents.error
      return {
        stock: (legacyStock.data ?? []).map((item: any) => ({ id: item.id, name: item.name, note: '', status: 'needed', buildingId: null, createdBy: null })),
        incidents: (legacyIncidents.data ?? []).map((item: any) => ({ id: item.id, date: item.incident_date, title: item.description, note: '', status: item.status, building: '', roomId: item.room_id, room: '', floor: '', createdBy: item.worker_id })),
        rooms: [], buildings: [], editable: false, buildingScopeAvailable: false,
      }
    }
    const error = stockResult.error ?? incidentResult.error ?? roomResult.error ?? floorResult.error ?? buildingResult.error
    if (error) throw error
    const floors = new Map((floorResult.data ?? []).map((floor: any) => [floor.id, floor.name]))
    const buildings = new Map((buildingResult.data ?? []).map((building: any) => [building.id, building.name]))
    const rooms = (roomResult.data ?? []).map((room: any) => ({ id: room.id, buildingId: room.building_id, building: buildings.get(room.building_id) ?? 'Pracoviště', name: room.name, floor: floors.get(room.floor_id) ?? 'Společné' }))
    const roomMap = new Map(rooms.map((room) => [room.id, room]))
    return {
      stock: (stockResult.data ?? []).map((item: any) => ({ id: item.id, name: item.name, note: item.note ?? '', status: item.status, buildingId: item.building_id ?? null, createdBy: item.created_by })),
      incidents: (incidentResult.data ?? []).map((item: any) => ({ id: item.id, date: item.incident_date, title: item.title, note: item.note ?? '', status: item.status, buildingId: item.building_id ?? roomMap.get(item.room_id)?.buildingId ?? null, building: buildings.get(item.building_id ?? roomMap.get(item.room_id)?.buildingId) ?? '', roomId: item.room_id, room: roomMap.get(item.room_id)?.name ?? '', floor: roomMap.get(item.room_id)?.floor ?? '', createdBy: item.worker_id })),
      rooms, buildings: (buildingResult.data ?? []).map((item: any) => ({ id: item.id, name: item.name, active: item.active })),
      editable: true, buildingScopeAvailable,
    }
  },
  workerPlanning: async (): Promise<WorkerPlanningData> => {
    const { data, error } = await client().rpc('get_worker_work_planning')
    if (missingFunction(error)) return { assignments: [], exceptions: [], rotationDefinitions: [], rotationSlots: [], available: false }
    if (error) throw error
    const payload = (data ?? {}) as { planning_workers?: any[]; assignments?: any[]; exceptions?: any[]; rotation_definitions?: any[]; rotation_slots?: any[] }
    return {
      planningWorkers: payload.planning_workers?.map((row): PlanningWorker => ({ id: row.id, name: row.display_name, linkedProfileId: row.linked_profile_id ?? null, active: Boolean(row.active) })),
      assignments: (payload.assignments ?? []).map(mapWorkAssignment),
      exceptions: (payload.exceptions ?? []).map(mapScheduleException),
      rotationDefinitions: (payload.rotation_definitions ?? []).map((row) => ({
        rotationKey: row.rotation_key, title: row.title, anchorDate: row.anchor_date, weekday: Number(row.weekday),
        slotCount: Number(row.slot_count), active: Boolean(row.active),
      })),
      rotationSlots: (payload.rotation_slots ?? []).map(mapRotationSlot),
      available: true,
    }
  },
  saveWorkerWorkAssignment: async (item: WorkerWorkAssignment) => {
    const { error } = await client().rpc('admin_save_planning_worker_work_assignment', {
      target_id: item.id || null, target_planning_worker_id: item.workerId, target_building_id: item.buildingId,
      target_floor_id: item.floorId || null, target_area_label: item.areaLabel, target_weekdays: item.weekdays,
      target_valid_from: item.validFrom, target_valid_to: item.validTo || null, target_active: item.active,
    })
    if (missingFunction(error)) {
      const legacy = await client().rpc('admin_save_worker_work_assignment', {
        target_id: item.id || null, target_worker_id: item.workerId, target_building_id: item.buildingId,
        target_floor_id: item.floorId || null, target_area_label: item.areaLabel, target_weekdays: item.weekdays,
        target_valid_from: item.validFrom, target_valid_to: item.validTo || null, target_active: item.active,
      })
      if (legacy.error) throw new Error(workerPlanningSaveError(legacy.error, 'Pracovní rozdělení se nepodařilo uložit.'))
      return
    }
    if (error) throw new Error(workerPlanningSaveError(error, 'Pracovní rozdělení se nepodařilo uložit.'))
  },
  saveWorkerScheduleException: async (item: WorkerScheduleException) => {
    const { error } = await client().rpc('admin_save_planning_worker_schedule_exception', {
      target_id: item.id || null, target_planning_worker_id: item.workerId, target_exception_date: item.date,
      target_planned: item.planned, target_building_id: item.buildingId || null, target_floor_id: item.floorId || null,
      target_area_label: item.areaLabel || null, target_note: item.note || '', target_active: item.active,
    })
    if (missingFunction(error)) {
      const legacy = await client().rpc('admin_save_worker_schedule_exception', {
        target_id: item.id || null, target_worker_id: item.workerId, target_exception_date: item.date,
        target_planned: item.planned, target_building_id: item.buildingId || null, target_floor_id: item.floorId || null,
        target_area_label: item.areaLabel || null, target_note: item.note || '', target_active: item.active,
      })
      if (legacy.error) throw new Error(workerPlanningSaveError(legacy.error, 'Výjimku rozvrhu se nepodařilo uložit.'))
      return
    }
    if (error) throw new Error(workerPlanningSaveError(error, 'Výjimku rozvrhu se nepodařilo uložit.'))
  },
  saveCleaningRotationSlot: async (slotIndex: number, workerId: string | null, effectiveFrom: string) => {
    const { error } = await client().rpc('admin_set_cleaning_rotation_planning_worker_slot', {
      target_rotation_key: 'school-fourth-floor', target_slot_index: slotIndex,
      target_planning_worker_id: workerId || null, target_effective_from: effectiveFrom,
    })
    if (missingFunction(error)) {
      const legacy = await client().rpc('admin_set_cleaning_rotation_slot', {
        target_rotation_key: 'school-fourth-floor', target_slot_index: slotIndex,
        target_worker_id: workerId || null, target_effective_from: effectiveFrom,
      })
      if (legacy.error) throw legacy.error
      return
    }
    if (error) throw error
  },
  savePlanningWorker: async (worker: PlanningWorker) => {
    const { error } = await client().rpc('admin_save_planning_worker', {
      target_id: worker.id || null, target_display_name: worker.name,
      target_linked_profile_id: worker.linkedProfileId || null, target_active: worker.active,
    })
    if (missingFunction(error)) throw new Error('Plánovací pracovníci ještě nejsou v databázi aktivní. Aplikujte migraci 03400.')
    if (error) throw error
  },
  undoBulkCompletion: async (actionId: string) => {
    const { error } = await client().rpc('undo_cleaning_tasks_bulk', { target_action_id: actionId })
    if (error) throw error
  },
  savePurchaseItem: async (item: { id?: string; name: string; note: string; buildingId: string }, userId: string) => {
    if (!item.buildingId) throw new Error('Vyberte pracoviště.')
    const values = { name: item.name.trim(), note: item.note.trim() || null, building_id: item.buildingId }
    let result = item.id
      ? await client().from('stock_items').update(values).eq('id', item.id)
      : await client().from('stock_items').insert({ ...values, active: true, status: 'needed', created_by: userId })
    if (result.error && missingColumn(result.error)) {
      const legacyValues = { name: values.name, note: values.note }
      result = item.id
        ? await client().from('stock_items').update(legacyValues).eq('id', item.id)
        : await client().from('stock_items').insert({ ...legacyValues, active: true, status: 'needed', created_by: userId })
    }
    if (result.error) throw result.error
  },
  setPurchaseItemStatus: async (id: string, status: 'needed' | 'resolved') => {
    const { error } = await client().from('stock_items').update({ status, resolved_at: status === 'resolved' ? new Date().toISOString() : null, resolved_by: status === 'resolved' ? (await client().auth.getUser()).data.user?.id : null }).eq('id', id)
    if (error) throw error
  },
  archivePurchaseItem: async (id: string) => {
    const { error } = await client().from('stock_items').update({ active: false }).eq('id', id)
    if (error) throw error
  },
  saveIncident: async (item: { id?: string; title: string; note: string; buildingId: string; roomId?: string | null }, userId: string) => {
    if (!item.buildingId) throw new Error('Vyberte pracoviště.')
    const selectedRoom = item.roomId ? await client().from('rooms').select('building_id').eq('id', item.roomId).single() : null
    if (selectedRoom?.error) throw selectedRoom.error
    if (selectedRoom?.data?.building_id && selectedRoom.data.building_id !== item.buildingId) throw new Error('Vybraná místnost nepatří do zvoleného pracoviště.')
    if (item.id) {
      const { error } = await client().from('incidents').update({ title: item.title.trim(), description: item.title.trim(), note: item.note.trim() || null, building_id: item.buildingId, room_id: item.roomId || null }).eq('id', item.id)
      if (error) throw error
      return
    }
    const { error } = await client().from('incidents').insert({ worker_id: userId, building_id: item.buildingId, title: item.title.trim(), description: item.title.trim(), note: item.note.trim() || null, room_id: item.roomId || null, status: 'reported', active: true })
    if (error) throw error
  },
  setIncidentStatus: async (id: string, status: 'reported' | 'resolved') => {
    const { data: current } = await client().auth.getUser()
    const { error } = await client().from('incidents').update({ status, resolved_at: status === 'resolved' ? new Date().toISOString() : null, resolved_by: status === 'resolved' ? current.user?.id : null }).eq('id', id)
    if (error) throw error
  },
  archiveIncident: async (id: string) => {
    const { error } = await client().from('incidents').update({ active: false }).eq('id', id)
    if (error) throw error
  },
  attendance: async (workerId: string): Promise<Attendance[]> => {
    const { data, error } = await client().from('attendance').select('id,worker_id,building_id,started_at,ended_at,attendance_date,note,buildings(name)').eq('worker_id', workerId).order('started_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map(mapAttendance)
  },
  saveDpcSettings: async (weeklyHours: number, referenceWeeks: number, monthlyThreshold: number) => {
    const { error } = await client().rpc('set_dpc_settings', { weekly_hours: weeklyHours, period_weeks: referenceWeeks, monthly_threshold: monthlyThreshold })
    if (error) throw error
  },
  workerContracts: async (workerId: string): Promise<WorkerContract[]> => {
    const { data, error } = await client().from('worker_contracts')
      .select('id,worker_id,contract_type,valid_from,valid_to,hourly_rate,note,active,created_at,updated_at')
      .eq('worker_id', workerId).order('valid_from', { ascending: false })
    if (error && missingColumn(error)) {
      const legacy = await client().from('worker_contracts')
        .select('id,worker_id,contract_type,valid_from,valid_to,note,active,created_at,updated_at')
        .eq('worker_id', workerId).order('valid_from', { ascending: false })
      if (legacy.error) throw legacy.error
      return (legacy.data ?? []).map((row: any) => ({
        id: row.id, workerId: row.worker_id, contractType: row.contract_type,
        validFrom: row.valid_from, validTo: row.valid_to, hourlyRate: undefined, note: row.note ?? '', active: row.active,
        createdAt: row.created_at, updatedAt: row.updated_at,
      }))
    }
    if (error && missingRelation(error)) return []
    if (error) throw error
    return (data ?? []).map((row: any) => ({
      id: row.id, workerId: row.worker_id, contractType: row.contract_type,
      validFrom: row.valid_from, validTo: row.valid_to, hourlyRate: row.hourly_rate === null ? undefined : Number(row.hourly_rate), note: row.note ?? '', active: row.active,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }))
  },
  saveWorkerContract: async (contract: Omit<WorkerContract, 'createdAt' | 'updatedAt'>) => {
    const { error } = await client().rpc('admin_save_worker_contract', {
      target_contract_id: contract.id || null,
      target_worker_id: contract.workerId,
      target_contract_type: contract.contractType,
      target_valid_from: contract.validFrom,
      target_valid_to: contract.validTo || null,
      target_hourly_rate: contract.hourlyRate ?? null,
      target_note: contract.note || '',
      target_active: contract.active,
    })
    if (missingFunction(error)) throw new Error('Historické sazby ještě nejsou v databázi aktivní. Aplikujte migraci 03000.')
    if (error) throw error
  },
  attendanceAudit: async (attendanceId: string): Promise<{ entries: AttendanceAuditEntry[]; available: boolean }> => {
    const { data, error } = await client()
      .from('attendance_audit')
      .select('id,attendance_id,old_attendance_date,old_started_at,old_ended_at,new_attendance_date,new_started_at,new_ended_at,changed_by_name,changed_at,change_kind')
      .eq('attendance_id', attendanceId)
      .order('changed_at', { ascending: false })
    if (error) {
      if (missingRelation(error)) return { entries: [], available: false }
      throw error
    }
    return {
      available: true,
      entries: (data ?? []).map((row: any) => ({
        id: row.id,
        attendanceId: row.attendance_id,
        oldDate: row.old_attendance_date,
        oldStart: row.old_started_at,
        oldEnd: row.old_ended_at ?? undefined,
        newDate: row.new_attendance_date,
        newStart: row.new_started_at,
        newEnd: row.new_ended_at ?? undefined,
        changedByName: row.changed_by_name,
        changedAt: row.changed_at,
        changeKind: row.change_kind,
      })),
    }
  },
  attendanceWorkers: async (): Promise<AttendanceWorker[]> => {
    const { data, error } = await client().from('profiles').select('id,full_name,role,access_role').eq('active', true).in('access_role', ['cleaning_team', 'admin']).order('full_name')
    if (error) throw error
    return (data ?? []).map((row: any) => ({ id: row.id, name: row.full_name, role: row.access_role ?? (row.role === 'caretaker' ? 'admin' : 'cleaning_team') }))
  },
  attendanceSettings: async (workerId: string): Promise<AttendanceSettings> => {
    const { data, error } = await client().from('profiles').select('planned_shifts_per_week').eq('id', workerId).maybeSingle()
    if (error) { if (error.code === '42703' || error.message.includes('planned_shifts_per_week')) return { plannedShiftsPerWeek: 3, configurable: false }; throw error }
    return { plannedShiftsPerWeek: data?.planned_shifts_per_week ?? 3, configurable: true }
  },
  setPlannedShiftsPerWeek: async (workerId: string, ownUserId: string, value: number) => {
    const { error } = workerId === ownUserId ? await client().rpc('set_own_planned_shifts_per_week', { value }) : await client().rpc('admin_set_planned_shifts_per_week', { target_user_id: workerId, value })
    if (error) throw error
  },
  updateAttendance: async (id: string, startedAt: string, endedAt?: string, buildingId?: string) => {
    const db = client()
    const { data: target, error: targetError } = await db.from('attendance').select('id,worker_id').eq('id', id).single()
    if (targetError) throw targetError
    const { data: existing, error: existingError } = await db.from('attendance').select('id,started_at,ended_at').eq('worker_id', target.worker_id).neq('id', id)
    if (existingError) throw existingError
    const records = (existing ?? []).map((row: any) => ({ id: row.id, start: row.started_at, end: row.ended_at ?? undefined }))
    const { start, end, attendanceDate } = validateAttendanceInterval(records, startedAt, endedAt, id)
    const values = { started_at: start.toISOString(), ended_at: end?.toISOString() ?? null, attendance_date: attendanceDate, ...(buildingId ? { building_id: buildingId } : {}) }
    const { data, error } = await db.from('attendance').update(values).eq('id', id).eq('worker_id', target.worker_id).select('id').single()
    if (error) throw attendanceError(error)
    if (!data) throw new Error('Opravená směna nebyla nalezena.')
  },
  deleteAttendance: async (id: string, workerId: string) => {
    const { data, error } = await client().from('attendance').delete().eq('id', id).eq('worker_id', workerId).select('id').maybeSingle()
    if (error) throw error
    if (!data) throw new Error('Směnu se nepodařilo smazat nebo k ní nemáte oprávnění.')
  },
  startAttendance: async (workerId: string, buildingId: string): Promise<Attendance> => {
    if (!buildingId) throw new Error('Vyberte pracoviště směny.')
    const db = client()
    const now = new Date()
    const { data: existing, error: existingError } = await db.from('attendance').select('id,started_at,ended_at').eq('worker_id', workerId)
    if (existingError) throw existingError
    validateAttendanceInterval(
      (existing ?? []).map((row: any) => ({ id: row.id, start: row.started_at, end: row.ended_at ?? undefined })),
      now.toISOString(),
    )
    const values = attendanceStartValues(workerId, buildingId, now.toISOString(), pragueDateKey(now))
    const { data, error } = await db.from('attendance').insert(values).select('id,worker_id,building_id,started_at,ended_at,attendance_date,note,buildings(name)').single()
    if (error) throw attendanceError(error)
    return mapAttendance(data)
  },
  finishAttendance: async (id: string): Promise<Attendance> => {
    const { data, error } = await client().from('attendance').update({ ended_at: new Date().toISOString() }).eq('id', id).select('id,worker_id,building_id,started_at,ended_at,attendance_date,note,buildings(name)').single()
    if (error) throw attendanceError(error)
    return mapAttendance(data)
  },
  subscribe: (onChange: () => void): RealtimeChannel => client().channel('school-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cleaning_completions' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cleaning_day_exceptions' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_items' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, onChange)
    .subscribe(),
}

function attendanceError(error: { code?: string; message?: string }) {
  if (error.code === '23P01' || error.message?.includes('překrývá')) {
    return new Error('Směna se překrývá s jinou evidovanou směnou tohoto pracovníka.')
  }
  return error
}

function mapAttendance(row: any): Attendance {
  const building = Array.isArray(row.buildings) ? row.buildings[0] : row.buildings
  return {
    id: row.id,
    workerId: row.worker_id,
    buildingId: row.building_id,
    buildingName: building?.name ?? 'Škola',
    start: row.started_at,
    end: row.ended_at ?? undefined,
    date: row.attendance_date,
    note: row.note ?? undefined,
  }
}

function mapCleaningDayOverrides(rows: any[]) {
  const byException = new Map<string, Record<string, boolean>>()
  for (const row of rows) {
    const current = byException.get(row.cleaning_day_exception_id) ?? {}
    current[row.task_id] = row.included
    byException.set(row.cleaning_day_exception_id, current)
  }
  return byException
}

function mapCleaningDay(row: any, taskOverrides: Record<string, boolean> = {}): CleaningDayRecord {
  return {
    id: row.id,
    buildingId: row.building_id,
    kind: row.kind,
    executionDate: row.execution_date,
    sourceDate: row.source_date,
    title: row.title,
    note: row.note,
    scopeType: row.scope_type,
    status: row.status,
    createdBy: row.created_by,
    taskOverrides,
  }
}
