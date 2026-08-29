import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isTaskDueForCleaningDay,
  isTaskDueOnDate,
  resolveCleaningDay,
} from './scheduling.ts'

const everyCleaningDay = { frequency: 'cleaning_day', schedule_days: [1, 3, 5] }
const fridayOnly = { frequency: 'weekly', schedule_days: [5] }
const monthly = { frequency: 'monthly', schedule_days: [], monthly_day: 1 }

test('standardní pondělí, středa a pátek jsou splatné', () => {
  assert.equal(isTaskDueOnDate(everyCleaningDay, '2026-08-24'), true)
  assert.equal(isTaskDueOnDate(everyCleaningDay, '2026-08-26'), true)
  assert.equal(isTaskDueOnDate(everyCleaningDay, '2026-08-28'), true)
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
