import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isTaskDueForCleaningDay,
  isTaskDueOnDate,
  dateRangeChunks,
  monthGridDates,
  resolveCleaningDay,
} from './scheduling.ts'

const everyCleaningDay = { frequency: 'cleaning_day', schedule_days: [1, 3, 5] }
const fridayOnly = { frequency: 'weekly', schedule_days: [5] }
const monthly = { frequency: 'monthly', schedule_days: [], monthly_day: 1 }

test('šestitýdenní kalendář dělí planner na úplné týdenní intervaly bez mezer', () => {
  const chunks = dateRangeChunks('2026-08-31', '2026-10-11')
  assert.equal(chunks.length, 6)
  assert.deepEqual(chunks[0], { from: '2026-08-31', to: '2026-09-06' })
  assert.deepEqual(chunks[1], { from: '2026-09-07', to: '2026-09-13' })
  assert.deepEqual(chunks.at(-1), { from: '2026-10-05', to: '2026-10-11' })
  assert.deepEqual(dateRangeChunks('2026-09-07', '2026-09-07'), [{ from: '2026-09-07', to: '2026-09-07' }])
})

test('standardní pondělí, středa a pátek jsou splatné', () => {
  assert.equal(isTaskDueOnDate(everyCleaningDay, '2026-08-24'), true)
  assert.equal(isTaskDueOnDate(everyCleaningDay, '2026-08-26'), true)
  assert.equal(isTaskDueOnDate(everyCleaningDay, '2026-08-28'), true)
})

test('samostatný plán Školky je splatný v úterý a neovlivní školní Po/St/Pá', () => {
  const kindergartenTuesday = { frequency: 'cleaning_day', schedule_days: [2] }
  assert.equal(isTaskDueOnDate(kindergartenTuesday, '2026-09-01'), true)
  assert.equal(isTaskDueOnDate(kindergartenTuesday, '2026-09-02'), false)
  assert.equal(isTaskDueOnDate(everyCleaningDay, '2026-09-01'), false)
})

test('běžná sobota nemá standardní úkol', () => {
  const context = resolveCleaningDay('2026-08-29', [])
  assert.equal(isTaskDueForCleaningDay(everyCleaningDay, context), false)
})

test('mimořádný úklid celé školy zahrne standardní cleaning_day úkoly', () => {
  const exceptions = [{
    id: 'extra', kind: 'extraordinary', executionDate: '2026-08-29',
    title: 'Generální úklid', status: 'active',
  }]
  const context = resolveCleaningDay('2026-08-29', exceptions)
  assert.equal(context.kind, 'extraordinary')
  assert.equal(isTaskDueForCleaningDay(everyCleaningDay, context), true)
  assert.equal(isTaskDueForCleaningDay(fridayOnly, context), false)
})

test('mimořádný úklid může přidat kanonický task mimo jeho pravidelný den', () => {
  const stairMop = {
    id: 'stairs-mop', frequency: 'once_or_twice_weekly', schedule_days: [1, 5],
  }
  const context = resolveCleaningDay('2026-08-29', [{
    id: 'extra-stairs', kind: 'extraordinary', executionDate: '2026-08-29',
    title: 'Před školním rokem', status: 'active',
    taskOverrides: { 'stairs-mop': true },
  }])
  assert.equal(isTaskDueForCleaningDay(stairMop, context), true)
})

test('mimořádný úklid může odebrat task bez změny jeho pravidelného plánu', () => {
  const task = { id: 'optional-room', ...everyCleaningDay }
  const context = resolveCleaningDay('2026-08-29', [{
    id: 'extra-selection', kind: 'extraordinary', executionDate: '2026-08-29',
    title: 'Výběrový úklid', status: 'active',
    taskOverrides: { 'optional-room': false },
  }])
  assert.equal(isTaskDueForCleaningDay(task, context), false)
  assert.equal(isTaskDueOnDate(task, '2026-08-28'), true)
})

test('mimořádný úklid ve standardní den zachová i speciální úkoly toho dne', () => {
  const exceptions = [{
    id: 'extra-friday', kind: 'extraordinary', executionDate: '2026-08-28',
    title: 'Mimořádný páteční úklid', status: 'active',
  }]
  const context = resolveCleaningDay('2026-08-28', exceptions)
  assert.equal(isTaskDueForCleaningDay(fridayOnly, context), true)
})

test('páteční plán přesunutý na sobotu zachová páteční-only úkol', () => {
  const exceptions = [{
    id: 'move', kind: 'rescheduled', executionDate: '2026-09-05',
    sourceDate: '2026-09-04', title: 'Přesun kvůli akci', status: 'active',
  }]
  const saturday = resolveCleaningDay('2026-09-05', exceptions)
  assert.equal(saturday.kind, 'rescheduled')
  assert.equal(saturday.scheduleDate, '2026-09-04')
  assert.equal(isTaskDueForCleaningDay(fridayOnly, saturday), true)

  const friday = resolveCleaningDay('2026-09-04', exceptions)
  assert.equal(friday.kind, 'moved_away')
  assert.equal(isTaskDueForCleaningDay(fridayOnly, friday), false)
})

test('completion datum kontextu zůstává skutečný termín provedení', () => {
  const context = resolveCleaningDay('2026-09-05', [{
    id: 'move', kind: 'rescheduled', executionDate: '2026-09-05',
    sourceDate: '2026-09-04', title: 'Přesun', status: 'active',
  }])
  assert.equal(context.executionDate, '2026-09-05')
  assert.equal(context.scheduleDate, '2026-09-04')
})

