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
  assert.match(migration, /set active\s*=\s*false[\s\S]*activity_type\s*=\s*'laundry'/i)
  assert.match(migration, /room\.name\s*=\s*'Jídelna'[\s\S]*activity_type\s*=\s*'mirror'/i)
})

test('schválené frekvence používají splatnost bez pevné středy nebo pátku', () => {
  assert.match(migration, /activity_type\s*=\s*'windows'[\s\S]*period_months\s*=\s*3/i)
  assert.match(migration, /activity_type\s*=\s*'doors'[\s\S]*period_months\s*=\s*1/i)
  assert.match(migration, /period_months\s*=\s*2[\s\S]*room\.name\s*=\s*'Řadírna'/i)
  assert.match(migration, /cleaning_planner_occurrences/i)
  assert.match(migration, /best_school_shift_for_week/i)
  assert.match(migration, /get_dynamic_school_cleaning_plan/i)
  assert.doesNotMatch(migration, /každou středu|zůstává v pátek/i)
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

test('trigger rotace nekoliduje s PL/pgSQL OLD a NEW recordy', () => {
  const triggerFunction = migration.match(/create or replace function public\.enforce_cleaning_rotation_slot_unambiguous\(\)[\s\S]*?end \$\$;/i)?.[0] ?? ''
  assert.match(triggerFunction, /cleaning_rotation_slot_assignments existing_slot/i)
  assert.match(triggerFunction, /existing_slot\.rotation_key\s*=\s*new\.rotation_key/i)
  assert.doesNotMatch(triggerFunction, /\b(?:from|join)\s+public\.[a-z_]+\s+(?:old|new)\b/i)
  assert.doesNotMatch(migration, /\b(?:from|join)\s+public\.[a-z_]+\s+(?:old|new)\b/i)
})

test('Dnes i Kalendář čtou stejný serverový planner a před 03300 mají bezpečný fallback', () => {
  assert.match(repository, /get_dynamic_school_cleaning_plan/)
  assert.match(repository, /dynamicSchoolPlan/)
  assert.match(repository, /missingFunction\(result\.error\)[\s\S]*return null/)
  assert.match(app, /schoolRepository\.dynamicSchoolPlan/)
  assert.match(app, /serverPlanForCalendarDate\(date, records, serverDynamicPlan\)/)
  assert.match(app, /outsideSourceDates[\s\S]*dynamicSchoolPlan\(sourceDate, sourceDate\)/)
  assert.match(migration, /can_complete_task[\s\S]*get_dynamic_school_cleaning_plan/)
})

test('budoucí přepočet je auditovaný a přímý zápis do planneru ani auditu není povolen', () => {
  assert.match(migration, /cleaning_planner_schedule_audit/)
  assert.match(migration, /audit_dynamic_cleaning_schedule_change/)
  assert.match(migration, /invalidate_future_dynamic_cleaning_plan/)
  assert.match(migration, /not exists\(select 1 from public\.cleaning_completions/)
  assert.match(migration, /has_table_privilege\('authenticated','public\.cleaning_planner_occurrences','INSERT,UPDATE,DELETE'\)/)
  assert.match(migration, /has_table_privilege\('authenticated','public\.cleaning_planner_schedule_audit','INSERT,UPDATE,DELETE'\)/)
})

test('kapacita počítá weekly special, small a large společně a WC fronta má serverové pořadí', () => {
  assert.match(migration, /case scheduled\.work_size when 'large' then 2 else 1 end/)
  assert.match(migration, /load_units\+1<=least\(public\.school_worker_count_for_date\(candidate\),3\)/)
  assert.match(migration, /load_units\+2<=least\(public\.school_worker_count_for_date\(candidate\),3\)/)
  assert.match(migration, /shift\.load_units\+1>least\(shift\.worker_count,3\)[\s\S]*shift\.worker_count desc,shift\.load_units,shift\.day/)
  assert.match(migration, /planner_priority integer/)
  assert.match(migration, /task\.floor_sort\*10000\+task\.room_sort\*100\+task\.sort_order/)
  assert.match(repository, /plannerPriority: dynamicSchoolRows\?\.get\(row\.id\)\?\.planner_priority/)
  assert.match(app, /WC jsou otevřená fronta, ne povinnost dokončit všechna/)
  assert.match(app, /task\.plannerPriority/)
})
