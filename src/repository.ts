/** Přechodová lokální implementace. Později ji nahradí Supabase/Firebase adapter. */
import type { Task } from './types'
const key = 'uklid-skoly.tasks.v1'
export const taskRepository = {
  load: (): Task[] => { try { return JSON.parse(localStorage.getItem(key) ?? '') } catch { return [] } },
  save: (tasks: Task[]) => localStorage.setItem(key, JSON.stringify(tasks))
}
// Budoucí CalendarProvider bude před vytvářením plánů vracet kolize školních akcí.
