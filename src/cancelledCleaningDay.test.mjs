import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCalendarDaySummary, calendarPrintDay } from './cleaningCalendar.ts'
import { isTaskDueForCleaningDay, resolveCleaningDay } from './scheduling.ts'

const schoolFriday = { id: 'school-task', frequency: 'cleaning_day', schedule_days: [5] }
const kindergartenFriday = { id: 'kindergarten-task', frequency: 'cleaning_day', schedule_days: [5] }
const cancellation = {
  id: 'cancel-school', buildingId: 'school', buildingName: 'Škola',
  kind: 'cancelled_standard', executionDate: '2026-09-04',
  title: 'Úklid zrušen', note: 'Škola se dnes neuklízí.', status: 'active',
}

test('zrušení běžného dne je omezené na konkrétní pracoviště a obnovení vrátí standardní plán', () => {
  const schoolContext = resolveCleaningDay('2026-09-04', [cancellation])
  const kindergartenContext = resolveCleaningDay('2026-09-04', [])
  assert.equal(schoolContext.kind, 'cancelled')
  assert.equal(isTaskDueForCleaningDay(schoolFriday, schoolContext), false)
  assert.equal(isTaskDueForCleaningDay(kindergartenFriday, kindergartenContext), true)

  const restoredContext = resolveCleaningDay('2026-09-04', [{ ...cancellation, status: 'cancelled' }])
  assert.equal(restoredContext.kind, 'standard')
  assert.equal(isTaskDueForCleaningDay(schoolFriday, restoredContext), true)
})

test('kalendář a tisk rozliší zrušenou Školu od aktivní Školky', () => {
  const kindergartenTask = {
    id: 'kg-task', task: 'Vytřít', activityType: 'mop', frequency: 'cleaning_day',
    scheduleDays: [5], monthlyDay: null, cleaningCycleLength: null, cleaningCycleOffset: null,
    periodMonths: null, periodWeek: null, periodAnchorMonth: null, buildingId: 'kg',
    building: 'Školka', floor: 'Prostory', roomId: 'kg-room', room: 'Kuchyň',
    active: true, roomActive: true, done: false, completedBy: null, completedAt: null,
  }
  const summary = buildCalendarDaySummary({
    date: '2026-09-04', today: '2026-09-04', tasks: [kindergartenTask],
    context: resolveCleaningDay('2026-09-04', []), exceptions: [cancellation],
  })
  assert.deepEqual(summary.workplaces.map((item) => item.name), ['Školka'])
  assert.deepEqual(summary.cancelledWorkplaces.map((item) => item.buildingName), ['Škola'])
  const printable = calendarPrintDay(summary)
  assert.equal(printable.hasWork, true)
  assert.deepEqual(printable.cancellations, [{ building: 'Škola', note: 'Škola se dnes neuklízí.' }])
  assert.deepEqual(printable.workplaces, ['Školka'])
})

test('03900 je atomická, nedestruktivní a přesouvá planner occurrences mimo zrušený den', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260904003900_cancel_standard_cleaning_by_workplace.sql', import.meta.url), 'utf8')
  assert.match(sql, /^--[\s\S]*\nbegin;/i)
  assert.match(sql, /commit;\s*$/i)
  assert.match(sql, /cancelled_standard/)
  assert.match(sql, /create or replace function public\.save_cancelled_standard_cleaning_day/)
  assert.match(sql, /create or replace function public\.restore_cancelled_standard_cleaning_day/)
  assert.match(sql, /public\.is_standard_cleaning_cancelled\(building\.id, occurrence\.scheduled_for\)/)
  assert.match(sql, /public\.school_worker_count_for_date\(series\.day_value::date\) > 0/)
  assert.match(sql, /set scheduled_for = null,[\s\S]*assigned_planning_worker_id = null/)
  assert.doesNotMatch(sql, /^\s*delete\s+from\s+public\.cleaning_completions\b/im)
  assert.doesNotMatch(sql, /^\s*update\s+public\.cleaning_completions\b/im)
  assert.doesNotMatch(sql, /^\s*insert\s+into\s+public\.cleaning_completions\b/im)
})

test('UI nabízí zrušení i obnovení a rozlišuje Dnes, detail, tisk a mobilní ovládání', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(app, /Zrušit úklid na tomto pracovišti/)
  assert.match(app, /Dnešní úklid pracoviště/)
  assert.match(app, /Obnovit úklid/)
  assert.match(app, /calendar-print-cancelled/)
  assert.match(repository, /save_cancelled_standard_cleaning_day/)
  assert.match(repository, /restore_cancelled_standard_cleaning_day/)
  assert.match(css, /calendar-cancellation-actions[\s\S]*min-height:\s*44px/)
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*calendar-cancellation-actions/)
})
