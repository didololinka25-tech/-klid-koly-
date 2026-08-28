import type { RealtimeChannel, Session } from '@supabase/supabase-js'
import type { Attendance, Task } from './types'
import { supabase } from './supabase'
import { isTaskDueOnDate } from './scheduling'

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
export type TaskLoad = { tasks: Task[] }
export type ManagedRoom = { id: string; buildingId: string; floorId: string | null; name: string; active: boolean; sortOrder: number }
export type AttendanceWorker = { id: string; name: string; role: AccessRole }
export type AttendanceSettings = { plannedShiftsPerWeek: number; configurable: boolean }
export type PlanOptions = {
  buildings: { id: string; name: string }[]
  floors: { id: string; buildingId: string; name: string; sortOrder: number }[]
  rooms: { id: string; buildingId: string; floorId: string | null; name: string; floor: string; floorSort: number; building: string; active: boolean; sortOrder: number }[]
}

const localToday = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
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
    return (data ?? []).map(mappedProfile)
  },
  updateUserAccess: async (userId: string, role: AccessRole, active: boolean) => {
    const { error } = await client().rpc('owner_set_user_access', { target_user_id: userId, new_access_role: role, new_active: active })
    if (error) throw error
  },
  tasks: async (profile: Profile, includeAll = false): Promise<TaskLoad> => {
    const db = client()
    const date = localToday()
    const [{ data: rows, error }, { data: rooms, error: roomsError }, { data: floors, error: floorsError }, { data: buildings, error: buildingsError }, { data: completions, error: completionError }] = await Promise.all([
      db.from('cleaning_tasks').select('id,name,activity_type,frequency,active,sort_order,requires_task_id,schedule_days,monthly_day,assignment_mode,rotation_anchor_date,rotation_interval_weeks,work_part_id,room_id').order('sort_order'),
      db.from('rooms').select('id,name,active,floor_id,building_id'),
      db.from('floors').select('id,name,sort_order,building_id'),
      db.from('buildings').select('id,name'),
      db.from('cleaning_completions').select('task_id,completed').eq('completion_date', date),
    ])
    if (error || roomsError || floorsError || buildingsError || completionError) throw error ?? roomsError ?? floorsError ?? buildingsError ?? completionError
    const roomById = new Map((rooms ?? []).map((room: any) => [room.id, room]))
    const floorById = new Map((floors ?? []).map((floor: any) => [floor.id, floor]))
    const buildingById = new Map((buildings ?? []).map((building: any) => [building.id, building]))
    const done = new Map((completions ?? []).map((completion: { task_id: string; completed: boolean }) => [completion.task_id, completion.completed]))
    const tasks = (rows ?? []).filter((row: any) => {
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
        assignedTo: 'Úklidový tým', done: done.get(row.id) ?? false, prerequisite: row.requires_task_id, canComplete: canWork(profile),
        dueToday: room?.active !== false && isTaskDueOnDate(row, date, isTestCleaningDay), sortOrder: row.sort_order, scheduleDays, monthlyDay: row.monthly_day,
        workPartId: row.work_part_id, assignmentMode: row.assignment_mode, rotationAnchorDate: row.rotation_anchor_date,
        rotationIntervalWeeks: row.rotation_interval_weeks, active: row.active, rotationAssignments: [],
      }
    })
    return { tasks }
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
  saveRoom: async (room: ManagedRoom) => {
    const values = { building_id: room.buildingId, floor_id: room.floorId, name: room.name.trim(), active: room.active, sort_order: room.sortOrder }
    if (!values.name) throw new Error('Název místnosti nesmí být prázdný.')
    const { error } = room.id ? await client().from('rooms').update(values).eq('id', room.id) : await client().from('rooms').insert(values)
    if (error) throw error
  },
  saveTask: async (task: Task) => {
    const values = { room_id: task.roomId ?? null, name: task.title, activity_type: task.activityType, frequency: Object.entries(frequency).find(([, label]) => label === task.frequency)?.[0], active: task.active, sort_order: task.sortOrder, schedule_days: task.scheduleDays, monthly_day: task.monthlyDay ?? null }
    const result = task.id ? await client().from('cleaning_tasks').update(values).eq('id', task.id).select('id').single() : await client().from('cleaning_tasks').insert(values).select('id').single()
    if (result.error) throw result.error
  },
  setCompletion: async (taskId: string, workerId: string, completed: boolean) => {
    const { error } = await client().from('cleaning_completions').upsert({ completion_date: localToday(), task_id: taskId, worker_id: workerId, completed }, { onConflict: 'completion_date,task_id' })
    if (error) throw error
  },
  setCompletions: async (taskIds: string[], workerId: string) => {
    for (const taskId of taskIds) {
      const { error } = await client().from('cleaning_completions').upsert({ completion_date: localToday(), task_id: taskId, worker_id: workerId, completed: true }, { onConflict: 'completion_date,task_id' })
      if (error) throw error
    }
  },
  attendance: async (workerId: string): Promise<Attendance[]> => {
    const { data, error } = await client().from('attendance').select('id,worker_id,started_at,ended_at,attendance_date,note').eq('worker_id', workerId).order('started_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map((row: any) => ({ id: row.id, workerId: row.worker_id, start: row.started_at, end: row.ended_at ?? undefined, date: row.attendance_date, note: row.note ?? undefined }))
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
  updateAttendance: async (id: string, startedAt: string, endedAt?: string) => {
    const start = new Date(startedAt); const end = endedAt ? new Date(endedAt) : null
    if (Number.isNaN(start.getTime()) || (end && (Number.isNaN(end.getTime()) || end < start))) throw new Error('Zkontrolujte začátek a konec směny.')
    const localDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
    const { error } = await client().from('attendance').update({ started_at: start.toISOString(), ended_at: end?.toISOString() ?? null, attendance_date: localDate }).eq('id', id)
    if (error) throw error
  },
  deleteAttendance: async (id: string, workerId: string) => {
    const { data, error } = await client().from('attendance').delete().eq('id', id).eq('worker_id', workerId).select('id').maybeSingle()
    if (error) throw error
    if (!data) throw new Error('Směnu se nepodařilo smazat nebo k ní nemáte oprávnění.')
  },
  startAttendance: async (workerId: string): Promise<Attendance> => {
    const db = client(); const { data: building, error: buildingError } = await db.from('buildings').select('id').eq('name', 'Škola').single()
    if (buildingError) throw buildingError
    const { data, error } = await db.from('attendance').insert({ worker_id: workerId, building_id: building.id, attendance_date: localToday() }).select('id,worker_id,started_at,ended_at,attendance_date,note').single()
    if (error) throw error
    return { id: data.id, workerId: data.worker_id, start: data.started_at, end: data.ended_at ?? undefined, date: data.attendance_date, note: data.note ?? undefined }
  },
  finishAttendance: async (id: string): Promise<Attendance> => {
    const { data, error } = await client().from('attendance').update({ ended_at: new Date().toISOString() }).eq('id', id).select('id,worker_id,started_at,ended_at,attendance_date,note').single()
    if (error) throw error
    return { id: data.id, workerId: data.worker_id, start: data.started_at, end: data.ended_at ?? undefined, date: data.attendance_date, note: data.note ?? undefined }
  },
  subscribe: (onChange: () => void): RealtimeChannel => client().channel('school-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cleaning_completions' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, onChange)
    .subscribe(),
}
