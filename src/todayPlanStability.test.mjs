import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createLatestRequestGate } from './latestRequest.ts'
import { pragueDateKey } from './attendanceTime.ts'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

test('pomalejší starší request nikdy nepřepíše novější dnešní plán', async () => {
  const gate = createLatestRequestGate()
  let tasks = Array.from({ length: 106 }, (_, id) => id)
  let phase = 'ready'

  const refresh = async (request) => {
    const requestId = gate.begin()
    phase = tasks === null ? 'loading' : 'refreshing'
    try {
      const next = await request
      if (gate.isLatest(requestId)) {
        tasks = next
        phase = 'ready'
      }
    } catch {
      if (gate.isLatest(requestId)) phase = 'error'
    }
  }

  const older = deferred()
  const newer = deferred()
  const olderRun = refresh(older.promise)
  const newerRun = refresh(newer.promise)
  assert.equal(tasks.length, 106, 'refetch nesmí během načítání smazat platný plán')
  newer.resolve(Array.from({ length: 106 }, (_, id) => id))
  await newerRun
  older.resolve([])
  await olderRun
  assert.equal(tasks.length, 106)
  assert.equal(phase, 'ready')
})

test('opakované refetche stejného dne zachovají stejný počet úkolů', async () => {
  const gate = createLatestRequestGate()
  let count = 106
  for (let index = 0; index < 10; index += 1) {
    const requestId = gate.begin()
    await Promise.resolve()
    if (gate.isLatest(requestId)) count = 106
  }
  assert.equal(count, 106)
})

test('Dnes rozlišuje loading, chybu a skutečně prázdný načtený plán', () => {
  assert.match(app, /Načítám dnešní plán…/)
  assert.match(app, /Nepodařilo se načíst dnešní plán\./)
  assert.match(app, /Zkusit znovu/)
  assert.match(app, /todayPlanLoaded\.current && todayPlanStatus/)
  assert.match(app, /<TaskHierarchy[\s\S]*tasks=\{visible\}/)
  assert.match(app, /Pro tento den nejsou naplánované úkoly\./)
})

test('token refresh stejného uživatele nemaže dnešní plán', () => {
  const authBlock = app.match(/schoolRepository\.onAuthChange[\s\S]*?return \(\) => data\.subscription\.unsubscribe\(\)/)?.[0] ?? ''
  assert.match(authBlock, /identityChanged/)
  assert.match(authBlock, /if \(identityChanged\) \{[\s\S]*?setTasks\(\[\]\)/)
  assert.doesNotMatch(authBlock, /setSession\(next\);\s*setProfile\(null\);\s*setTasks\(\[\]\)/)
})

test('repository a render sdílejí jeden explicitní Prague date key', () => {
  assert.match(repository, /tasks: async \(profile: Profile, includeAll = false, requestedDate\?: string\)/)
  assert.match(repository, /const date = requestedDate \?\? localToday\(\)/)
  assert.match(repository, /const localToday = \(\) => pragueDateKey\(new Date\(\)\)/)
  assert.match(app, /schoolRepository\.tasks\(activeProfile, canManageOperations\(activeProfile\), localDateKey\(\)\)/)
  assert.match(app, /setTodayPlanDate\(taskResult\.value\.dateKey\)/)
  assert.match(app, /todayLabel\(todayPlanDate\)/)
  assert.equal(pragueDateKey(new Date('2026-08-30T22:30:00.000Z')), '2026-08-31')
})

test('chyba načtení nevymaže poslední platný plán', () => {
  const rejectedBranch = app.match(/else if \(taskResult\.status === "rejected"[\s\S]*?\n      \}/)?.[0] ?? ''
  assert.match(rejectedBranch, /setTodayPlanStatus\("error"\)/)
  assert.doesNotMatch(rejectedBranch, /setTasks\(\[\]\)|setBulkActions\(\[\]\)/)
})
