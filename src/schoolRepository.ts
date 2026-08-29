import type { RealtimeChannel, Session } from '@supabase/supabase-js'
import type { Attendance, Task } from './types'
import { supabase } from './supabase'
import {
  isTaskDueForCleaningDay,
  resolveCleaningDay,
  type CleaningDayContext,
  type CleaningDayException,
} from './scheduling'

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
export type TaskLoad = { tasks: Task[]; cleaningDay: CleaningDayContext; cleaningDaysAvailable: boolean }
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
export type StockItem = { id: string; name: string; note: string; status: 'needed' | 'resolved'; createdBy?: string | null }
export type Incident = { id: string; date: string; title: string; note: string; status: string; roomId?: string | null; room: string; floor: string; createdBy?: string | null }
export type OperationRoom = { id: string; name: string; floor: string }
export type OperationsData = { stock: StockItem[]; incidents: Incident[]; rooms: OperationRoom[]; editable: boolean }
export type ManagedRoom = { id: string; buildingId: string; floorId: string | null; name: string; active: boolean; sortOrder: number }
export type AttendanceWorker = { id: string; name: string; role: AccessRole }
export type AttendanceSettings = { plannedShiftsPerWeek: number; configurable: boolean }
export type AppSettings = { dppAnnualLimitHours: number; available: boolean }
export type Workplace = { id: string; name: string; active: boolean }
export type PlanOptions = {
  buildings: { id: string; name: string }[]
  floors: { id: string; buildingId: string; name: string; sortOrder: number }[]
  rooms: { id: string; buildingId: string; floorId: string | null; name: string; floor: string; floorSort: number; building: string; active: boolean; sortOrder: number }[]
}

