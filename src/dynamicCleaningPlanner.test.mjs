import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDynamicSchoolPlan } from './dynamicCleaningPlanner.ts'

const task = (id, floor, room, activityType, overrides = {}) => ({
  id, roomId: `room-${floor}-${room}`, room, floorId: `floor-${floor}`, floor, floorSort: Number(floor[0]) || 9,
  buildingId: 'school', building: 'Škola', title: id, activityType, frequency: 'denně', assignedTo: 'Úklidový tým',
  done: false, dueToday: false, sortOrder: 1, scheduleDays: [1, 3, 5], active: true, roomActive: true,
  ...overrides,
})

const baseTasks = [
  task('1-vacuum', '1. patro', 'Chodba', 'vacuum'), task('1-mop', '1. patro', 'Chodba', 'mop'),
  task('2-vacuum', '2. patro', 'Chodba', 'vacuum'), task('2-mop', '2. patro', 'Chodba', 'mop'),
  task('3-vacuum', '3. patro', 'Chodba', 'vacuum'), task('3-mop', '3. patro', 'Chodba', 'mop'),
  task('wc1', '1. patro', 'WC dívky', 'toilet'), task('wc2', '2. patro', 'WC kluci', 'toilet'), task('wc3', '3. patro', 'WC holky', 'toilet'),
  task('stairs-vacuum', 'Schodiště', 'Schodiště', 'vacuum', { frequency: 'týdně' }),
  task('stairs-mop', 'Schodiště', 'Schodiště', 'mop', { frequency: 'týdně' }),
  task('four-vacuum', '4. patro', 'Chodba', 'vacuum', { frequency: 'týdně' }),
  task('tables', '1. patro', 'Jídelna', 'tables', { frequency: 'týdně' }),
  task('windows', '1. patro', 'Vstup', 'windows', { frequency: 'měsíčně', periodMonths: 3, periodWeek: 1, periodAnchorMonth: '2026-09-01' }),
]

const assignment = (workerId, weekdays, validFrom = '2026-08-31', validTo = null, workerName = workerId) => ({
  id: `${workerId}-${validFrom}`, workerId, workerName, buildingId: 'school', buildingName: 'Škola', floorId: null,
  areaLabel: 'Škola', weekdays, validFrom, validTo, active: true,
})
const planning = (assignments) => ({
  assignments, exceptions: [], available: true,
  rotationDefinitions: [{ rotationKey: 'school-fourth-floor', title: '4. patro', anchorDate: '2026-09-04', weekday: 0, slotCount: 3, active: true }],
  rotationSlots: [0, 1, 2].map((slotIndex) => ({ id: `slot-${slotIndex}`, rotationKey: 'school-fourth-floor', slotIndex, workerId: `uuid-${slotIndex}`, workerName: `Worker ${slotIndex}`, validFrom: '2026-09-01', validTo: null, active: true })),
})

test('1 pracovník dostane 1F podlahy a pokračující WC frontu, ale žádný large extra', () => {
  const plan = buildDynamicSchoolPlan({ startDate: '2026-09-07', endDate: '2026-09-07', tasks: baseTasks, planning: planning([assignment('solo', [1])]) }).get('2026-09-07')
  assert.ok(plan)
  assert.deepEqual(plan.tasks.filter((item) => item.reason === 'wc-queue').map((item) => item.task.id), ['wc1', 'wc2', 'wc3'])
  assert.equal(plan.tasks.filter((item) => item.reason === 'wc-queue').every((item) => item.size === 'routine'), true)
  assert.ok(plan.tasks.some((item) => item.task.id === '1-vacuum'))
  assert.equal(plan.tasks.some((item) => item.size === 'large'), false)
})

test('týden 1 → 2 → 3 pracovníci stupňuje povinný základ bez přetížení', () => {
  const data = planning([
    assignment('a', [1, 3, 5]),
    assignment('b', [3, 5]),
    assignment('c', [5]),
  ])
  const plan = buildDynamicSchoolPlan({ startDate: '2026-09-07', endDate: '2026-09-11', tasks: baseTasks, planning: data })
  assert.equal(plan.get('2026-09-07').workerCount, 1)
  assert.equal(plan.get('2026-09-09').workerCount, 2)
  assert.equal(plan.get('2026-09-11').workerCount, 3)
  assert.equal(plan.get('2026-09-07').tasks.some((item) => ['small', 'large'].includes(item.size)), false)
  assert.ok(plan.get('2026-09-09').tasks.some((item) => item.task.floor === plan.get('2026-09-09').rotatingFloor))
  assert.deepEqual([...new Set(plan.get('2026-09-11').tasks.filter((item) => item.size === 'routine' && item.task.activityType === 'vacuum').map((item) => item.task.floor))].sort(), ['1. patro', '2. patro', '3. patro'])
})

