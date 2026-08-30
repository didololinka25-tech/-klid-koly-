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
const migration18TypeSql = readFileSync(new URL('../supabase/tests/01800_canonical_plan_types.sql', import.meta.url), 'utf8')
const migration19 = readFileSync(new URL('../supabase/migrations/20260830001900_final_departure_checks.sql', import.meta.url), 'utf8')
const migration20 = readFileSync(new URL('../supabase/migrations/20260830002000_cleaning_manual_and_staircase_windows.sql', import.meta.url), 'utf8')
const migration21 = readFileSync(new URL('../supabase/migrations/20260830002100_attendance_integrity.sql', import.meta.url), 'utf8')
const migration22 = readFileSync(new URL('../supabase/migrations/20260830002200_attendance_audit_history.sql', import.meta.url), 'utf8')
const migration23 = readFileSync(new URL('../supabase/migrations/20260830002300_kindergarten_workplace_and_plan.sql', import.meta.url), 'utf8')
const migration24 = readFileSync(new URL('../supabase/migrations/20260830002400_worker_contract_history.sql', import.meta.url), 'utf8')
const migration25 = readFileSync(new URL('../supabase/migrations/20260830002500_restore_missing_app_settings.sql', import.meta.url), 'utf8')
const settingsDiagnostics = readFileSync(new URL('../supabase/diagnostics/verify_02300_02400_state.sql', import.meta.url), 'utf8')
const attendanceRepair = readFileSync(new URL('../supabase/diagnostics/repair_attendance_d05aac53.sql', import.meta.url), 'utf8')

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
  assert.match(app, /const pending = pendingTaskIds\.has\(task\.id\)[\s\S]*disabled=\{!task\.canComplete \|\| pending\}/)
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

