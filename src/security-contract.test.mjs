import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
const types = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
const migration12 = readFileSync(new URL('../supabase/migrations/20260828001200_remove_disinfect_and_ab_windows.sql', import.meta.url), 'utf8')
const migration11 = readFileSync(new URL('../supabase/migrations/20260828001100_team_cleaning_and_access_roles.sql', import.meta.url), 'utf8')
const migration13 = readFileSync(new URL('../supabase/migrations/20260829001300_cleaning_day_exceptions.sql', import.meta.url), 'utf8')
const migration14 = readFileSync(new URL('../supabase/migrations/20260829001400_extraordinary_cleaning_tasks.sql', import.meta.url), 'utf8')
const migration15 = readFileSync(new URL('../supabase/migrations/20260829001500_simple_operations_lists.sql', import.meta.url), 'utf8')
const migration16 = readFileSync(new URL('../supabase/migrations/20260829001600_profile_and_attendance_settings.sql', import.meta.url), 'utf8')
const migration17 = readFileSync(new URL('../supabase/migrations/20260829001700_soft_delete_cleaning_plan.sql', import.meta.url), 'utf8')

test('produktové UI neobsahuje A/B ani work-part ovládání', () => {
  assert.doesNotMatch(`${app}\n${types}`, /část\s+[ab]|a\/b|work.?part|rotation_anchor|rotation_interval/i)
})

test('editor nenabízí dezinfekci a repository ji obranně skryje', () => {
  assert.doesNotMatch(types, /'disinfect'/)
  assert.match(repository, /row\.activity_type === 'disinfect'/)
  assert.match(migration12, /where activity_type = 'disinfect'/)
})

test('shared měsíční Mytí oken zůstává právě jedna aktivní položka', () => {
  assert.match(migration12, /Společný měsíční úkol Mytí oken není právě jeden/)
  assert.match(migration12, /work_part_id = null/)
})