const localToday = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const missingRelation = (error: { code?: string; message?: string } | null) =>
  Boolean(error && ['42P01', 'PGRST205'].includes(error.code ?? ''))
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
    const { data, error } = await client().rpc('update_own_profile_name', { new_full_name: fullName.trim() })
    if (error) throw error
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
  tasks: async (profile: Profile, includeAll = false): Promise<TaskLoad> => {
    const db = client()
    const date = localToday()
    const [{ data: rows, error }, { data: rooms, error: roomsError }, { data: floors, error: floorsError }, { data: buildings, error: buildingsError }, { data: completions, error: completionError }] = await Promise.all([
      db.from('cleaning_tasks').select('id,name,activity_type,frequency,active,sort_order,requires_task_id,schedule_days,monthly_day,room_id').order('sort_order'),
      db.from('rooms').select('id,name,active,floor_id,building_id'),
      db.from('floors').select('id,name,sort_order,building_id'),
      db.from('buildings').select('id,name'),
      db.from('cleaning_completions').select('task_id,completed').eq('completion_date', date),
    ])
    if (error || roomsError || floorsError || buildingsError || completionError) throw error ?? roomsError ?? floorsError ?? buildingsError ?? completionError
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
    const cleaningDay = resolveCleaningDay(date, exceptions, isTestCleaningDay)
    const roomById = new Map((rooms ?? []).map((room: any) => [room.id, room]))
    const floorById = new Map((floors ?? []).map((floor: any) => [floor.id, floor]))
    const buildingById = new Map((buildings ?? []).map((building: any) => [building.id, building]))
    const done = new Map((completions ?? []).map((completion: { task_id: string; completed: boolean }) => [completion.task_id, completion.completed]))
    const tasks = (rows ?? []).filter((row: any) => {
      if (row.activity_type === 'disinfect') return false
      if (row.activity_type === 'windows' && row.name !== 'Mytí oken') return false
      const room: any = row.room_id ? roomById.get(row.room_id) : null
      return includeAll || (row.active && (!room || room.active))
    }).map((row: any): Task => {
      const room: any = row.room_id ? roomById.get(row.room_id) : null
      const floor: any = room?.floor_id ? floorById.get(room.floor_id) : null
      const building: any = room?.building_id ? buildingById.get(room.building_id) : null
      const scheduleDays = Array.isArray(row.schedule_days) ? row.schedule_days.map(Number) : []
      return {
        id: row.id, roomId: room?.id, room: room?.name ?? 'Společný úkol', floor: floor?.name ?? 'Společné úkoly', floorSort: floor?.sort_order ?? -1,
        building: building?.name ?? 'Škola', title: row.name, activityType: row.activity_type ?? 'other', frequency: frequency[row.frequency] ?? 'mimořádně',
        assignedTo: 'Úklidový tým', done: done.get(row.id) ?? false, prerequisite: row.requires_task_id, canComplete: canWork(profile) && !isTestCleaningDay,
        dueToday: room?.active !== false && isTaskDueForCleaningDay(row, cleaningDay), sortOrder: row.sort_order, scheduleDays, monthlyDay: row.monthly_day,
        active: row.active, roomActive: room?.active ?? true,
      }
    })
    return { tasks, cleaningDay, cleaningDaysAvailable: !exceptionResult.error }
  },
  planOptions: async (): Promise<PlanOptions> => {
    const db = client()
    const [{ data: buildings, error: buildingsError }, { data: floors, error: floorsError }, { data: rooms, error: roomsError }] = await Promise.all([
      db.from('buildings').select('id,name').eq('active', true).order('name'),
      db.from('floors').select('id,building_id,name,sort_order').order('sort_order'),
      db.from('rooms').select('id,building_id,floor_id,name,active,sort_order').order('sort_order'),
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
    const { data, error } = await client().from('app_settings').select('dpp_annual_limit_hours').eq('id', true).maybeSingle()
    if (error && missingRelation(error)) return { dppAnnualLimitHours: 300, available: false }
    if (error) throw error
    return { dppAnnualLimitHours: Number(data?.dpp_annual_limit_hours ?? 300), available: true }
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
  saveTask: async (task: Task) => {
    const values = { room_id: task.roomId ?? null, name: task.title, activity_type: task.activityType, frequency: Object.entries(frequency).find(([, label]) => label === task.frequency)?.[0], active: task.active, sort_order: task.sortOrder, schedule_days: task.scheduleDays, monthly_day: task.monthlyDay ?? null, requires_task_id: task.prerequisite ?? null }
    const result = task.id ? await client().from('cleaning_tasks').update(values).eq('id', task.id).select('id').single() : await client().from('cleaning_tasks').insert(values).select('id').single()
    if (result.error) throw result.error
  },
  setCompletion: async (taskId: string, completed: boolean) => {
    const { error } = await client().rpc('set_cleaning_task_completion', { target_task_id: taskId, target_completion_date: localToday(), target_completed: completed })
    if (error) throw error
  },
  setCompletions: async (taskIds: string[]) => {
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
  operations: async (): Promise<OperationsData> => {
    const db = client()
    const [stockResult, incidentResult, roomResult, floorResult] = await Promise.all([
      db.from('stock_items').select('id,name,note,status,created_by').eq('active', true).order('created_at', { ascending: false }),
      db.from('incidents').select('id,incident_date,title,note,status,room_id,worker_id').eq('active', true).order('incident_date', { ascending: false }).limit(100),
      db.from('rooms').select('id,name,floor_id').eq('active', true).order('sort_order'),
      db.from('floors').select('id,name,sort_order').order('sort_order'),
    ])
    const schemaMissing = [stockResult.error, incidentResult.error].some((error) => error?.code === '42703' || error?.message.includes('column'))
    if (schemaMissing) {
      const [legacyStock, legacyIncidents] = await Promise.all([
        db.from('stock_items').select('id,name').eq('active', true).order('name'),
        db.from('incidents').select('id,incident_date,description,status,room_id,worker_id').order('incident_date', { ascending: false }).limit(30),
      ])
      if (legacyStock.error || legacyIncidents.error) throw legacyStock.error ?? legacyIncidents.error
      return {
        stock: (legacyStock.data ?? []).map((item: any) => ({ id: item.id, name: item.name, note: '', status: 'needed', createdBy: null })),
        incidents: (legacyIncidents.data ?? []).map((item: any) => ({ id: item.id, date: item.incident_date, title: item.description, note: '', status: item.status, roomId: item.room_id, room: '', floor: '', createdBy: item.worker_id })),
        rooms: [],
        editable: false,
      }
    }
    const error = stockResult.error ?? incidentResult.error ?? roomResult.error ?? floorResult.error
    if (error) throw error
    const floors = new Map((floorResult.data ?? []).map((floor: any) => [floor.id, floor.name]))
    const rooms = (roomResult.data ?? []).map((room: any) => ({ id: room.id, name: room.name, floor: floors.get(room.floor_id) ?? 'Společné' }))
    const roomMap = new Map(rooms.map((room) => [room.id, room]))
    return {
      stock: (stockResult.data ?? []).map((item: any) => ({ id: item.id, name: item.name, note: item.note ?? '', status: item.status, createdBy: item.created_by })),
      incidents: (incidentResult.data ?? []).map((item: any) => ({ id: item.id, date: item.incident_date, title: item.title, note: item.note ?? '', status: item.status, roomId: item.room_id, room: roomMap.get(item.room_id)?.name ?? '', floor: roomMap.get(item.room_id)?.floor ?? '', createdBy: item.worker_id })),
      rooms,
      editable: true,
    }
  },
  savePurchaseItem: async (item: { id?: string; name: string; note: string }, userId: string) => {
    const values = { name: item.name.trim(), note: item.note.trim() || null }
    const result = item.id
      ? await client().from('stock_items').update(values).eq('id', item.id)
      : await client().from('stock_items').insert({ ...values, active: true, status: 'needed', created_by: userId })
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
  saveIncident: async (item: { id?: string; title: string; note: string; roomId?: string | null }, userId: string) => {
    if (item.id) {
      const { error } = await client().from('incidents').update({ title: item.title.trim(), description: item.title.trim(), note: item.note.trim() || null, room_id: item.roomId || null }).eq('id', item.id)
      if (error) throw error
      return
    }
    const { data: building, error: buildingError } = await client().from('buildings').select('id').eq('name', 'Škola').single()
    if (buildingError) throw buildingError
    const { error } = await client().from('incidents').insert({ worker_id: userId, building_id: building.id, title: item.title.trim(), description: item.title.trim(), note: item.note.trim() || null, room_id: item.roomId || null, status: 'reported', active: true })
    if (error) throw error
  },
  setIncidentStatus: async (id: string, status: 'reported' | 'resolved') => {
    const { data: current } = await client().auth.getUser()
    const { error } = await client().from('incidents').update({ status, resolved_at: status === 'resolved' ? new Date().toISOString() : null, resolved_by: status === 'resolved' ? current.user?.id : null }).eq('id', id)
    if (error) throw error
  },
  attendance: async (workerId: string): Promise<Attendance[]> => {
    const { data, error } = await client().from('attendance').select('id,worker_id,building_id,started_at,ended_at,attendance_date,note,buildings(name)').eq('worker_id', workerId).order('started_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map(mapAttendance)
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
    const start = new Date(startedAt); const end = endedAt ? new Date(endedAt) : null
    if (Number.isNaN(start.getTime()) || (end && (Number.isNaN(end.getTime()) || end < start))) throw new Error('Zkontrolujte začátek a konec směny.')
    const localDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
    const values = { started_at: start.toISOString(), ended_at: end?.toISOString() ?? null, attendance_date: localDate, ...(buildingId ? { building_id: buildingId } : {}) }
    const { error } = await client().from('attendance').update(values).eq('id', id)
    if (error) throw error
  },
  deleteAttendance: async (id: string, workerId: string) => {
    const { data, error } = await client().from('attendance').delete().eq('id', id).eq('worker_id', workerId).select('id').maybeSingle()
    if (error) throw error
    if (!data) throw new Error('Směnu se nepodařilo smazat nebo k ní nemáte oprávnění.')
  },
  startAttendance: async (workerId: string, buildingId: string): Promise<Attendance> => {
    if (!buildingId) throw new Error('Vyberte pracoviště směny.')
    const db = client()
    const { data, error } = await db.from('attendance').insert({ worker_id: workerId, building_id: buildingId, attendance_date: localToday() }).select('id,worker_id,building_id,started_at,ended_at,attendance_date,note,buildings(name)').single()
    if (error) throw error
    return mapAttendance(data)
  },
  finishAttendance: async (id: string): Promise<Attendance> => {
    const { data, error } = await client().from('attendance').update({ ended_at: new Date().toISOString() }).eq('id', id).select('id,worker_id,building_id,started_at,ended_at,attendance_date,note,buildings(name)').single()
    if (error) throw error
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
