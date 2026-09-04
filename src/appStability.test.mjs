import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  appHistoryState,
  refreshAreasForRealtimeTable,
  shouldReloadIdentity,
  shouldRunResumeRefresh,
  withAppHistoryState,
} from './appStability.ts'

test('TOKEN_REFRESHED stejného uživatele nevyžaduje plné načtení aplikace', () => {
  assert.equal(shouldReloadIdentity('worker-1', 'worker-1'), false)
  assert.equal(shouldReloadIdentity('worker-1', 'worker-2'), true)
  assert.equal(shouldReloadIdentity('worker-1', null), true)
})

test('focus a visibilitychange v krátkém sledu spustí nejvýše jeden refresh', () => {
  const first = 100_000
  assert.equal(shouldRunResumeRefresh(0, first), true)
  assert.equal(shouldRunResumeRefresh(first, first + 50), false)
  assert.equal(shouldRunResumeRefresh(first, first + 25_000), true)
})

test('realtime události obnovují jen svou datovou oblast', () => {
  assert.deepEqual(refreshAreasForRealtimeTable('cleaning_completions'), ['today'])
  assert.deepEqual(refreshAreasForRealtimeTable('attendance'), ['attendance'])
  assert.deepEqual(refreshAreasForRealtimeTable('cleaning_day_exceptions'), ['cleaning-days', 'today'])
  assert.deepEqual(refreshAreasForRealtimeTable('incidents'), ['operations'])
  assert.deepEqual(refreshAreasForRealtimeTable('manual_entries'), ['manual'])
  assert.deepEqual(refreshAreasForRealtimeTable('worker_work_assignments'), ['worker-planning', 'today'])
  assert.deepEqual(refreshAreasForRealtimeTable('rooms'), ['plan-options', 'today'])
})

test('navigační stav zachová cizí browser state a rozliší vrstvu od sekce', () => {
  const state = withAppHistoryState({ external: 7 }, { section: 'Kalendář', layer: 'calendar-day-detail', token: 'day-1' })
  assert.equal(state.external, 7)
  assert.deepEqual(appHistoryState(state), { section: 'Kalendář', layer: 'calendar-day-detail', token: 'day-1' })
  assert.deepEqual(appHistoryState(null), {})
})

test('App napojuje Back na detail dne, manuál a detail pracovníka', async () => {
  const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
  assert.match(source, /useHistoryLayer\(dayDetailOpen, "calendar-day-detail"/)
  assert.match(source, /onClose=\{closeDayDetail\}/)
  assert.match(source, /useHistoryLayer\(schoolOpeningManualOpen, "school-opening-manual"/)
  assert.match(source, /useHistoryLayer\(Boolean\(selectedWorkerId\), "worker-detail"/)
  assert.match(source, /window\.addEventListener\("popstate"/)
})

test('běžné runtime události nevolají plné load ani neskrývají dnešní obsah', async () => {
  const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
  const realtimeEffect = source.slice(source.indexOf('const channel = schoolRepository.subscribe'), source.indexOf('useEffect(() => {', source.indexOf('const channel = schoolRepository.subscribe') + 1))
  assert.doesNotMatch(realtimeEffect, /\bload\(/)
  assert.match(realtimeEffect, /refreshTodaySilently/)

  const resumeEffect = source.slice(source.indexOf('const refreshInBackground ='), source.indexOf('useEffect(() => {', source.indexOf('const refreshInBackground =') + 1))
  assert.doesNotMatch(resumeEffect, /\bload\(/)
  assert.match(resumeEffect, /shouldRunResumeRefresh/)
  assert.match(resumeEffect, /Promise\.allSettled/)

  const silentToday = source.slice(source.indexOf('const refreshTodaySilently'), source.indexOf('const refreshAttendanceSilently'))
  assert.doesNotMatch(silentToday, /setTodayPlanStatus\("loading"\)|setTasks\(\[\]\)/)
})
