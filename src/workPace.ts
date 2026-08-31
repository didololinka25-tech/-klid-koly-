const DAY_MS = 24 * 60 * 60 * 1000

const dateValue = (key: string) => Date.parse(`${key}T00:00:00Z`)
const maxDateKey = (...values: string[]) => values.reduce((latest, value) => value > latest ? value : latest)
const minDateKey = (...values: string[]) => values.reduce((earliest, value) => value < earliest ? value : earliest)

export function monthEndKey(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10)
}

export function remainingCalendarWeeks(month: string, currentDateKey: string, validFrom: string, validTo?: string) {
  const start = maxDateKey(`${month}-01`, currentDateKey, validFrom)
  const end = minDateKey(monthEndKey(month), validTo ?? '9999-12-31')
  if (start > end) return 0
  return (Math.floor((dateValue(end) - dateValue(start)) / DAY_MS) + 1) / 7
}

export function calculateDpcPace(input: {
  month: string
  currentDateKey: string
  monthlyThreshold: number
  grossIncome: number
  hourlyRate?: number
  contractValidFrom: string
  contractValidTo?: string
}) {
  const remainingIncome = Math.max(0, input.monthlyThreshold - input.grossIncome)
  const thresholdReached = remainingIncome === 0
  const remainingWeeks = remainingCalendarWeeks(
    input.month,
    input.currentDateKey,
    input.contractValidFrom,
    input.contractValidTo,
  )
  const targetHours = input.hourlyRate ? input.monthlyThreshold / input.hourlyRate : undefined
  const remainingHours = input.hourlyRate ? remainingIncome / input.hourlyRate : undefined
  const weeklyHours = thresholdReached
    ? 0
    : remainingHours !== undefined && remainingWeeks > 0
      ? remainingHours / remainingWeeks
      : undefined
  return { targetHours, remainingHours, remainingIncome, remainingWeeks, weeklyHours, thresholdReached }
}

const monthIndex = (month: string) => {
  const [year, monthNumber] = month.split('-').map(Number)
  return year * 12 + monthNumber - 1
}

export function calculateDppMonthlyBudget(input: {
  month: string
  annualLimitHours: number
  dppYearHours: number
  dppMonthHours: number
  contractValidFrom: string
  contractValidTo?: string
}) {
  const year = Number(input.month.slice(0, 4))
  const currentMonthStart = `${input.month}-01`
  const periodStart = maxDateKey(currentMonthStart, input.contractValidFrom)
  const periodEnd = minDateKey(`${year}-12-31`, input.contractValidTo ?? `${year}-12-31`)
  const remainingMonths = periodStart > periodEnd
    ? 0
    : monthIndex(periodEnd.slice(0, 7)) - monthIndex(periodStart.slice(0, 7)) + 1
  const hoursBeforeMonth = Math.max(0, input.dppYearHours - input.dppMonthHours)
  const fundAtMonthStart = Math.max(0, input.annualLimitHours - hoursBeforeMonth)
  const monthlyBudgetHours = remainingMonths > 0 ? fundAtMonthStart / remainingMonths : 0
  return {
    annualRemainingHours: Math.max(0, input.annualLimitHours - input.dppYearHours),
    remainingMonths,
    monthlyBudgetHours,
    monthlyBudgetRemainingHours: Math.max(0, monthlyBudgetHours - input.dppMonthHours),
  }
}