test('completion používá secure RPC a preview vypíná zápis', () => {
  assert.match(repository, /rpc\('set_cleaning_task_completion'/)
  assert.doesNotMatch(repository, /from\('cleaning_completions'\)\.upsert/)
  assert.match(repository, /canComplete: canWork\(profile\) && !isTestCleaningDay/)
})

test('úklidové výjimky čte schválený uživatel, mění pouze admin a DELETE není povolen', () => {
  assert.match(migration13, /using \(public\.can_view_school_data\(\)\)/)
  assert.match(migration13, /with check \(public\.is_admin\(\)\)/)
  assert.match(migration13, /revoke delete on public\.cleaning_day_exceptions from authenticated/)
  assert.doesNotMatch(migration13, /^delete\s+from/im)
})

test('serverová completion validace rozlišuje source a execution date', () => {
  assert.match(migration13, /moved\.source_date = target_date/)
  assert.match(migration13, /exception\.execution_date = target_date/)
  assert.match(migration13, /is_cleaning_task_scheduled_on\(target_task_id, exception\.source_date\)/)
  assert.match(migration13, /public\.can_work_in_app\(\)/)
})

test('pending badge je omezený na ownera', () => {
  assert.match(app, /const pendingCount = profile\.is_owner/)
  assert.match(app, /profile\.is_owner && pendingCount > 0/)
})

test('výběr mimořádných tasků zapisuje pouze adminské RPC a RLS zůstává aktivní', () => {
  assert.match(migration14, /alter table public\.cleaning_day_exception_tasks enable row level security/)
  assert.match(migration14, /not public\.is_admin\(\)/)
  assert.match(migration14, /revoke insert, update, delete on public\.cleaning_day_exception_tasks from authenticated/)
  assert.match(repository, /rpc\('save_extraordinary_cleaning_day'/)
})

test('server ověřuje explicitní členství tasku a chrání completion i dependency', () => {
  assert.match(migration14, /is_task_in_extraordinary_cleaning_day\(exception\.id, target_task_id\)/)
  assert.match(migration14, /Již dokončený úkol nelze z mimořádného úklidu odebrat/)
  assert.match(migration14, /Vybraný úkol postrádá povinnou předchozí činnost/)
  assert.match(migration14, /prerequisite_completion\.completion_date = target_date/)
  assert.doesNotMatch(migration14, /insert into public\.cleaning_tasks/i)
})

test('cleaning team nemá zapisovací policy pro výběr mimořádných tasků', () => {
  assert.doesNotMatch(migration14, /for (insert|update|delete) to authenticated[\s\S]*can_work_in_app/i)
  assert.match(migration14, /grant execute on function public\.set_extraordinary_cleaning_tasks\(uuid, uuid\[\]\)[\s\S]*to authenticated/)
})

test('Provoz zachovává RLS: tým vytváří a opravuje vlastní záznamy, admin všechny', () => {
  assert.match(migration15, /created_by = auth\.uid\(\)/)
  assert.match(migration15, /worker_id = auth\.uid\(\)/)
  assert.match(migration15, /using \(public\.is_admin\(\)\)/)
  assert.match(migration15, /using \(public\.can_view_school_data\(\)\)/)
  assert.match(migration15, /revoke delete on public\.stock_items, public\.incidents from authenticated/)
  assert.doesNotMatch(migration15, /^delete\s+from/im)
})

test('migrace Provozu skryje legacy katalog a dovolí opakovaný nákup stejného názvu', () => {
  assert.match(migration15, /set active = false\s+where created_by is null/i)
  assert.match(migration15, /drop constraint if exists stock_items_name_key/i)
  assert.doesNotMatch(migration15, /delete from public\.stock_items/i)
})

test('kritické mobilní zápisy jsou chráněné proti opakovanému klepnutí', () => {
  assert.match(app, /taskWriteLocks\.current\.has\(id\)/)
  assert.match(app, /attendanceWriteLock\.current/)
  assert.match(app, /disabled=\{saving\}/)
  assert.match(app, /disabled=\{!task\.canComplete \|\| pendingTaskIds\.has\(task\.id\)\}/)
  assert.match(app, /mutationLock\.current/)
})

test('vlastní jméno se mění pouze podle auth.uid a nemění autorizaci', () => {
  assert.match(migration16, /where id = auth\.uid\(\) and active/i)
  assert.match(migration16, /update_own_profile_name/)
  assert.doesNotMatch(migration16, /where\s+full_name\s*=/i)
  assert.doesNotMatch(migration16, /set\s+access_role[\s\S]*update_own_profile_name/i)
  assert.match(repository, /rpc\('update_own_profile_name'/)
})

test('globální DPP limit čtou schválení uživatelé a mění pouze admin', () => {
  assert.match(migration16, /using \(public\.can_view_school_data\(\)\)/)
  assert.match(migration16, /if not public\.is_admin\(\)/)
  assert.match(migration16, /revoke all on public\.app_settings from anon, authenticated/)
  assert.match(migration16, /grant select on public\.app_settings to authenticated/)
})

test('visitor ani pending nezískají cizí attendance data', () => {
  assert.match(migration11, /team reads attendance[\s\S]*public\.can_work_in_app\(\)[\s\S]*worker_id = auth\.uid\(\) or public\.is_admin\(\)/i)
  assert.match(app, /if \(canWork\(activeProfile\)\)/)
  assert.doesNotMatch(repository, /full_name.*attendance|attendance.*full_name/i)
})

test('docházka a report používají building_id bez vytváření paralelní historie', () => {
  assert.match(repository, /building_id,started_at,ended_at,attendance_date/)
  assert.match(repository, /buildingName: building\?\.name \?\? 'Škola'/)
  assert.doesNotMatch(migration16, /create table.*attendance/is)
  assert.doesNotMatch(migration16, /delete\s+from/i)
})

test('soft delete úkolu zachovává historii a chrání aktivní dependency', () => {
  assert.match(migration17, /update public\.cleaning_tasks\s+set active = target_active/i)
  assert.match(migration17, /dependent\.requires_task_id = target_task_id[\s\S]*dependent\.active/i)
  assert.match(migration17, /Nejprve deaktivujte navazující úkoly/i)
  assert.doesNotMatch(migration17, /delete\s+from\s+public\.(cleaning_tasks|cleaning_completions)/i)
  assert.match(repository, /rpc\('set_cleaning_task_active'/)
})

test('soft delete místnosti atomicky vypne úkoly a obnova je nezapne', () => {
  const deleteRoom = migration17.match(/create or replace function public\.soft_delete_cleaning_room[\s\S]*?\$\$;/i)?.[0] ?? ''
  const restoreRoom = migration17.match(/create or replace function public\.restore_cleaning_room[\s\S]*?\$\$;/i)?.[0] ?? ''
  assert.match(deleteRoom, /update public\.cleaning_tasks[\s\S]*set active = false[\s\S]*room_id = target_room_id/i)
  assert.match(deleteRoom, /update public\.rooms[\s\S]*set active = false/i)
  assert.match(restoreRoom, /update public\.rooms[\s\S]*set active = true/i)
  assert.doesNotMatch(restoreRoom, /update public\.cleaning_tasks/i)
  assert.doesNotMatch(migration17, /delete\s+from/i)
})

test('mazání plánu je jen pro admina podle serverové role a RLS zůstává', () => {
  assert.match(migration17, /if not public\.is_admin\(\)/i)
  assert.match(migration17, /security definer[\s\S]*set search_path = public/i)
  assert.match(migration17, /revoke all on function public\.soft_delete_cleaning_room\(uuid\) from public, anon, authenticated/i)
  assert.match(migration11, /admins manage rooms[\s\S]*public\.is_admin\(\)/i)
  assert.match(migration11, /admins manage tasks[\s\S]*public\.is_admin\(\)/i)
})

test('admin UI odděluje neaktivní položky a používá potvrzení', () => {
  assert.match(app, /Neaktivní \/ smazané/)
  assert.match(app, /Smazat úkol/)
  assert.match(app, /Smazat místnost/)
  assert.match(app, /window\.confirm/)
  assert.match(app, /Obnoví se pouze místnost/)
})
