import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDynamicSchoolPlan } from './dynamicSchoolPlanLoader.ts'

const row = (taskId, scheduledDate, priority = 1) => ({
  task_id: taskId,
  scheduled_date: scheduledDate,
  plan_reason: 'routine',
  due_from: scheduledDate,
  due_to: scheduledDate,
  assigned_worker_id: null,
  planner_priority: priority,
})

test('více chunků se načítá sekvenčně a správně sloučí', async () => {
  const calls = []
  let active = 0
  let maximumConcurrency = 0
  const result = await loadDynamicSchoolPlan({
    from: '2026-09-01',
    to: '2026-09-14',
    sleep: async () => {},
    loadChunk: async (from, to) => {
      calls.push([from, to])
      active += 1
      maximumConcurrency = Math.max(maximumConcurrency, active)
      await Promise.resolve()
      active -= 1
      return { data: [row(`task-${calls.length}`, from)], error: null }
    },
  })
  assert.deepEqual(calls, [
    ['2026-09-01', '2026-09-07'],
    ['2026-09-08', '2026-09-14'],
  ])
  assert.equal(maximumConcurrency, 1)
  assert.equal(result?.size, 2)
})

test('dočasné selhání jednoho chunku se po dvou retry zotaví', async () => {
  let attempts = 0
  const waits = []
  const result = await loadDynamicSchoolPlan({
    from: '2026-09-07', to: '2026-09-07',
    sleep: async (milliseconds) => { waits.push(milliseconds) },
    loadChunk: async () => {
      attempts += 1
      return attempts < 3
        ? { data: null, error: { code: 'NETWORK', message: 'temporary' } }
        : { data: [row('task-ok', '2026-09-07')], error: null }
    },
  })
  assert.equal(attempts, 3)
  assert.deepEqual(waits, [300, 800])
  assert.equal(result?.get('2026-09-07')?.has('task-ok'), true)
})

test('trvalé opakované selhání po retry vyhodí chybu a zaloguje jen bezpečný kontext', async () => {
  let attempts = 0
  const logs = []
  await assert.rejects(() => loadDynamicSchoolPlan({
    from: '2026-09-07', to: '2026-09-07',
    sleep: async () => {},
    logError: (message, context) => logs.push({ message, context }),
    loadChunk: async () => {
      attempts += 1
      return { data: null, error: { code: 'NETWORK', message: 'connection lost' } }
    },
  }), (error) => error.code === 'NETWORK')
  assert.equal(attempts, 3)
  assert.deepEqual(logs, [{
    message: 'Část plánu úklidu se nepodařilo načíst.',
    context: { from: '2026-09-07', to: '2026-09-07', code: 'NETWORK', message: 'connection lost' },
  }])
  assert.deepEqual(Object.keys(logs[0].context).sort(), ['code', 'from', 'message', 'to'])
})

test('missingFunction vrátí null bez retry', async () => {
  let attempts = 0
  const result = await loadDynamicSchoolPlan({
    from: '2026-09-07', to: '2026-09-07',
    sleep: async () => { throw new Error('sleep se nesmí volat') },
    loadChunk: async () => {
      attempts += 1
      return { data: null, error: { code: 'PGRST202', message: 'function missing' } }
    },
  })
  assert.equal(result, null)
  assert.equal(attempts, 1)
})

test('chunk s 1000 řádky stále vyhodí bezpečnostní chybu', async () => {
  await assert.rejects(() => loadDynamicSchoolPlan({
    from: '2026-09-07', to: '2026-09-07',
    loadChunk: async () => ({ data: Array.from({ length: 1000 }, (_, index) => row(`task-${index}`, '2026-09-07')), error: null }),
  }), /překročil bezpečný limit/)
})

test('sloučení nevytváří duplicitní tasky', async () => {
  const result = await loadDynamicSchoolPlan({
    from: '2026-09-07', to: '2026-09-07',
    loadChunk: async () => ({ data: [row('same-task', '2026-09-07', 1), row('same-task', '2026-09-07', 2)], error: null }),
  })
  assert.equal(result?.get('2026-09-07')?.size, 1)
  assert.equal(result?.get('2026-09-07')?.get('same-task')?.plannerPriority, 2)
})