test('přesun na standardní úklidový den spojí původní a místní plán', () => {
  const mondayOnly = { frequency: 'weekly', schedule_days: [1] }
  const context = resolveCleaningDay('2026-09-07', [{
    id: 'move-to-monday', kind: 'rescheduled', executionDate: '2026-09-07',
    sourceDate: '2026-09-04', title: 'Přesun na pondělí', status: 'active',
  }])
  assert.equal(isTaskDueForCleaningDay(fridayOnly, context), true)
  assert.equal(isTaskDueForCleaningDay(mondayOnly, context), true)
})

test('preview ukazuje standardní cleaning_day, ale je samostatný kontext', () => {
  const context = resolveCleaningDay('2026-08-29', [], true)
  assert.equal(context.kind, 'preview')
  assert.equal(isTaskDueForCleaningDay(everyCleaningDay, context), true)
  assert.equal(isTaskDueForCleaningDay(fridayOnly, context), false)
})

test('měsíční úkol zůstává vázaný na monthly_day', () => {
  assert.equal(isTaskDueOnDate(monthly, '2026-09-01'), true)
  assert.equal(isTaskDueOnDate(monthly, '2026-09-02'), false)
})

const floorOne = { ...everyCleaningDay }
const floorTwo = { ...everyCleaningDay, cleaning_cycle_length: 2, cleaning_cycle_offset: 0 }
const floorThree = { ...everyCleaningDay, cleaning_cycle_length: 2, cleaning_cycle_offset: 1 }

test('1. patro je splatné při každém úklidu Po/St/Pá', () => {
  for (const date of ['2026-08-31', '2026-09-02', '2026-09-04']) {
    assert.equal(isTaskDueOnDate(floorOne, date), true)
  }
})

test('2. a 3. patro se střídají po jednotlivých úklidových dnech', () => {
  assert.equal(isTaskDueOnDate(floorTwo, '2026-08-31'), true)
  assert.equal(isTaskDueOnDate(floorThree, '2026-08-31'), false)
  assert.equal(isTaskDueOnDate(floorTwo, '2026-09-02'), false)
  assert.equal(isTaskDueOnDate(floorThree, '2026-09-02'), true)
  assert.equal(isTaskDueOnDate(floorTwo, '2026-09-04'), true)
})

test('rotace pater pokračuje přes hranici týdne i měsíce', () => {
  assert.equal(isTaskDueOnDate(floorThree, '2026-09-07'), true)
  assert.equal(isTaskDueOnDate(floorTwo, '2026-09-30'), false)
  assert.equal(isTaskDueOnDate(floorThree, '2026-09-30'), true)
  assert.equal(isTaskDueOnDate(floorTwo, '2026-10-02'), true)
})

test('4. patro a schodiště jsou jednou týdně v pátek', () => {
  const friday = { frequency: 'weekly', schedule_days: [5] }
  assert.equal(isTaskDueOnDate(friday, '2026-09-04'), true)
  assert.equal(isTaskDueOnDate(friday, '2026-09-02'), false)
})

test('měsíční práce jsou rozložené do určených týdnů', () => {
  const periodic = (week) => ({
    frequency: 'monthly', schedule_days: [1, 3, 5], period_months: 1,
    period_week: week, period_anchor_month: '2026-09-01',
  })
  assert.equal(isTaskDueOnDate(periodic(1), '2026-09-02'), true) // dveře
  assert.equal(isTaskDueOnDate(periodic(2), '2026-09-09'), true) // okna
  assert.equal(isTaskDueOnDate(periodic(3), '2026-09-16'), true) // obklady
  assert.equal(isTaskDueOnDate(periodic(4), '2026-09-23'), true) // povrchy
  assert.equal(isTaskDueOnDate(periodic(2), '2026-09-11'), false)
})

test('periodická práce počká na první návštěvu rotujícího patra', () => {
  const floorTwoWindows = {
    ...floorTwo, frequency: 'monthly', period_months: 1, period_week: 2,
    period_anchor_month: '2026-09-01',
  }
  assert.equal(isTaskDueOnDate(floorTwoWindows, '2026-09-07'), false)
  assert.equal(isTaskDueOnDate(floorTwoWindows, '2026-09-09'), true)
})

test('čtvrtletní a dvouměsíční práce respektují kotvu období', () => {
  const quarterly = {
    frequency: 'monthly', schedule_days: [1, 3, 5], period_months: 3,
    period_week: 4, period_anchor_month: '2026-09-01',
  }
  const bimonthly = { ...quarterly, period_months: 2 }
  assert.equal(isTaskDueOnDate(quarterly, '2026-09-23'), true)
  assert.equal(isTaskDueOnDate(quarterly, '2026-10-23'), false)
  assert.equal(isTaskDueOnDate(quarterly, '2026-12-23'), true)
  assert.equal(isTaskDueOnDate(bimonthly, '2026-11-23'), true)
})

test('kalendář i Dnes používají stejný kontext splatnosti', () => {
  const records = [{
    id: 'move-month', kind: 'rescheduled', executionDate: '2026-10-03',
    sourceDate: '2026-10-02', title: 'Přesun', status: 'active',
  }]
  const context = resolveCleaningDay('2026-10-03', records)
  assert.equal(isTaskDueForCleaningDay(floorTwo, context), isTaskDueOnDate(floorTwo, '2026-10-02'))
})

test('mobilní měsíční mřížka má šest týdnů Po–Ne i přes hranici měsíce', () => {
  const dates = monthGridDates('2026-08')
  assert.equal(dates.length, 42)
  assert.equal(dates[0], '2026-07-27')
  assert.equal(dates.at(-1), '2026-09-06')
})
