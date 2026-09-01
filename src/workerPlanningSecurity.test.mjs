import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/migrations/20260901003100_worker_work_planning.sql', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

test('03100 je transakční, historická, nedestruktivní a nechává RLS zapnuté', () => {
  assert.match(migration, /^begin;/i)
  assert.match(migration, /commit;\s*$/i)
  assert.match(migration, /valid_from date not null/)
  assert.match(migration, /valid_to date/)
  assert.match(migration, /worker_work_assignments enable row level security/)
  assert.match(migration, /worker_schedule_exceptions enable row level security/)
  assert.doesNotMatch(migration, /delete\s+from|truncate|drop\s+table/i)
})

test('plán čtou schválení uživatelé, ale měnit jej může pouze admin přes RPC', () => {
  assert.match(migration, /for select to authenticated using \(public\.can_view_school_data\(\)\)/)
  assert.match(migration, /if not public\.is_admin\(\) then raise exception/)
  assert.match(migration, /revoke insert, update, delete on public\.worker_work_assignments, public\.worker_schedule_exceptions from anon, authenticated/)
  assert.match(migration, /auth\.uid\(\)/)
  assert.doesNotMatch(migration, /full_name\s*=|email\s*=/)
})

test('frontend používá UUID a RPC, ne task assignment nebo jméno jako identitu', () => {
  assert.match(repository, /rpc\('get_worker_work_planning'/)
  assert.match(repository, /rpc\('admin_save_worker_work_assignment'/)
  assert.match(repository, /rpc\('admin_save_worker_schedule_exception'/)
  assert.match(app, /workerId/)
  const planningSlice = app.slice(app.indexOf('function WorkAssignmentOverview'), app.indexOf('function MoreScreen'))
  assert.doesNotMatch(planningSlice, /task_assignments|work_part|assignedTo/)
})
