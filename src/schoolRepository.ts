import type { RealtimeChannel, Session } from '@supabase/supabase-js'
import type { Attendance, Task, Worker } from './types'
import { supabase } from './supabase'

export type Profile = { id: string; full_name: Worker; role: 'cleaner' | 'caretaker'; active: boolean }
const today = () => new Date().toISOString().slice(0, 10)
const frequency: Record<string, Task['frequency']> = { cleaning_day: 'denně', weekly: 'týdně', once_or_twice_weekly: '1–2× týdně', monthly: 'měsíčně', extraordinary: 'mimořádně' }

// Dočasný režim pro vizuální kontrolu: ?testCleaningDay=1 nasimuluje pondělní úklidový den.
export const isTestCleaningDay = new URLSearchParams(window.location.search).get('testCleaningDay') === '1'

function dateParts(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return { year, month, day }
}

export function isoDay(date: string) {
  const { year, month, day } = dateParts(date)
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return dayOfWeek === 0 ? 7 : dayOfWeek
}

export function effectivePlanningDate(date: string) {
  if (!isTestCleaningDay) return date
  const { year, month, day } = dateParts(date)
  const monday = new Date(Date.UTC(year, month - 1, day))
  monday.setUTCDate(monday.getUTCDate() - (isoDay(date) - 1))
  return monday.toISOString().slice(0, 10)
}

export function isTaskDueOnDate(task: any, date: string) {
  const { day } = dateParts(date)
  if (isTestCleaningDay && task.frequency === 'cleaning_day') return true
  if (task.frequency === 'monthly') return task.monthly_day === day
  if (task.frequency === 'extraordinary') return false
  return Array.isArray(task.schedule_days) && task.schedule_days.includes(isoDay(date))
}

export function isCurrentRotation(task: any, rotationOrder: number | null | undefined, date: string) {
  if (task.assignment_mode !== 'rotating') return true
  if (!rotationOrder || !task.rotation_anchor_date) return false
  const current = dateParts(date)
  const anchor = dateParts(task.rotation_anchor_date)
  const elapsedDays = Math.floor((Date.UTC(current.year, current.month - 1, current.day) - Date.UTC(anchor.year, anchor.month - 1, anchor.day)) / 86_400_000)
  const interval = task.rotation_interval_weeks || 1
  const rotationWeek = Math.floor(Math.floor(elapsedDays / 7) / interval)
  const expectedOrder = ((rotationWeek % 2) + 2) % 2 + 1
  return rotationOrder === expectedOrder
}

function client() { if (!supabase) throw new Error('Supabase není nakonfigurovaný.') ; return supabase }
export const schoolRepository = {
  getSession: async (): Promise<Session | null> => (await client().auth.getSession()).data.session,
  onAuthChange: (callback: (session: Session | null) => void) => client().auth.onAuthStateChange((_event, session) => callback(session)),
  signInWithGoogle: async () => {
    const { error } = await client().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}${window.location.pathname}${window.location.search}` },
    })
    if (error) throw error
  },
  signOut: async () => { const { error } = await client().auth.signOut(); if (error) throw error },
  profile: async (id: string): Promise<Profile | null> => { const { data, error } = await client().from('profiles').select('id,full_name,role,active').eq('id', id).maybeSingle(); if (error) throw error; return data as Profile | null },
  tasks: async (profile: Profile): Promise<Task[]> => {
    const db = client(); const date = today(); const planningDate = effectivePlanningDate(date)
    const [{ data: rows, error }, { data: completions, error: completionError }, { data: workParts, error: workPartsError }] = await Promise.all([
      db.from('cleaning_tasks').select('id,name,frequency,requires_task_id,schedule_days,monthly_day,assignment_mode,rotation_anchor_date,rotation_interval_weeks,work_part_id,rooms(name),task_assignments(worker_id,rotation_order,profiles(full_name))').eq('active', true).order('sort_order'),
      db.from('cleaning_completions').select('task_id,completed').eq('completion_date', date),
      db.from('work_part_assignments').select('work_part_id').eq('worker_id', profile.id).eq('active', true)
    ])
    if (error || completionError || workPartsError) throw error ?? completionError ?? workPartsError
    const done = new Map((completions ?? []).map((completion: { task_id: string; completed: boolean }) => [completion.task_id, completion.completed]))
    const assignedWorkParts = new Set((workParts ?? []).map((assignment: { work_part_id: string }) => assignment.work_part_id))
    return (rows ?? [])
      .filter((row: any) => {
        if (profile.role === 'caretaker') return true
        if (row.assignment_mode === 'rotating' && !row.task_assignments?.some((assignment: any) => assignment.worker_id === profile.id && isCurrentRotation(row, assignment.rotation_order, planningDate))) return false
        if (row.work_part_id && assignedWorkParts.has(row.work_part_id)) return true
        return row.task_assignments?.some((assignment: any) => assignment.worker_id === profile.id)
      })
      .map((row: any) => {
        const ownAssignment = row.task_assignments?.find((assignment: any) => assignment.worker_id === profile.id)
        return { id: row.id, room: row.rooms?.name ?? 'Celá škola', title: row.name, frequency: frequency[row.frequency] ?? 'mimořádně', assignedTo: ownAssignment?.profiles?.full_name ?? (row.work_part_id ? 'moje pracovní část' : 'nepřiřazeno'), done: done.get(row.id) ?? false, prerequisite: row.requires_task_id, canComplete: true, dueToday: isTaskDueOnDate(row, planningDate) }
      })
  },
  setCompletion: async (taskId: string, workerId: string, completed: boolean) => {
    const { error } = await client().from('cleaning_completions').upsert({ completion_date: today(), task_id: taskId, worker_id: workerId, completed }, { onConflict: 'completion_date,task_id' }); if (error) throw error
  },
  attendance: async (workerId: string): Promise<Attendance[]> => { const month = `${today().slice(0, 7)}-01`; const { data, error } = await client().from('attendance').select('id,started_at,ended_at,attendance_date,note').eq('worker_id', workerId).gte('attendance_date', month).order('started_at', { ascending: false }); if (error) throw error; return (data ?? []).map((row: any) => ({ id: row.id, worker: '' as Worker, start: row.started_at, end: row.ended_at ?? undefined, date: row.attendance_date, type: 'směna' })) },
  startAttendance: async (workerId: string) => { const db = client(); const { data: building, error: buildingError } = await db.from('buildings').select('id').eq('name', 'Škola').single(); if (buildingError) throw buildingError; const { error } = await db.from('attendance').insert({ worker_id: workerId, building_id: building.id, attendance_date: today() }); if (error) throw error },
  finishAttendance: async (id: string) => { const { error } = await client().from('attendance').update({ ended_at: new Date().toISOString() }).eq('id', id); if (error) throw error },
  subscribe: (onChange: () => void): RealtimeChannel => client().channel('school-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'cleaning_completions' }, onChange).on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, onChange).subscribe()
}
