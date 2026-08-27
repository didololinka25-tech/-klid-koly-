import type { RealtimeChannel, Session } from '@supabase/supabase-js'
import type { Attendance, Task, Worker } from './types'
import { supabase } from './supabase'

export type Profile = { id: string; full_name: Worker; role: 'cleaner' | 'caretaker'; active: boolean }
const today = () => new Date().toISOString().slice(0, 10)
const frequency: Record<string, Task['frequency']> = { cleaning_day: 'denně', weekly: 'týdně', once_or_twice_weekly: '1–2× týdně', monthly: 'měsíčně', extraordinary: 'mimořádně' }

function client() { if (!supabase) throw new Error('Supabase není nakonfigurovaný.') ; return supabase }
export const schoolRepository = {
  getSession: async (): Promise<Session | null> => (await client().auth.getSession()).data.session,
  onAuthChange: (callback: (session: Session | null) => void) => client().auth.onAuthStateChange((_event, session) => callback(session)),
  signInWithGoogle: async () => {
    const { error } = await client().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (error) throw error
  },
  signOut: async () => { const { error } = await client().auth.signOut(); if (error) throw error },
  profile: async (id: string): Promise<Profile | null> => { const { data, error } = await client().from('profiles').select('id,full_name,role,active').eq('id', id).maybeSingle(); if (error) throw error; return data as Profile | null },
  tasks: async (profile: Profile): Promise<Task[]> => {
    const db = client(); const date = today()
    const [{ data: rows, error }, { data: completions, error: completionError }] = await Promise.all([
      db.from('cleaning_tasks').select('id,name,frequency,requires_task_id,rooms(name),task_assignments(worker_id,profiles(full_name))').eq('active', true).order('sort_order'),
      db.from('cleaning_completions').select('task_id,completed').eq('completion_date', date)
    ])
    if (error || completionError) throw error ?? completionError
    const done = new Map((completions ?? []).map((completion: { task_id: string; completed: boolean }) => [completion.task_id, completion.completed]))
    return (rows ?? []).map((row: any) => ({ id: row.id, room: row.rooms?.name ?? 'Celá škola', title: row.name, frequency: frequency[row.frequency] ?? 'mimořádně', assignedTo: row.task_assignments?.[0]?.profiles?.full_name ?? 'nepřiřazeno', done: done.get(row.id) ?? false, prerequisite: row.requires_task_id, canComplete: profile.role === 'caretaker' || Boolean(row.task_assignments?.length) }))
  },
  setCompletion: async (taskId: string, workerId: string, completed: boolean) => {
    const { error } = await client().from('cleaning_completions').upsert({ completion_date: today(), task_id: taskId, worker_id: workerId, completed }, { onConflict: 'completion_date,task_id' }); if (error) throw error
  },
  attendance: async (workerId: string): Promise<Attendance[]> => { const month = `${today().slice(0, 7)}-01`; const { data, error } = await client().from('attendance').select('id,started_at,ended_at,attendance_date,note').eq('worker_id', workerId).gte('attendance_date', month).order('started_at', { ascending: false }); if (error) throw error; return (data ?? []).map((row: any) => ({ id: row.id, worker: '' as Worker, start: row.started_at, end: row.ended_at ?? undefined, date: row.attendance_date, type: 'směna' })) },
  startAttendance: async (workerId: string) => { const db = client(); const { data: building, error: buildingError } = await db.from('buildings').select('id').eq('name', 'Škola').single(); if (buildingError) throw buildingError; const { error } = await db.from('attendance').insert({ worker_id: workerId, building_id: building.id, attendance_date: today() }); if (error) throw error },
  finishAttendance: async (id: string) => { const { error } = await client().from('attendance').update({ ended_at: new Date().toISOString() }).eq('id', id); if (error) throw error },
  subscribe: (onChange: () => void): RealtimeChannel => client().channel('school-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'cleaning_completions' }, onChange).on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, onChange).subscribe()
}
