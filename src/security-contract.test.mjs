import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
const types = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
const migration8 = readFileSync(new URL('../supabase/migrations/20260828000800_cleaning_activity_types.sql', import.meta.url), 'utf8')
const migration12 = readFileSync(new URL('../supabase/migrations/20260828001200_remove_disinfect_and_ab_windows.sql', import.meta.url), 'utf8')
const migration11 = readFileSync(new URL('../supabase/migrations/20260828001100_team_cleaning_and_access_roles.sql', import.meta.url), 'utf8')
const migration13 = readFileSync(new URL('../supabase/migrations/20260829001300_cleaning_day_exceptions.sql', import.meta.url), 'utf8')
const migration14 = readFileSync(new URL('../supabase/migrations/20260829001400_extraordinary_cleaning_tasks.sql', import.meta.url), 'utf8')
const migration15 = readFileSync(new URL('../supabase/migrations/20260829001500_simple_operations_lists.sql', import.meta.url), 'utf8')
const migration16 = readFileSync(new URL('../supabase/migrations/20260829001600_profile_and_attendance_settings.sql', import.meta.url), 'utf8')
const migration17 = readFileSync(new URL('../supabase/migrations/20260829001700_soft_delete_cleaning_plan.sql', import.meta.url), 'utf8')
const migration18 = readFileSync(new URL('../supabase/migrations/20260829001800_real_school_plan_and_rotation.sql', import.meta.url), 'utf8')

test('produktové UI neobsahuje A/B ani work-part ovládání', () => {
  assert.doesNotMatch(`${app}\n${types}`, /část\s+[ab]|a\/b|work.?part|rotation_anchor|rotation_interval/i)
})

test('editor nenabízí dezinfekci a repository ji obranně skryje', () => {
  assert.doesNotMatch(types, /'disinfect'/)
  assert.match(repository, /row\.activity_type === 'disinfect'/)
  assert.match(migration12, /where activity_type = 'disinfect'/)
})

