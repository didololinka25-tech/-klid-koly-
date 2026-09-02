import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/migrations/20260902003400_planning_workers_without_accounts.sql', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

test('03400 je atomická, nedestruktivní a zachovává profilové UUID při backfillu', () => {
  assert.match(migration, /^--[^\n]*\nbegin;/i)
  assert.match(migration, /commit;\s*$/i)
  assert.match(migration, /insert into public\.planning_workers\(id,display_name,linked_profile_id[\s\S]*select profile\.id[\s\S]*profile\.id,true/)
  assert.match(migration, /update public\.worker_work_assignments set planning_worker_id=worker_id/)
  assert.match(migration, /update public\.worker_schedule_exceptions set planning_worker_id=worker_id/)
  assert.doesNotMatch(migration, /delete\s+from|truncate\s|drop\s+table/i)
  assert.match(migration, /Nejprve spusťte celou migraci 03300 dynamického planneru\./)
  assert.match(migration, /03300 neobsahuje finální rotaci posouvanou pouze dvoučlennými směnami\./)
})

test('plánovací pracovník může existovat bez účtu, ale zápis je pouze admin RPC', () => {
  assert.match(migration, /linked_profile_id uuid references public\.profiles\(id\)/)
  assert.doesNotMatch(migration, /linked_profile_id uuid not null/)
  assert.match(migration, /planning_workers enable row level security/)
  assert.match(migration, /if not public\.is_admin\(\) then raise exception/)
  assert.match(migration, /revoke all on public\.planning_workers from anon,authenticated/)
  assert.match(migration, /grant select on public\.planning_workers to authenticated/)
  assert.match(migration, /created_by,updated_by\)[\s\S]*auth\.uid\(\),auth\.uid\(\)/)
})

test('planner počítá planning_worker_id jednou a rotaci posouvá jen přesně dvoučlenná směna', () => {
  const counter = migration.slice(migration.indexOf('create or replace function public.school_worker_count_for_date'), migration.indexOf('create or replace function public.school_rotating_floor_for_date'))
  const rotation = migration.slice(migration.indexOf('create or replace function public.school_rotating_floor_for_date'), migration.indexOf('create or replace function public.get_worker_work_planning'))
  assert.match(counter, /count\(distinct planning_worker_id\)/)
  assert.match(counter, /join public\.planning_workers worker/)
  assert.doesNotMatch(counter, /count\(distinct worker_id\)/)
  assert.match(rotation, /school_worker_count_for_date\([^)]+\)=2/)
  assert.doesNotMatch(rotation, />=2/)
})

test('frontend spravuje planning workers a completion identitu nemění', () => {
  assert.match(repository, /admin_save_planning_worker/)
  assert.match(repository, /target_planning_worker_id/)
  assert.match(app, /Přidat pracovníka/)
  assert.match(app, /Bez účtu/)
  assert.match(app, /Propojit s uživatelem aplikace/)
  assert.doesNotMatch(migration, /update\s+public\.cleaning_completions|insert\s+into\s+public\.cleaning_completions/i)
})

test('4F slot ukládá stabilní planning worker ID a zachovává starou profilovou stopu jen jako kompatibilní vazbu', () => {
  assert.match(migration, /admin_set_cleaning_rotation_planning_worker_slot/)
  assert.match(migration, /planning_worker_id=target_planning_worker_id/)
  assert.match(migration, /'worker_id',slot\.planning_worker_id/)
  assert.match(migration, /'worker_name',worker\.display_name/)
})