test('oprava docházky aktualizuje přesné ID a nikdy nevytváří nový řádek', () => {
  const updateBlock = repository.match(/updateAttendance:[\s\S]*?deleteAttendance:/)?.[0] ?? ''
  assert.match(updateBlock, /from\('attendance'\)\.update\(values\)\.eq\('id', id\)/)
  assert.match(updateBlock, /\.select\('id'\)\.single\(\)/)
  assert.doesNotMatch(updateBlock, /\.insert\(/)
})

test('databáze odvozuje pracovní datum v Praze a odmítá překryv bez změny historie', () => {
  assert.match(migration21, /new\.attendance_date := \(new\.started_at at time zone 'Europe\/Prague'\)::date/i)
  assert.match(migration21, /tstzrange\(existing\.started_at[\s\S]*&& tstzrange\(new\.started_at/i)
  assert.match(migration21, /pg_advisory_xact_lock/)
  assert.match(migration21, /errcode = '23P01'/)
  assert.doesNotMatch(migration21, /delete\s+from|update\s+public\.attendance/i)
})

test('audit docházky ukládá neměnné původní i nové hodnoty a čte jej pouze admin', () => {
  assert.match(migration22, /old_attendance_date[\s\S]*old_started_at[\s\S]*old_ended_at/i)
  assert.match(migration22, /new_attendance_date[\s\S]*new_started_at[\s\S]*new_ended_at/i)
  assert.match(migration22, /changed_by[\s\S]*changed_at/i)
  assert.match(migration22, /after update of attendance_date, started_at, ended_at/i)
  assert.match(migration22, /using \(public\.is_admin\(\)\)/i)
  assert.match(migration22, /revoke all on public\.attendance_audit from anon, authenticated/i)
  assert.doesNotMatch(migration22, /grant (insert|update|delete)/i)
  assert.match(repository, /attendanceAudit:[\s\S]*from\('attendance_audit'\)/)
  assert.match(app, /Historie změn směny/)
})

test('Školka je nedestruktivní úterní plán bez A/B a dezinfekce', () => {
  for (const room of ['Kuchyň', 'Vstup', 'Šatna', 'WC dívky', 'WC chlapci', 'WC dospělí', 'Úklidová místnost', 'Chodbička', 'Místnost 1', 'Místnost 2', 'Místnost 3 – spací']) assert.match(migration23, new RegExp(room, 'i'))
  assert.match(migration23, /schedule_days[\s\S]*array\[2\]::smallint\[\]/i)
  assert.match(migration23, /requires_task_id = vacuum\.id/i)
  assert.match(migration23, /43 aktivních úkolů/i)
  assert.doesNotMatch(migration23, /delete\s+from|truncate\s+|drop\s+table/i)
  assert.match(migration23, /work_part_id=null/i)
  assert.match(migration23, /activity_type='disinfect' or work_part_id is not null/i)
  assert.doesNotMatch(migration23, /'disinfect'\s*,\s*\d+\s*,/i)
})

test('historie DPP/DPČ je bez seedu neznámých dat a zapisuje se jen admin RPC', () => {
  assert.match(migration24, /create table if not exists public\.worker_contracts/i)
  assert.match(migration24, /contract_type in \('dpp','dpc','other'\)/i)
  assert.match(migration24, /valid_from date not null[\s\S]*valid_to date/i)
  assert.match(migration24, /workers read own contracts[\s\S]*worker_id=auth\.uid\(\)/i)
  assert.match(migration24, /if not public\.is_admin\(\)/i)
  assert.match(migration24, /admin_save_worker_contract/i)
  assert.match(migration24, /Pracovní vztah se překrývá/i)
  assert.doesNotMatch(migration24, /insert into public\.worker_contracts[\s\S]*select[\s\S]*from public\.profiles/i)
  assert.doesNotMatch(migration24, /delete\s+from|truncate\s+/i)
})

test('jednorázová oprava chrání přesný UUID a očekávaný stav v jednom atomickém bloku', () => {
  assert.match(attendanceRepair, /target_id constant uuid := 'd05aac53-d33f-4ba9-bb43-b91f128e586e'/i)
  assert.match(attendanceRepair, /attendance_date = date '2026-08-30'/i)
  assert.match(attendanceRepair, /2026-08-30 09:00:00 Europe\/Prague/i)
  assert.match(attendanceRepair, /2026-08-30 12:06:00 Europe\/Prague/i)
  assert.match(attendanceRepair, /2026-08-29 14:01:28 Europe\/Prague/i)
  assert.match(attendanceRepair, /2026-08-29 18:30:00 Europe\/Prague/i)
  assert.match(attendanceRepair, /get diagnostics changed_count = row_count[\s\S]*changed_count <> 1/i)
  assert.doesNotMatch(attendanceRepair, /delete\s+from/i)
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
  assert.doesNotMatch(migration18, /delete\s+from|truncate\s+|drop\s+table/i)
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

test('01800 používá jediný CTE seed a žádnou pomocnou relation', () => {
  assert.doesNotMatch(migration18, /desired_cleaning_plan|_migration_01800_desired_cleaning_plan/i)
  assert.doesNotMatch(migration18, /create\s+(temporary|temp)\s+table|create\s+table\s+.*migration_01800/i)
  assert.match(migration18, /with canonical_plan\([\s\S]*?\) as \([\s\S]*?insert into public\.cleaning_tasks/i)
  const seedStatement = migration18.match(/with canonical_plan\([\s\S]*?on conflict \(plan_key\)[\s\S]*?period_anchor_month = excluded\.period_anchor_month;/i)?.[0] ?? ''
  const cteBeforeInsert = seedStatement
    .slice(0, seedStatement.indexOf('insert into public.cleaning_tasks'))
    .replace(/--.*$/gm, '')
  assert.doesNotMatch(cteBeforeInsert, /;/)
  assert.match(migration18, /prerequisite\.plan_key = regexp_replace\(task\.plan_key, '\[\^\|\]\+\$', 'vacuum'\)/i)
  const safetyBlock = migration18.match(/-- Bezpečnostní kontrola výsledku seedu\.[\s\S]*?\n\$\$;/i)?.[0] ?? ''
  assert.doesNotMatch(safetyBlock, /canonical_plan/i)
  assert.match(safetyBlock, /from public\.cleaning_tasks[\s\S]*plan_key like 'v2026\|%'/i)
  assert.match(safetyBlock, /<> 217/i)
  assert.match(safetyBlock, /cleaning_cycle_length,task\.cleaning_cycle_offset/i)
  assert.equal((migration18.match(/^begin;$/gim) ?? []).length, 1)
  assert.equal((migration18.match(/^commit;$/gim) ?? []).length, 1)
  assert.match(migration18.trim(), /commit;$/i)
})

test('01800 kotví všech 12 canonical_plan typů před UNION větvemi', () => {
  assert.match(migration18, /select\s+null::text, null::text, null::text, null::text, null::text, null::text,\s+null::smallint\[\], null::integer, null::smallint, null::smallint,\s+null::date, null::text\s+where false\s+union all/i)
  assert.equal((migration18.match(/activity_type::text, frequency::text, schedule_days::smallint\[\],/gi) ?? []).length, 9)
  assert.equal((migration18.match(/sort_order::integer, period_months::smallint, period_week::smallint,/gi) ?? []).length, 9)
  assert.equal((migration18.match(/period_anchor_month::date, requires_code::text/gi) ?? []).length, 9)
  assert.match(migration18TypeSql, /pg_typeof\(schedule_days\)::text/i)
  assert.match(migration18TypeSql, /'smallint\[\]', 'integer', 'smallint', 'smallint', 'date', 'text'/i)
  assert.match(migration18TypeSql.trim(), /rollback;$/i)
})

test('závěrečná kontrola je sdílený canonical checklist bez A/B', () => {
  for (const key of ['final-close-windows', 'final-check-doors', 'final-trash', 'final-laundry']) {
    assert.match(migration19, new RegExp(`v2026\\|school\\|common\\|${key}`))
  }
  for (const item of ['Zavřít všechna okna', 'Zavřít / zkontrolovat dveře', 'Vynést odpadky', 'Posbírat použité hadry na vyprání']) {
    assert.match(migration19, new RegExp(item))
  }
  assert.doesNotMatch(migration19, /final-(soap|tools|windows)(?:'|,)/)
  assert.match(migration19, /on conflict \(plan_key\)/i)
  assert.match(migration19, /'cleaning_day'.*'\{1,3,5\}'::smallint\[\]/i)
  assert.doesNotMatch(migration19, /delete\s+from|truncate\s+|drop\s+table/i)
  assert.match(app, /Před odchodem ze školy/)
  assert.match(app, /isFinalCheckTask/)
})

test('Dnes ukazuje názvy činností, progress a stav dependency', () => {
  assert.match(app, /role="progressbar"/)
  assert.match(app, /Všechno hotovo – můžete odejít/)
  assert.match(app, /<b>\{task\.title\}<\/b>/)
  assert.match(app, /Nejdříve předchozí činnost/)
  assert.match(app, /await schoolRepository\.setCompletion[\s\S]*setTasks/)
})

test('Manuál je databázově řízený, soft-delete a chráněný rolemi', () => {
  assert.match(migration20, /create table if not exists public\.manual_entries/i)
  assert.match(migration20, /alter table public\.manual_entries enable row level security/i)
  assert.match(migration20, /public\.can_view_school_data\(\) and \(active or public\.is_admin\(\)\)/i)
  assert.match(migration20, /create policy "admins create manual"[\s\S]*public\.is_admin\(\)/i)
  assert.match(migration20, /create policy "admins update manual"[\s\S]*public\.is_admin\(\)/i)
  assert.doesNotMatch(migration20, /create policy[^;]+for delete/i)
  assert.match(migration20, /revoke delete on public\.manual_entries from authenticated/i)
  assert.doesNotMatch(migration20, /delete\s+from\s+public\.manual_entries|truncate\s+public\.manual_entries/i)
  assert.match(repository, /from\('manual_entries'\)[\s\S]*missingRelation/)
  for (const action of ['Spravovat', '+ Návod', '+ Praktická informace', '+ Připomínka po příchodu']) assert.match(app, new RegExp(action.replace('+', '\\+')))
})

test('jeden návod se mapuje na více úkolů přes activity category', () => {
  assert.match(migration20, /activity_types text\[\]/i)
  assert.match(app, /item\.activityTypes\.includes\(task\.activityType\)/)
  assert.match(app, /ⓘ Návod/)
  assert.match(app, /Co potřebuji[\s\S]*Jak postupovat[\s\S]*Na co si dát pozor[\s\S]*Poznámka školy/)
})

test('praktické informace a příchod jsou editovatelné bez deploye', () => {
  for (const text of ['Modrý pytel · 60 l', 'Žlutý pytel · 35 l', 'Bílý pytel · 25 l', 'Bílý pytel · 10 l', 'Okna a zrcadla', 'Záchody / WC', 'Otevřít okna podle počasí']) assert.match(migration20, new RegExp(text))
  assert.match(app, /entryType === "practical"/)
  assert.match(app, /entryType === "arrival"/)
  assert.match(app, /type="color"/)
})

test('okna schodiště jsou týdenní ve stejný den jako ostatní schodiště', () => {
  assert.match(migration20, /plan_key = 'v2026\|Schodiště\|Schodiště\|windows'/)
  assert.match(migration20, /set frequency = 'weekly', schedule_days = '\{5\}'::smallint\[\]/i)
  assert.match(migration20, /period_months = null, period_week = null/i)
  assert.doesNotMatch(migration20, /delete\s+from|truncate\s+/i)
})

test('admin může spravovat patra a závěrečné kontroly bez SQL', () => {
  assert.match(repository, /saveFloor:/)
  assert.match(app, /\+ Přidat patro \/ sekci/)
  assert.match(app, /\+ Přidat kontrolu před odchodem/)
  assert.match(repository, /task\.planKey\?\.startsWith\('admin\|final\|'\)/)
})

test('frontend načte rozšířený plán jedním dotazem a umí bezpečný fallback před migrací', () => {
  assert.match(repository, /cleaning_cycle_length,cleaning_cycle_offset,period_months,period_week,period_anchor_month/)
  assert.match(repository, /missingColumn/)
  assert.match(app, /dueTasksForDate/)
  assert.match(app, /isTaskDueForCleaningDay\(taskScheduleInput\(task\), context\)/)
  assert.match(app, /monthGridDates\(month\)/)
})

test('02500 obnoví app_settings bez přepsání existujícího DPP limitu', () => {
  assert.match(migration25, /create table if not exists public\.app_settings/i)
  assert.match(migration25, /dpp_annual_limit_hours numeric\(7,2\)[\s\S]*default 300/i)
  assert.match(migration25, /insert into public\.app_settings[\s\S]*select true, 300[\s\S]*where not exists/i)
  assert.doesNotMatch(migration25, /on conflict[\s\S]*do update|set\s+dpp_annual_limit_hours\s*=\s*300/i)
  assert.doesNotMatch(migration25, /delete\s+from|truncate\s+|drop\s+table/i)
})

test('02500 zachová RLS a dovolí zápis nastavení jen adminským RPC', () => {
  assert.match(migration25, /alter table public\.app_settings enable row level security/i)
  assert.match(migration25, /using \(public\.can_view_school_data\(\)\)/i)
  assert.match(migration25, /revoke all on public\.app_settings from anon, authenticated/i)
  assert.match(migration25, /grant select on public\.app_settings to authenticated/i)
  assert.match(migration25, /if not public\.is_admin\(\)/i)
  assert.match(migration25, /security definer[\s\S]*set search_path = public, pg_temp/i)
  assert.match(migration25, /revoke all on function public\.set_dpp_annual_limit\(numeric\) from public, anon, authenticated/i)
})

test('02500 je atomická a připraví přesný základ pro následnou 02400', () => {
  assert.equal((migration25.match(/^begin;$/gim) ?? []).length, 1)
  assert.equal((migration25.match(/^commit;$/gim) ?? []).length, 1)
  assert.match(migration25.trim(), /commit;$/i)
  for (const column of ['id', 'dpp_annual_limit_hours', 'updated_at', 'updated_by']) {
    assert.match(migration25, new RegExp(`add column if not exists ${column}|${column} boolean primary key`, 'i'))
  }
  assert.match(migration24, /begin;[\s\S]*alter table public\.app_settings[\s\S]*commit;\s*$/i)
})

test('diagnostika 02300 a rollbacku 02400 je pouze čtecí', () => {
  assert.match(settingsDiagnostics, /active_kindergarten_rooms/)
  assert.match(settingsDiagnostics, /active_kindergarten_tasks/)
  assert.match(settingsDiagnostics, /to_regclass\('public\.worker_contracts'\)/)
  assert.match(settingsDiagnostics, /to_regprocedure\('public\.set_dpc_settings\(numeric,smallint\)'\)/)
  assert.doesNotMatch(settingsDiagnostics, /\b(insert|update|delete|alter|create|drop|truncate)\b/i)
})
