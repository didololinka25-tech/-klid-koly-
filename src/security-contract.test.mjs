import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
const types = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
const migration12 = readFileSync(new URL('../supabase/migrations/20260828001200_remove_disinfect_and_ab_windows.sql', import.meta.url), 'utf8')
const migration13 = readFileSync(new URL('../supabase/migrations/20260829001300_cleaning_day_exceptions.sql', import.meta.url), 'utf8')

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