test('historický shared úkol oken zůstává zachovaný, ale neomezuje úkoly místností', () => {
  assert.match(migration12, /Společný měsíční úkol Mytí oken není právě jeden/)
  assert.match(migration12, /work_part_id = null/)
  assert.doesNotMatch(repository, /activity_type === 'windows'/)
  assert.doesNotMatch(repository, /name !== 'Mytí oken'/)
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

test('uložení plánu čeká na potvrzený INSERT a refetch před zavřením editoru', () => {
  const saveFlow = app.match(/const saveTask = async[\s\S]*?const setTaskActive/)?.[0] ?? ''
  assert.match(saveFlow, /const savedId = await schoolRepository\.saveTask/)
  assert.match(saveFlow, /await schoolRepository\.tasks\(profile, true\)/)
  assert.ok(saveFlow.indexOf('setTasks(refreshed.tasks)') < saveFlow.indexOf('setEditing(null)'))
  assert.match(repository, /if \(!result\.data\?\.id\)/)
})

test('chyba INSERTu ponechá editor otevřený, ukáže hlášku a dvojklik je uzamčený', () => {
  assert.match(app, /saveLock\.current/)
  assert.match(app, /setSaveError/)
  assert.match(app, /role="alert"/)
  assert.match(app, /disabled=\{saving\}/)
  assert.match(app, /setNotice\(message\);\s*throw error;/)
})

test('zápis úkolů zůstává pod admin RLS a dependency pole se ukládá', () => {
  assert.match(migration11, /admins manage tasks[\s\S]*public\.is_admin\(\)/i)
  assert.match(repository, /requires_task_id: task\.prerequisite \?\? null/)
  assert.match(repository, /schedule_days: task\.scheduleDays/)
})

test('nový plán je nedestruktivní, idempotentní a bez A/B či dezinfekce', () => {
  const withoutTemporaryCleanup = migration18.replace(/drop table(?: if exists)? public\._migration_01800_desired_cleaning_plan;/gi, '')
  assert.doesNotMatch(withoutTemporaryCleanup, /delete\s+from|truncate\s+|drop\s+table/i)
  assert.match(migration18, /set active = false/i)
  assert.match(migration18, /plan_key text/i)
  assert.match(migration18, /on conflict \(plan_key\)/i)
  assert.match(migration18, /activity_type = 'disinfect'/i)
  assert.match(migration18, /set active = false[\s\S]*task_assignments/i)
})

test('nový activity constraint přijímá všechny legitimní historické hodnoty', () => {
  const legacyConstraint = migration8.match(/check \(activity_type in \([\s\S]*?\)\)/i)?.[0] ?? ''
  const newConstraint = migration18.match(/add constraint cleaning_tasks_activity_type_valid check \([\s\S]*?\n\s*\);/i)?.[0] ?? ''
  const legacyValues = [...legacyConstraint.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  assert.deepEqual(legacyValues.sort(), [
    'disinfect', 'laundry', 'mirror', 'mop', 'other', 'sink', 'tables',
    'toilet', 'trash', 'vacuum', 'windows',
  ])
  for (const value of legacyValues) assert.match(newConstraint, new RegExp(`'${value}'`))
  assert.match(migration18, /where activity_type = 'disinfect' and active/i)
  assert.match(migration18, /where active and activity_type='disinfect'/i)
})

test('nový plán zakládá skutečné místnosti a chrání jejich historii', () => {
  for (const room of ['Učebna 1', 'Učebna 2', 'Učebna 3', 'Učebna 4', 'Učebna 5', 'WC / sprcha']) {
    assert.match(migration18, new RegExp(room.replace('/', '\\/'), 'i'))
  }
  assert.match(migration18, /přesně 32 aktivních místností/i)
  assert.match(migration18, /očekávaných 217 úkolů/i)
})

test('serverový scheduler ověřuje rotaci pater i periodické práce', () => {
  assert.match(migration18, /cleaning_cycle_length/i)
  assert.match(migration18, /cleaning_cycle_offset/i)
  assert.match(migration18, /period_months/i)
  assert.match(migration18, /period_week/i)
  assert.match(migration18, /create or replace function public\.is_cleaning_task_scheduled_on/i)
  assert.match(migration14, /is_cleaning_task_scheduled_on\(target_task_id, target_date\)/i)
})

test('01800 nepoužívá TEMP staging a finální kontroly čtou výsledná data', () => {
  assert.doesNotMatch(migration18, /\)\s+on\s+commit\s+drop\s*;/i)
  assert.doesNotMatch(migration18, /create\s+(temporary|temp)\s+table/i)
  assert.match(migration18, /create table public\._migration_01800_desired_cleaning_plan/i)
  const safetyBlock = migration18.match(/-- Bezpečnostní kontrola výsledku seedu\.[\s\S]*?\n\$\$;/i)?.[0] ?? ''
  assert.doesNotMatch(safetyBlock, /desired_cleaning_plan/i)
  assert.match(safetyBlock, /from public\.cleaning_tasks[\s\S]*plan_key like 'v2026\|%'/i)
  assert.match(safetyBlock, /<> 217/i)
  assert.match(safetyBlock, /cleaning_cycle_length,task\.cleaning_cycle_offset/i)
  const commitsBeforeCleanup = migration18.slice(0, migration18.lastIndexOf('drop table public._migration_01800_desired_cleaning_plan')).match(/\bcommit\s*;/gi) ?? []
  assert.equal(commitsBeforeCleanup.length, 0)
  assert.match(migration18.trim(), /drop table public\._migration_01800_desired_cleaning_plan;\s*\n\s*commit;$/i)
})

test('frontend načte rozšířený plán jedním dotazem a umí bezpečný fallback před migrací', () => {
  assert.match(repository, /cleaning_cycle_length,cleaning_cycle_offset,period_months,period_week,period_anchor_month/)
  assert.match(repository, /missingColumn/)
  assert.match(app, /dueTasksForDate/)
  assert.match(app, /isTaskDueForCleaningDay\(taskScheduleInput\(task\), context\)/)
  assert.match(app, /monthGridDates\(month\)/)
})
