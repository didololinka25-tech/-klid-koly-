import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { calculateDpcPaceCard } from './workPace.ts'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('kompaktní DPČ karta renderuje ověřené hodnoty ze stejného view-modelu', () => {
  const workedHours = 7 + 35 / 60
  const card = calculateDpcPaceCard({
    month: '2026-08',
    currentDateKey: '2026-08-31',
    monthlyThreshold: 4500,
    grossIncome: workedHours * 150,
    workedHours,
    hourlyRate: 150,
    contractValidFrom: '2026-08-28',
    contractValidTo: '2027-07-31',
  })
  assert.equal(card.baselineWeeklyText, '6 h 46 min')
  assert.equal(card.remainingHoursText, '22 h 25 min')
  assert.equal(card.remainingWeeklyText, undefined)

  const component = app.match(/function DpcMonthlySummary[\s\S]*?function formatPlanningHours/)?.[0] ?? ''
  assert.match(component, /paceCard\.baselineWeeklyText/)
  assert.match(component, /paceCard\.remainingHoursText/)
  assert.match(component, /ODHAD ODMĚNY/)
  assert.match(component, /ⓘ Jak se to počítá/)
  assert.match(component, /pace\.remainingWeeklyHours !== undefined/)
  assert.doesNotMatch(component, /Dosavadní průměr/)
})

test('vysvětlení DPČ zůstává dynamické podle sazby, hranice a cíle', () => {
  const component = app.match(/function DpcMonthlySummary[\s\S]*?function formatPlanningHours/)?.[0] ?? ''
  assert.match(component, /reportMoney\(contract\.hourlyRate\)/)
  assert.match(component, /reportMoney\(appSettings\.dpcMonthlyInsuranceThreshold\)/)
  assert.match(component, /formatPlanningHours\(pace\.targetHours\)/)
  assert.match(component, /Do konce měsíce už nezbývá celý pracovní týden/)
})

test('DPP karta používá stejnou kompaktní hierarchii a skrývá vysvětlení do detailu', () => {
  const dashboard = app.match(/function AttendanceDashboard[\s\S]*?function WorkerContractsPanel/)?.[0] ?? ''
  assert.match(dashboard, /pace-worked/)
  assert.match(dashboard, /MĚSÍČNÍ ROZPOČET/)
  assert.match(dashboard, /dppBudget\.annualRemainingHours/)
  assert.match(dashboard, /dppBudget\.monthlyBudgetHours/)
  assert.match(dashboard, /pace-explanation/)
  assert.match(dashboard, /Nejde o zákonné měsíční maximum/)
})

test('mobilní karta nemá pevnou šířku a informační detail má velký touch target', () => {
  assert.match(styles, /\.pace-metrics\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(styles, /\.pace-metrics > div\s*\{[\s\S]*?min-width:\s*0/)
  assert.match(styles, /\.pace-explanation summary\s*\{[\s\S]*?min-height:\s*48px/)
})
