import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDpcPace, calculateDpcPaceCard, calculateDppMonthlyBudget, remainingCalendarWeeks } from './workPace.ts'

test('DPČ 4500 / 150 má měsíční cíl 30 hodin a používá skutečnou délku měsíce', () => {
  const pace = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-01', monthlyThreshold: 4500, grossIncome: 0, workedHours: 0, hourlyRate: 150, contractValidFrom: '2026-08-01' })
  assert.equal(pace.targetHours, 30)
  assert.equal(pace.remainingWeeks, 31 / 7)
  assert.equal(pace.baselineWeeklyHours, 30 / (31 / 7))
  assert.equal(pace.remainingWeeklyHours, 30 / (31 / 7))
})

test('DPČ tempo průběžně klesá po odpracování a roste při menším zbývajícím čase', () => {
  const earlier = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-10', monthlyThreshold: 4500, grossIncome: 2700, workedHours: 18, hourlyRate: 150, contractValidFrom: '2026-08-01' })
  const later = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-25', monthlyThreshold: 4500, grossIncome: 2700, workedHours: 18, hourlyRate: 150, contractValidFrom: '2026-08-01' })
  assert.equal(earlier.remainingHours, 12)
  assert.ok(earlier.remainingWeeklyHours < later.remainingWeeklyHours)
  const moreWorked = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-10', monthlyThreshold: 4500, grossIncome: 3600, workedHours: 24, hourlyRate: 150, contractValidFrom: '2026-08-01' })
  assert.ok(moreWorked.remainingWeeklyHours < earlier.remainingWeeklyHours)
})

test('DPČ po dosažení hranice vrátí nulové tempo', () => {
  const pace = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-20', monthlyThreshold: 4500, grossIncome: 4500, workedHours: 30, hourlyRate: 150, contractValidFrom: '2026-08-01' })
  assert.equal(pace.thresholdReached, true)
  assert.equal(pace.remainingWeeklyHours, 0)
  assert.equal(pace.remainingHours, 0)
})

test('31. srpna zachová běžné tempo a nikdy neextrapoluje zbytek na 157 hodin týdně', () => {
  const workedHours = 7 + 35 / 60
  const pace = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-31', monthlyThreshold: 4500, grossIncome: workedHours * 150, workedHours, hourlyRate: 150, contractValidFrom: '2026-08-01' })
  assert.ok(pace.baselineWeeklyHours > 6.5 && pace.baselineWeeklyHours < 7.5)
  assert.equal(pace.remainingHours, 30 - workedHours)
  assert.equal(pace.daysRemaining, 1)
  assert.equal(pace.remainingWeeklyHours, undefined)
  assert.equal(pace.behindBaseline, true)
})

test('v posledních třech dnech se zbývající týdenní tempo neuvádí', () => {
  for (const day of ['2026-08-29', '2026-08-30', '2026-08-31']) {
    const pace = calculateDpcPace({ month: '2026-08', currentDateKey: day, monthlyThreshold: 4500, grossIncome: 1200, workedHours: 8, hourlyRate: 150, contractValidFrom: '2026-08-01' })
    assert.equal(pace.remainingWeeklyHours, undefined)
  }
})

test('na začátku, uprostřed a na konci měsíce zůstává baseline stejná', () => {
  const days = ['2026-08-01', '2026-08-16', '2026-08-31']
  const paces = days.map((currentDateKey) => calculateDpcPace({ month: '2026-08', currentDateKey, monthlyThreshold: 4500, grossIncome: 0, workedHours: 0, hourlyRate: 150, contractValidFrom: '2026-08-01' }))
  assert.deepEqual(paces.map((pace) => pace.baselineWeeklyHours), Array(3).fill(30 / (31 / 7)))
})

test('začátek ani konec smlouvy nevměstná celoměsíční baseline do několika dnů', () => {
  const startsMidMonth = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-15', monthlyThreshold: 4500, grossIncome: 0, workedHours: 0, hourlyRate: 150, contractValidFrom: '2026-08-15' })
  const endsMidMonth = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-01', monthlyThreshold: 4500, grossIncome: 0, workedHours: 0, hourlyRate: 150, contractValidFrom: '2026-01-01', contractValidTo: '2026-08-15' })
  assert.equal(startsMidMonth.baselineWeeklyHours, 30 / (31 / 7))
  assert.equal(endsMidMonth.baselineWeeklyHours, 30 / (31 / 7))
  assert.equal(startsMidMonth.remainingWeeks, 17 / 7)
  assert.equal(endsMidMonth.remainingWeeks, 15 / 7)
})

