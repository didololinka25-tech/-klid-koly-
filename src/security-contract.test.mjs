import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
const types = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
const migration12 = readFileSync(new URL('../supabase/migrations/20260828001200_remove_disinfect_and_ab_windows.sql', import.meta.url), 'utf8')
const migration13 = readFileSync(new URL('../supabase/migrations/20260829001300_cleaning_day_exceptions.sql', import.meta.url), 'utf8')
const migration14 = readFileSync(new URL('../supabase/migrations/20260829001400_extraordinary_cleaning_tasks.sql', import.meta.url), 'utf8')
const migration15 = readFileSync(new URL('../supabase/migrations/20260829001500_simple_operations_lists.sql', import.meta.url), 'utf8')

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
