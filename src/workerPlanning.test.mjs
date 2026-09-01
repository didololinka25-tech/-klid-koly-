import test from 'node:test'
import assert from 'node:assert/strict'
import { assignmentAppliesInMonth, assignmentOverlapsMonth, scheduleExceptionsConflict, stableWorkerColor, workAssignmentsConflict, workerInitials, workersForDate } from './workerPlanning.ts'

const assignment = (overrides = {}) => ({
  id: 'assignment-1', workerId: 'worker-dana', workerName: 'Dana Nováková',
  buildingId: 'school', buildingName: 'Škola', floorId: 'floor-1', floorName: '1. patro',
  areaLabel: '1. patro', weekdays: [1, 3, 5], validFrom: '2026-09-01', validTo: null, active: true,
  ...overrides,
})

const planning = (assignments, exceptions = []) => ({ assignments, exceptions, available: true })

test('historické rozdělení respektuje dny, platnost a více pracovníků i pracovišť', () => {
  const data = planning([
    assignment({ validTo: '2026-09-30' }),
    assignment({ id: 'martina', workerId: 'worker-martina', workerName: 'Martina', areaLabel: '2. patro', weekdays: [1, 5] }),
    assignment({ id: 'dana-new', areaLabel: '3. patro', validFrom: '2026-10-01', weekdays: [1, 3, 5] }),
    assignment({ id: 'kindergarten', workerId: 'worker-iva', workerName: 'Iva', buildingId: 'kg', buildingName: 'Školka', floorId: null, floorName: null, areaLabel: 'Prostory', weekdays: [2] }),
  ])
  assert.deepEqual(workersForDate('2026-09-02', data).map((item) => item.areaLabel), ['1. patro'])
  assert.deepEqual(workersForDate('2026-09-04', data).map((item) => item.workerName), ['Dana Nováková', 'Martina'])
  assert.deepEqual(workersForDate('2026-09-01', data).map((item) => item.buildingName), ['Školka'])
  assert.deepEqual(workersForDate('2026-10-02', data).filter((item) => item.workerId === 'worker-dana').map((item) => item.areaLabel), ['3. patro'])
})

test('nové období nemění minulý měsíc a přehled měsíce používá průnik platnosti', () => {
  const september = assignment({ validTo: '2026-09-30' })
  const october = assignment({ id: 'october', areaLabel: '3. patro', validFrom: '2026-10-01' })
  assert.equal(assignmentAppliesInMonth(september, '2026-09'), true)
  assert.equal(assignmentAppliesInMonth(september, '2026-10'), false)
  assert.equal(assignmentAppliesInMonth(october, '2026-09'), false)
  assert.equal(assignmentAppliesInMonth(october, '2026-10'), true)
  assert.equal(assignmentOverlapsMonth({ ...september, active: false }, '2026-09'), true)
  assert.equal(assignmentAppliesInMonth({ ...september, active: false }, '2026-09'), false)
})

test('výjimka nahrazuje pravidelný den, umí absenci i jiné pracoviště', () => {
  const base = assignment()
  const absent = { id: 'absence', workerId: base.workerId, workerName: base.workerName, date: '2026-09-02', planned: false, note: 'Volno', active: true }
  assert.deepEqual(workersForDate('2026-09-02', planning([base], [absent])), [])
  const moved = { ...absent, id: 'moved', planned: true, buildingId: 'kg', buildingName: 'Školka', areaLabel: 'Prostory', note: 'Zástup' }
  const result = workersForDate('2026-09-02', planning([base], [moved]))
  assert.equal(result.length, 1)
  assert.equal(result[0].buildingName, 'Školka')
  assert.equal(result[0].exception, true)
})

test('iniciály a barva pracovníka jsou stabilní a jméno slouží jen k zobrazení', () => {
  assert.equal(workerInitials('Dana Nováková'), 'DN')
  assert.equal(stableWorkerColor('same-user-id'), stableWorkerColor('same-user-id'))
  assert.ok(stableWorkerColor('same-user-id') >= 0 && stableWorkerColor('same-user-id') < 6)
})

test('navazující pracovní období projdou a historický kalendář zůstane jednoznačný', () => {
  const september = assignment({ id: 'september', validFrom: '2026-09-01', validTo: '2026-09-30' })
  const october = assignment({ id: 'october', areaLabel: '2. patro', validFrom: '2026-10-01', validTo: null })
  assert.equal(workAssignmentsConflict(september, october), false)
  const data = planning([september, october])
  assert.deepEqual(workersForDate('2026-09-30', data).map((item) => item.areaLabel), ['1. patro'])
  assert.deepEqual(workersForDate('2026-10-02', data).map((item) => item.areaLabel), ['2. patro'])
})

test('překrývající se aktivní období stejného pracovníka a dne se odmítne', () => {
  const first = assignment({ id: 'first', validFrom: '2026-09-01', validTo: '2026-09-30' })
  const overlapping = assignment({ id: 'second', validFrom: '2026-09-15', validTo: '2026-10-31', areaLabel: '2. patro' })
  assert.equal(workAssignmentsConflict(first, overlapping), true)
  assert.equal(workAssignmentsConflict(first, { ...first }), false, 'editace stejného ID se nesmí blokovat')
  assert.equal(workAssignmentsConflict(first, { ...overlapping, weekdays: [2, 4] }), false, 'různé pracovní dny mohou mít jinou oblast')
  assert.equal(workAssignmentsConflict(first, { ...overlapping, active: false }), false)
})

test('pro pracovníka a datum je nejvýše jedna aktivní výjimka', () => {
  const first = { id: 'first', workerId: 'worker-dana', workerName: 'Dana', date: '2026-09-09', planned: false, note: '', active: true }
  const second = { ...first, id: 'second', planned: true, buildingId: 'school', buildingName: 'Škola' }
  assert.equal(scheduleExceptionsConflict(first, first), false, 'editace stejného záznamu projde')
  assert.equal(scheduleExceptionsConflict(first, { ...second, date: '2026-09-10' }), false, 'jediná výjimka pro jiné datum projde')
  assert.equal(scheduleExceptionsConflict(first, second), true)
  assert.equal(scheduleExceptionsConflict({ ...first, active: false }, second), false, 'deaktivovaná historie neblokuje novou výjimku')
})
