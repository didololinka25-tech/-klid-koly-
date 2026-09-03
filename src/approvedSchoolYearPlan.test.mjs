import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/migrations/20260901003300_approved_school_year_plan_and_fourth_floor_rotation.sql', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const todayBlocks = readFileSync(new URL('./todayWorkBlocks.ts', import.meta.url), 'utf8')

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

test('periodické změny 03300 jsou omezené na Školu a zachovají odchodové kontroly', () => {
  const schoolScopes = migration.match(/building\.name\s*=\s*'Škola'/g) ?? []
  assert.ok(schoolScopes.length >= 10, 'Každá periodická větev i závěrečný assertion musí být scoped na Školu.')
  assert.match(migration, /plan_key\s*=\s*'v2026\|school\|common\|laundry'/i)
  assert.match(migration, /plan_key\s*=\s*'v2026\|school\|common\|final-close-windows'[\s\S]*frequency\s*=\s*'cleaning_day'/i)
  assert.match(migration, /plan_key\s*=\s*'v2026\|school\|common\|final-laundry'[\s\S]*frequency\s*=\s*'cleaning_day'/i)
  assert.doesNotMatch(migration, /where active and plan_key like 'v2026\|%' and activity_type='laundry'/i)
  assert.doesNotMatch(migration, /from public\.cleaning_tasks where active and plan_key like 'v2026\|%' and activity_type='windows'/i)
})

test('rotace používá UUID, RLS a admin RPC; frontend ji skutečně načítá a ukládá', () => {
  assert.match(migration, /anchor_date[\s\S]*date '2026-09-04'/i)
  assert.match(migration, /worker_id uuid references public\.profiles\(id\)/i)
  assert.match(migration, /enable row level security/i)
  assert.match(migration, /if not public\.is_admin\(\)/i)
  assert.doesNotMatch(migration, /full_name\s*=/i)
  assert.match(repository, /rotation_definitions/)
  assert.match(repository, /admin_set_cleaning_rotation_planning_worker_slot/)
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

test('03300 používá jednoznačné generate_series aliasy a PostgreSQL kompatibilní UUID agregaci', () => {
  assert.match(migration, /as generated_slot\(slot_number\)/i)
  assert.match(migration, /as generated_day\(plan_timestamp\)/i)
  assert.match(migration, /as generated_week\(week_timestamp\)/i)
  assert.match(migration, /as generated_month\(month_timestamp\)/i)
  assert.match(migration, /select candidate_shift\.plan_day[\s\S]*as candidate_shift/i)
  assert.doesNotMatch(migration, /\bselect\s+day::date\s+day\b/i)
  assert.doesNotMatch(migration, /\bfrom\s+generate_series\([^\n]+\)\s+(?:day|week|month|old|new)\b/i)
  assert.doesNotMatch(migration, /\bmin\(o\.id\)/i)
  assert.match(migration, /min\(o\.id::text\)::uuid as stable_id/i)
})

test('03300 sama obsahuje finální dvoučlennou rotaci a neponechává schody ani 4F na pevném dni', () => {
  const rotation = migration.match(/create or replace function public\.school_rotating_floor_for_date[\s\S]*?\$\$;/i)?.[0] ?? ''
  assert.match(rotation, /school_worker_count_for_date\([^)]+\)\s*=\s*2/i)
  assert.doesNotMatch(rotation, /school_worker_count_for_date\([^)]+\)\s*>=\s*2/i)
  assert.match(migration, /floor\.name in \('Schodiště','4\. patro'\)[\s\S]*schedule_days is distinct from array\[1,2,3,4,5,6,7\]/i)
  assert.match(migration, /Schodiště ani 4\. patro nesmí mít pevný pracovní den\./)
})

test('Dnes i Kalendář čtou stejný serverový planner a Kalendář nezamění loading/chybu za starý plán', () => {
  assert.match(repository, /get_dynamic_school_cleaning_plan/)
  assert.match(repository, /dynamicSchoolPlan/)
  assert.match(repository, /missingFunction\(result\.error\)[\s\S]*return null/)
  assert.match(app, /schoolRepository\.dynamicSchoolPlan/)
  assert.match(app, /serverPlanForCalendarDate\(date, records, serverDynamicPlan\)/)
  assert.match(app, /outsideSourceDates[\s\S]*dynamicSchoolPlan\(sourceDate, sourceDate\)/)
  assert.match(app, /plannerStatus === "ready" \? plannedTasksForDate[\s\S]*: \[\]/)
  assert.match(app, /setPlannerStatus\("error"\)/)
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
  assert.match(migration, /candidate_shift\.load_units\+1>least\(candidate_shift\.worker_count,3\)[\s\S]*candidate_shift\.worker_count desc,candidate_shift\.load_units,candidate_shift\.plan_day/)
  assert.match(migration, /planner_priority integer/)
  assert.match(migration, /task\.floor_sort\*10000\+task\.room_sort\*100\+task\.sort_order/)
  assert.match(repository, /plannerPriority: dynamicSchoolRows\?\.get\(row\.id\)\?\.planner_priority/)
  assert.match(app, /WC – otevřená fronta/)
  assert.match(app, /Postupujte od 1\. patra nahoru\. Udělejte podle času\./)
  assert.match(todayBlocks, /task\.plannerPriority/)
})
