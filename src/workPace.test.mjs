import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDpcPace, calculateDppMonthlyBudget, remainingCalendarWeeks } from './workPace.ts'

test('DPČ 4500 / 150 má měsíční cíl 30 hodin a používá skutečnou délku měsíce', () => {
  const pace = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-01', monthlyThreshold: 4500, grossIncome: 0, hourlyRate: 150, contractValidFrom: '2026-08-01' })
  assert.equal(pace.targetHours, 30)
  assert.equal(pace.remainingWeeks, 31 / 7)
  assert.equal(pace.weeklyHours, 30 / (31 / 7))
})

test('DPČ tempo průběžně klesá po odpracování a roste při menším zbývajícím čase', () => {
  const earlier = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-10', monthlyThreshold: 4500, grossIncome: 2700, hourlyRate: 150, contractValidFrom: '2026-08-01' })
  const later = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-25', monthlyThreshold: 4500, grossIncome: 2700, hourlyRate: 150, contractValidFrom: '2026-08-01' })
  assert.equal(earlier.remainingHours, 12)
  assert.ok(earlier.weeklyHours < later.weeklyHours)
  const moreWorked = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-10', monthlyThreshold: 4500, grossIncome: 3600, hourlyRate: 150, contractValidFrom: '2026-08-01' })
  assert.ok(moreWorked.weeklyHours < earlier.weeklyHours)
})

test('DPČ po dosažení hranice vrátí nulové tempo', () => {
  const pace = calculateDpcPace({ month: '2026-08', currentDateKey: '2026-08-20', monthlyThreshold: 4500, grossIncome: 4500, hourlyRate: 150, contractValidFrom: '2026-08-01' })
  assert.equal(pace.thresholdReached, true)
  assert.equal(pace.weeklyHours, 0)
  assert.equal(pace.remainingHours, 0)
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
