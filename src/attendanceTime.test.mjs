import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attendanceIntervalsOverlap,
  attendanceEditorStartValue,
  parsePragueDateTimeInput,
  pragueDateKey,
  pragueDateTimeInput,
  validateAttendanceInterval,
} from './attendanceTime.ts'

test('pracovní datum se vždy určuje v Europe/Prague', () => {
  assert.equal(pragueDateKey('2026-08-28T22:30:00Z'), '2026-08-29')
  assert.equal(pragueDateKey('2026-12-31T23:30:00Z'), '2027-01-01')
})

test('datetime-local se převádí mezi Prahou a UTC beze změny data a času', () => {
  const input = '2026-08-29T09:20'
  const instant = parsePragueDateTimeInput(input)
  assert.equal(instant.toISOString(), '2026-08-29T07:20:00.000Z')
  assert.equal(pragueDateTimeInput(instant), input)
  assert.equal(validateAttendanceInterval([], input, '2026-08-29T12:06').attendanceDate, '2026-08-29')
})

test('editor zachová evidované pracovní datum a nepřepíše je dneškem', () => {
  assert.equal(
    attendanceEditorStartValue('2026-08-30T07:00:00Z', '2026-08-29'),
    '2026-08-29T09:00',
  )
})

test('směny v různých dnech se nepřekrývají', () => {
  const records = [{ id: '29', start: '2026-08-29T07:00:00Z', end: '2026-08-29T10:00:00Z' }]
  assert.equal(attendanceIntervalsOverlap(records, new Date('2026-08-30T07:00:00Z'), new Date('2026-08-30T10:00:00Z')), false)
})

test('překryv směn je odmítnut, navazující směna je povolena', () => {
  const records = [{ id: 'existing', start: '2026-08-30T07:00:00Z', end: '2026-08-30T10:06:00Z' }]
  assert.equal(attendanceIntervalsOverlap(records, new Date('2026-08-30T07:20:00Z'), new Date('2026-08-30T10:06:00Z')), true)
  assert.equal(attendanceIntervalsOverlap(records, new Date('2026-08-30T10:06:00Z'), new Date('2026-08-30T11:00:00Z')), false)
  assert.throws(
    () => validateAttendanceInterval(records, '2026-08-30T09:20', '2026-08-30T12:06'),
    /překrývá/,
  )
})

test('editovaný řádek se při kontrole překryvu vynechá', () => {
  const records = [{ id: 'same', start: '2026-08-29T07:00:00Z', end: '2026-08-29T10:00:00Z' }]
  assert.doesNotThrow(() => validateAttendanceInterval(records, '2026-08-29T09:15', '2026-08-29T12:00', 'same'))
})