test('2 pracovníci střídají 2F/3F souvisle přes týden a měsíc', () => {
  const data = planning([assignment('a', [1, 3, 5]), assignment('b', [1, 3, 5])])
  const plan = buildDynamicSchoolPlan({ startDate: '2026-09-28', endDate: '2026-10-05', tasks: baseTasks, planning: data })
  const eligible = ['2026-09-28', '2026-09-30', '2026-10-02', '2026-10-05']
  assert.deepEqual(eligible.map((date) => plan.get(date)?.rotatingFloor), ['2. patro', '3. patro', '2. patro', '3. patro'])
  assert.ok(plan.get('2026-09-28').tasks.some((item) => item.task.floor === plan.get('2026-09-28').rotatingFloor))
})

test('3 pracovníci dostanou podlahy 1F/2F/3F a maximálně jednu velkou nebo dvě malé skupiny', () => {
  const data = planning([assignment('a', [1]), assignment('b', [1]), assignment('c', [1])])
  const day = buildDynamicSchoolPlan({ startDate: '2026-09-07', endDate: '2026-09-07', tasks: baseTasks, planning: data }).get('2026-09-07')
  assert.deepEqual([...new Set(day.tasks.filter((item) => item.size === 'routine' && item.task.activityType === 'vacuum').map((item) => item.task.floor))].sort(), ['1. patro', '2. patro', '3. patro'])
  const extras = new Set(day.tasks.filter((item) => ['small', 'large'].includes(item.size)).map((item) => item.groupKey))
  assert.ok(extras.size <= 2)
  assert.ok(!(day.tasks.some((item) => item.size === 'large') && extras.size > 1))
})

test('schodiště a 4. patro se zvolí jednou týdně na nejlepší směně i bez tří pracovníků', () => {
  const allTwo = planning([assignment('a', [1, 3, 5]), assignment('b', [1, 3, 5])])
  const plan = buildDynamicSchoolPlan({ startDate: '2026-09-07', endDate: '2026-09-13', tasks: baseTasks, planning: allTwo })
  assert.equal([...plan.values()].filter((day) => day.tasks.some((item) => item.task.floor === 'Schodiště')).length, 1)
  assert.equal([...plan.values()].filter((day) => day.tasks.some((item) => item.task.floor === '4. patro')).length, 1)
  assert.ok(plan.get('2026-09-07').tasks.some((item) => item.task.floor === 'Schodiště'), 'při shodné kapacitě vyhraje deterministicky první směna')
  assert.ok(plan.get('2026-09-09').tasks.some((item) => item.task.floor === '4. patro'), 'druhá týdenní práce se při stejné kapacitě rozloží na další směnu')

  const onlyFridayTwo = planning([assignment('a', [1, 3, 5]), assignment('b', [5])])
  const sparse = buildDynamicSchoolPlan({ startDate: '2026-09-07', endDate: '2026-09-13', tasks: baseTasks, planning: onlyFridayTwo })
  assert.ok(sparse.get('2026-09-11').tasks.some((item) => item.task.floor === 'Schodiště'))

  const deterministicThree = planning([assignment('a', [1, 3]), assignment('b', [1, 3]), assignment('c', [1, 3])])
  const best = buildDynamicSchoolPlan({ startDate: '2026-09-07', endDate: '2026-09-13', tasks: baseTasks, planning: deterministicThree })
  assert.ok(best.get('2026-09-07').tasks.some((item) => item.task.floor === 'Schodiště'), 'při dvou stejně silných směnách rozhodne dřívější datum')
})

test('dvě dvoučlenné směny rozloží schody, 4. patro a small extra bez nahromadění', () => {
  const data = planning([assignment('a', [1, 3]), assignment('b', [1, 3])])
  const plan = buildDynamicSchoolPlan({ startDate: '2026-09-07', endDate: '2026-09-13', tasks: baseTasks, planning: data })
  const mondayExtras = plan.get('2026-09-07').tasks.filter((item) => item.size !== 'routine')
  const wednesdayExtras = plan.get('2026-09-09').tasks.filter((item) => item.size !== 'routine')
  assert.ok(mondayExtras.length > 0 && wednesdayExtras.length > 0)
  assert.equal(mondayExtras.some((item) => item.task.floor === 'Schodiště') && mondayExtras.some((item) => item.task.floor === '4. patro'), false)
  assert.equal(wednesdayExtras.some((item) => item.task.floor === 'Schodiště') && wednesdayExtras.some((item) => item.task.floor === '4. patro'), false)
})

test('jediná dvoučlenná směna zachová schody i 4. patro a small extra nechá čekat', () => {
  const data = planning([assignment('a', [5]), assignment('b', [5])])
  const friday = buildDynamicSchoolPlan({ startDate: '2026-09-07', endDate: '2026-09-13', tasks: baseTasks, planning: data }).get('2026-09-11')
  assert.ok(friday.tasks.some((item) => item.task.floor === 'Schodiště'))
  assert.ok(friday.tasks.some((item) => item.task.floor === '4. patro'))
  assert.equal(friday.tasks.some((item) => item.size === 'small'), false)
})