test('produkční DPČ karta 31. srpna renderuje 6:46, nikoli 52:30 nebo 157 hodin', () => {
  const workedHours = 7 + 35 / 60
  const card = calculateDpcPaceCard({ month: '2026-08', currentDateKey: '2026-08-31', monthlyThreshold: 4500, grossIncome: workedHours * 150, workedHours, hourlyRate: 150, contractValidFrom: '2026-08-28', contractValidTo: '2027-07-31' })
  assert.equal(card.baselineWeeklyText, '6 h 46 min')
  assert.equal(card.remainingHoursText, '22 h 25 min')
  assert.equal(card.remainingWeeklyText, undefined)
  assert.notEqual(card.baselineWeeklyText, '52 h 30 min')
})

test('DPČ karta respektuje únor a 30/31denní měsíc bez závislosti na dnešním datu', () => {
  const baseline = (month, currentDateKey) => calculateDpcPaceCard({ month, currentDateKey, monthlyThreshold: 4500, grossIncome: 0, workedHours: 0, hourlyRate: 150, contractValidFrom: `${month}-01` }).baselineWeeklyText
  assert.equal(baseline('2026-02', '2026-02-28'), '7 h 30 min')
  assert.equal(baseline('2026-04', '2026-04-30'), '7 h 00 min')
  assert.equal(baseline('2026-08', '2026-08-31'), '6 h 46 min')
})

test('zbývající kalendář respektuje 28/29/30/31 dní a konec smlouvy', () => {
  assert.equal(remainingCalendarWeeks('2026-02', '2026-02-01', '2026-01-01'), 28 / 7)
  assert.equal(remainingCalendarWeeks('2028-02', '2028-02-01', '2028-01-01'), 29 / 7)
  assert.equal(remainingCalendarWeeks('2026-04', '2026-04-15', '2026-01-01'), 16 / 7)
  assert.equal(remainingCalendarWeeks('2026-08', '2026-08-20', '2026-01-01', '2026-08-25'), 6 / 7)
})

test('DPP 120/300 se šesti relevantními měsíci dává rozpočet 30 hodin', () => {
  const budget = calculateDppMonthlyBudget({ month: '2026-07', annualLimitHours: 300, dppYearHours: 120, dppMonthHours: 0, contractValidFrom: '2026-01-01' })
  assert.equal(budget.annualRemainingHours, 180)
  assert.equal(budget.remainingMonths, 6)
  assert.equal(budget.monthlyBudgetHours, 30)
})

test('DPP rozpočet odečte práci tohoto měsíce, ale zachová roční fond', () => {
  const budget = calculateDppMonthlyBudget({ month: '2026-07', annualLimitHours: 300, dppYearHours: 130, dppMonthHours: 10, contractValidFrom: '2026-01-01' })
  assert.equal(budget.annualRemainingHours, 170)
  assert.equal(budget.monthlyBudgetHours, 30)
  assert.equal(budget.monthlyBudgetRemainingHours, 20)
})

test('DPP od září se nedělí dvanácti a konec v listopadu nepokračuje do prosince', () => {
  const toYearEnd = calculateDppMonthlyBudget({ month: '2026-09', annualLimitHours: 300, dppYearHours: 0, dppMonthHours: 0, contractValidFrom: '2026-09-01' })
  assert.equal(toYearEnd.remainingMonths, 4)
  assert.equal(toYearEnd.monthlyBudgetHours, 75)
  const toNovember = calculateDppMonthlyBudget({ month: '2026-09', annualLimitHours: 300, dppYearHours: 0, dppMonthHours: 0, contractValidFrom: '2026-09-01', contractValidTo: '2026-11-15' })
  assert.equal(toNovember.remainingMonths, 3)
  assert.equal(toNovember.monthlyBudgetHours, 100)
})
