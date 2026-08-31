import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAttendanceReport, pdfFromJpegs, reportDurationCeil } from './attendanceReport.ts'

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

test('DPČ hranice používá přesnou dobu a sazbu, nikoli zaokrouhlený počet hodin', () => {
  const contracts = [{ id: 'dpc', contractType: 'dpc', validFrom: '2026-09-01', active: true, hourlyRate: 150 }]
  const shifts = [
    { id: 'exact', workerId: 'worker', buildingId: 'school', buildingName: 'Škola', date: '2026-09-01', start: '2026-09-01T08:00:00Z', end: '2026-09-02T02:00:30Z' },
  ]
  const report = buildAttendanceReport(shifts, 'Dana', '2026-09', 300, new Date('2026-09-30T12:00:00Z'), contracts, 4500)
  assert.equal(report.dpcMonthMs, (18 * 60 * 60 + 30) * 1000)
  assert.equal(report.dpcGrossEstimate, (18 + 30 / 3600) * 150)
  assert.equal(report.dpcRemainingIncome, 4500 - (18 + 30 / 3600) * 150)
  assert.equal(report.dpcRequiredMsAtCurrentRate, 30 * 60 * 60 * 1000)
  assert.equal(reportDurationCeil(report.dpcRemainingMsAtCurrentRate), '12 h 00 min')
  assert.equal(report.dpcThresholdReached, false)
})

test('DPČ 18 hodin při 150 Kč vykáže 2700 Kč a zbývajících 1800 Kč / 12 hodin', () => {
  const contracts = [{ id: 'dpc', contractType: 'dpc', validFrom: '2026-09-01', active: true, hourlyRate: 150 }]
  const shifts = [{ id: '1', workerId: 'worker', buildingId: 'school', buildingName: 'Škola', date: '2026-09-01', start: '2026-09-01T06:00:00Z', end: '2026-09-02T00:00:00Z' }]
  const report = buildAttendanceReport(shifts, 'Dana', '2026-09', 300, new Date('2026-09-30T12:00:00Z'), contracts, 4500)
  assert.equal(report.dpcGrossEstimate, 2700)
  assert.equal(report.dpcRemainingIncome, 1800)
  assert.equal(report.dpcRemainingMsAtCurrentRate, 12 * 60 * 60 * 1000)
})

test('sazba se vybírá historicky podle dne směny i při změně uprostřed měsíce', () => {
  const contracts = [
    { id: 'old', contractType: 'dpc', validFrom: '2026-09-01', validTo: '2026-09-15', active: true, hourlyRate: 150 },
    { id: 'new', contractType: 'dpc', validFrom: '2026-09-16', active: true, hourlyRate: 170 },
  ]
  const shifts = [
    { id: 'old-shift', workerId: 'worker', buildingId: 'school', buildingName: 'Škola', date: '2026-09-10', start: '2026-09-10T08:00:00Z', end: '2026-09-10T10:00:00Z' },
    { id: 'new-shift', workerId: 'worker', buildingId: 'nursery', buildingName: 'Školka', date: '2026-09-20', start: '2026-09-20T08:00:00Z', end: '2026-09-20T11:00:00Z' },
  ]
  const report = buildAttendanceReport(shifts, 'Dana', '2026-09', 300, new Date('2026-09-30T12:00:00Z'), contracts, 4500)
  assert.equal(report.grossEstimate, 2 * 150 + 3 * 170)
  assert.deepEqual(report.rows.map((row) => row.hourlyRate), [150, 170])
  assert.deepEqual(report.workplaceTotals.map((item) => item.name), ['Škola', 'Školka'])
  assert.equal(report.contractSegments.length, 2)
})

test('pozdější sazba nepřepočítá uzavřené historické období', () => {
  const shift = [{ id: 'historic', workerId: 'worker', buildingId: 'school', buildingName: 'Škola', date: '2026-10-10', start: '2026-10-10T08:00:00Z', end: '2026-10-10T10:00:00Z' }]
  const contracts = [
    { id: 'historic-rate', contractType: 'dpc', validFrom: '2026-10-01', validTo: '2026-12-31', active: true, hourlyRate: 150 },
    { id: 'future-rate', contractType: 'dpc', validFrom: '2027-01-01', active: true, hourlyRate: 170 },
  ]
  const report = buildAttendanceReport(shift, 'Dana', '2026-10', 300, new Date('2027-02-01T12:00:00Z'), contracts, 4500)
  assert.equal(report.grossEstimate, 300)
  assert.equal(report.rows[0].hourlyRate, 150)
})

test('přechod DPP na DPČ oddělí roční DPP hodiny a měsíční DPČ příjem', () => {
  const contracts = [
    { id: 'dpp', contractType: 'dpp', validFrom: '2026-01-01', validTo: '2026-08-31', active: true, hourlyRate: 140 },
    { id: 'dpc', contractType: 'dpc', validFrom: '2026-09-01', active: true, hourlyRate: 160 },
  ]
  const shifts = [
    { id: 'aug', workerId: 'worker', buildingId: 'school', buildingName: 'Škola', date: '2026-08-31', start: '2026-08-31T08:00:00Z', end: '2026-08-31T10:00:00Z' },
    { id: 'sep', workerId: 'worker', buildingId: 'school', buildingName: 'Škola', date: '2026-09-01', start: '2026-09-01T08:00:00Z', end: '2026-09-01T11:00:00Z' },
  ]
  const report = buildAttendanceReport(shifts, 'Dana', '2026-09', 300, new Date('2026-09-30T12:00:00Z'), contracts, 4500)
  assert.equal(report.dppYearMs, 2 * 60 * 60 * 1000)
  assert.equal(report.dpcMonthMs, 3 * 60 * 60 * 1000)
  assert.equal(report.dpcGrossEstimate, 480)
})

test('bez smlouvy nebo sazby se mzda nevymýšlí', () => {
  const noContract = buildAttendanceReport(records, 'Dana', '2026-09', 300, new Date('2026-09-30T12:00:00Z'), [], 4500)
  assert.equal(noContract.grossEstimate, undefined)
  assert.equal(noContract.missingContractMs, 3 * 60 * 60 * 1000)
  const missingRate = buildAttendanceReport(records, 'Dana', '2026-09', 300, new Date('2026-09-30T12:00:00Z'), [{ contractType: 'dpc', validFrom: '2026-01-01', active: true }], 4500)
  assert.equal(missingRate.dpcGrossEstimate, undefined)
  assert.equal(missingRate.missingRateMs, 3 * 60 * 60 * 1000)
})
