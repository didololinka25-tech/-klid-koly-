import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAttendanceReport, pdfFromJpegs } from './attendanceReport.ts'

const records = [
  { id: '1', workerId: 'worker', buildingId: 'school', buildingName: 'Škola', date: '2026-09-01', start: '2026-09-01T07:00:00Z', end: '2026-09-01T08:00:00Z' },
  { id: '2', workerId: 'worker', buildingId: 'nursery', buildingName: 'Školka', date: '2026-09-01', start: '2026-09-01T14:00:00Z', end: '2026-09-01T16:00:00Z' },
  { id: '3', workerId: 'worker', buildingId: 'school', buildingName: 'Škola', date: '2026-08-28', start: '2026-08-28T14:00:00Z', end: '2026-08-28T15:30:00Z' },
  { id: '4', workerId: 'worker', buildingId: 'school', buildingName: 'Škola', date: '2025-12-31', start: '2025-12-31T14:00:00Z', end: '2025-12-31T20:00:00Z' },
]

test('měsíční výkaz zachová více směn v jednom dni i více pracovišť', () => {
  const report = buildAttendanceReport(records, 'Didi Ceridwen', '2026-09', 300, new Date('2026-09-30T12:00:00Z'))
  assert.equal(report.rows.length, 2)
  assert.deepEqual(report.workplaces, ['Škola', 'Školka'])
  assert.equal(report.monthMs, 3 * 60 * 60 * 1000)
  assert.deepEqual(report.workplaceTotals.map((item) => [item.name, item.durationMs]), [
    ['Škola', 60 * 60 * 1000],
    ['Školka', 2 * 60 * 60 * 1000],
  ])
})

test('roční součet používá kalendářní rok napříč pracovišti a jeden DPP limit', () => {
  const report = buildAttendanceReport(records, 'Didi Ceridwen', '2026-09', 300, new Date('2026-09-30T12:00:00Z'))
  assert.equal(report.yearMs, 4.5 * 60 * 60 * 1000)
  assert.equal(report.annualLimitHours, 300)
})

test('data náhledu/PDF jsou odvozena z jednotlivých attendance řádků', () => {
  const report = buildAttendanceReport(records, 'Didi Ceridwen', '2026-09', 250, new Date('2026-09-30T12:00:00Z'))
  assert.deepEqual(report.rows.map((row) => [row.id, row.workplace, row.durationMs]), [
    ['1', 'Škola', 60 * 60 * 1000],
    ['2', 'Školka', 2 * 60 * 60 * 1000],
  ])
  assert.equal(report.workerName, 'Didi Ceridwen')
  assert.equal(report.annualLimitHours, 250)
})

test('generátor vytvoří neprázdný PDF dokument s A4 stránkou', () => {
  const pdf = pdfFromJpegs([{ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 1, height: 1 }])
  const text = new TextDecoder().decode(pdf)
  assert.match(text, /^%PDF-1\.4/)
  assert.match(text, /\/MediaBox \[0 0 595 842\]/)
  assert.match(text, /\/Subtype \/Image/)
  assert.ok(pdf.byteLength > 400)
})

test('měsíční součet zahrne přesně DB řádky a zachová směnu předchozího dne', () => {
  const shifts = [
    { id: '29', workerId: 'worker', buildingId: 'school', buildingName: 'Škola', date: '2026-08-29', start: '2026-08-29T07:00:00Z', end: '2026-08-29T10:00:00Z' },
    { id: '30', workerId: 'worker', buildingId: 'school', buildingName: 'Škola', date: '2026-08-30', start: '2026-08-30T07:20:00Z', end: '2026-08-30T10:06:00Z' },
  ]
  const report = buildAttendanceReport(shifts, 'Didi Ceridwen', '2026-08', 300, new Date('2026-08-31T12:00:00Z'))
  assert.deepEqual(report.rows.map((row) => row.id), ['29', '30'])
  assert.equal(report.monthMs, (3 * 60 + 2 * 60 + 46) * 60 * 1000)
})

test('výkaz určí DPP nebo DPČ z historické platnosti smlouvy, ne ze jména', () => {
  const contracts = [
    { contractType: 'dpp', validFrom: '2026-01-01', validTo: '2026-08-31', active: true },
    { contractType: 'dpc', validFrom: '2026-09-01', active: true },
  ]
  const august = buildAttendanceReport(records, 'Libovolné jméno', '2026-08', 300, new Date('2026-09-30T12:00:00Z'), contracts)
  const september = buildAttendanceReport(records, 'Libovolné jméno', '2026-09', 300, new Date('2026-09-30T12:00:00Z'), contracts)
  assert.equal(august.contractLabel, 'DPP')
  assert.equal(september.contractLabel, 'DPČ')
})
