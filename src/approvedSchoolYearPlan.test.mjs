import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/migrations/20260901003300_approved_school_year_plan_and_fourth_floor_rotation.sql', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

test('03300 je atomická, nedestruktivní a nemění historické migrace', () => {
  assert.match(migration, /^begin;/i)
  assert.match(migration, /commit;\s*$/i)
  assert.doesNotMatch(migration, /delete\s+from|truncate|drop\s+table/i)
  assert.match(migration, /set active = false[\s\S]*activity_type = 'laundry'/i)
  assert.match(migration, /room\.name = 'Jídelna'[\s\S]*activity_type = 'mirror'/i)
})

test('schválené frekvence jsou zapsané bez A\/B work parts', () => {
  assert.match(migration, /activity_type = 'tables'[\s\S]*array\[3\]/i)
  assert.match(migration, /floor\.name = 'Schodiště'[\s\S]*array\[5\]/i)
  assert.match(migration, /activity_type = 'windows'[\s\S]*period_months = 3/i)
  assert.match(migration, /activity_type = 'doors'[\s\S]*period_months = 1/i)
  assert.match(migration, /period_week = 3[\s\S]*activity_type = 'tiles'/i)
  assert.match(migration, /period_months = 2[\s\S]*room\.name = 'Řadírna'/i)
  assert.doesNotMatch(migration, /work_part|task_assignment/i)
})

test('rotace používá UUID, RLS a admin RPC; frontend ji skutečně načítá a ukládá', () => {
  assert.match(migration, /anchor_date[\s\S]*date '2026-09-04'/i)
  assert.match(migration, /worker_id uuid references public\.profiles\(id\)/i)
  assert.match(migration, /enable row level security/i)
  assert.match(migration, /if not public\.is_admin\(\)/i)
  assert.doesNotMatch(migration, /full_name\s*=/i)
  assert.match(repository, /rotation_definitions/)
  assert.match(repository, /admin_set_cleaning_rotation_slot/)
  assert.match(app, /ROTACE 4\. PATRA/)
  assert.match(app, /Pracovník<select/)
})