test('více tříčlenných směn rozloží týdenní práce a velkou práci deterministicky', () => {
  const data = planning([assignment('a', [1, 3, 5]), assignment('b', [1, 3, 5]), assignment('c', [1, 3, 5])])
  const plan = buildDynamicSchoolPlan({ startDate: '2026-09-07', endDate: '2026-09-13', tasks: baseTasks, planning: data })
  assert.ok(plan.get('2026-09-07').tasks.some((item) => item.task.floor === 'Schodiště'))
  assert.ok(plan.get('2026-09-09').tasks.some((item) => item.task.floor === '4. patro'))
  assert.ok(plan.get('2026-09-11').tasks.some((item) => item.task.id === 'windows'))
})

test('splatná velká práce bez kapacity nezmizí a přejde na další vhodnou směnu', () => {
  const assignments = [
    assignment('a', [1, 3, 5]), assignment('b', [1, 3, 5]),
    assignment('c', [1], '2026-10-01'),
  ]
  const september = buildDynamicSchoolPlan({ startDate: '2026-09-01', endDate: '2026-09-30', tasks: baseTasks, planning: planning(assignments) })
  assert.equal([...september.values()].some((day) => day.tasks.some((item) => item.task.id === 'windows')), false)
  const october = buildDynamicSchoolPlan({ startDate: '2026-10-01', endDate: '2026-10-12', tasks: baseTasks, planning: planning(assignments) })
  const carried = [...october.values()].flatMap((day) => day.tasks).find((item) => item.task.id === 'windows')
  assert.ok(carried)
  assert.equal(carried.reason, 'overdue')
})

test('overdue práce má přednost před novější prací stejné kapacitní kategorie', () => {
  const newer = task('new-window', '2. patro', 'Chodba', 'windows', { frequency: 'měsíčně', periodMonths: 3, periodWeek: 1, periodAnchorMonth: '2026-10-01' })
  const data = planning([assignment('a', [1]), assignment('b', [1]), assignment('c', [1])])
  const day = buildDynamicSchoolPlan({ startDate: '2026-10-05', endDate: '2026-10-05', tasks: [baseTasks.find((item) => item.id === 'windows'), newer], planning: data }).get('2026-10-05')
  assert.ok(day.tasks.some((item) => item.task.id === 'windows' && item.reason === 'overdue'))
  assert.equal(day.tasks.some((item) => item.task.id === 'new-window'), false)
})

test('přejmenování pracovníka nemění plán a Školka zůstává mimo školní planner', () => {
  const first = planning([assignment('stable-uuid', [1], '2026-08-31', null, 'Původní jméno')])
  const renamed = planning([assignment('stable-uuid', [1], '2026-08-31', null, 'Nové jméno')])
  const kindergarten = task('kg', 'Prostory', 'Kuchyň', 'vacuum', { buildingId: 'kg', building: 'Školka' })
  const firstIds = buildDynamicSchoolPlan({ startDate: '2026-09-07', endDate: '2026-09-07', tasks: [...baseTasks, kindergarten], planning: first }).get('2026-09-07').tasks.map((item) => item.task.id)
  const renamedIds = buildDynamicSchoolPlan({ startDate: '2026-09-07', endDate: '2026-09-07', tasks: [...baseTasks, kindergarten], planning: renamed }).get('2026-09-07').tasks.map((item) => item.task.id)
  assert.deepEqual(firstIds, renamedIds)
  assert.equal(firstIds.includes('kg'), false)
})

test('změna pracovních dnů od října nepřepíše zářijovou historii a přepočítá budoucnost', () => {
  const historical = [assignment('a', [1, 3, 5], '2026-08-31', '2026-09-30'), assignment('b', [1, 3, 5], '2026-08-31', '2026-09-30')]
  const future = [assignment('a', [2, 4], '2026-10-01'), assignment('b', [2, 4], '2026-10-01')]
  const septemberOnly = buildDynamicSchoolPlan({ startDate: '2026-09-28', endDate: '2026-09-30', tasks: baseTasks, planning: planning(historical) })
  const withFuture = buildDynamicSchoolPlan({ startDate: '2026-09-28', endDate: '2026-10-08', tasks: baseTasks, planning: planning([...historical, ...future]) })
  assert.deepEqual(['2026-09-28', '2026-09-30'].map((date) => septemberOnly.get(date)?.rotatingFloor), ['2. patro', '3. patro'])
  assert.deepEqual(['2026-09-28', '2026-09-30'].map((date) => withFuture.get(date)?.rotatingFloor), ['2. patro', '3. patro'])
  assert.equal(withFuture.has('2026-10-05'), false)
  assert.ok(withFuture.has('2026-10-06'))
})
