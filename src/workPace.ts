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

function relevantMonthDays(month: string, validFrom: string, validTo?: string) {
  const start = maxDateKey(`${month}-01`, validFrom)
  const end = minDateKey(monthEndKey(month), validTo ?? '9999-12-31')
  return start > end ? 0 : Math.floor((dateValue(end) - dateValue(start)) / DAY_MS) + 1
}

function remainingCalendarDays(month: string, currentDateKey: string, validFrom: string, validTo?: string) {
  const start = maxDateKey(`${month}-01`, currentDateKey, validFrom)
  const end = minDateKey(monthEndKey(month), validTo ?? '9999-12-31')
  return start > end ? 0 : Math.floor((dateValue(end) - dateValue(start)) / DAY_MS) + 1
}

export function calculateDpcPace(input: {
  month: string
  currentDateKey: string
  monthlyThreshold: number
  grossIncome: number
  workedHours: number
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
  const contractPeriodDays = relevantMonthDays(input.month, input.contractValidFrom, input.contractValidTo)
  const calendarMonthDays = relevantMonthDays(input.month, `${input.month}-01`)
  const daysRemaining = remainingCalendarDays(input.month, input.currentDateKey, input.contractValidFrom, input.contractValidTo)
  const baselineWeeks = calendarMonthDays / 7
  const targetHours = input.hourlyRate ? input.monthlyThreshold / input.hourlyRate : undefined
  const remainingHours = input.hourlyRate ? remainingIncome / input.hourlyRate : undefined
  // Měsíční hranice je celoměsíční údaj. Datum začátku smlouvy omezuje pouze
  // skutečně zbývající období, nesmí ale vměstnat celý měsíční cíl do pár dnů.
  const baselineWeeklyHours = targetHours !== undefined && baselineWeeks > 0
    ? targetHours / baselineWeeks
    : undefined
  const remainingWeeklyHours = thresholdReached
    ? 0
    : remainingHours !== undefined && daysRemaining >= 7 && remainingWeeks > 0
      ? remainingHours / remainingWeeks
      : undefined
  const elapsedDays = Math.max(0, contractPeriodDays - daysRemaining + 1)
  const elapsedWeeks = elapsedDays / 7
  const averageWorkedWeeklyHours = elapsedWeeks > 0 ? input.workedHours / elapsedWeeks : 0
  const behindBaseline = !thresholdReached
    && baselineWeeklyHours !== undefined
    && elapsedWeeks >= 1
    && averageWorkedWeeklyHours + 0.01 < baselineWeeklyHours
  return {
    targetHours,
    remainingHours,
    remainingIncome,
    remainingWeeks,
    daysRemaining,
    baselineWeeklyHours,
    remainingWeeklyHours,
    elapsedWeeks,
    averageWorkedWeeklyHours,
    behindBaseline,
    thresholdReached,
  }
}

function formatPaceHours(hours?: number) {
  if (hours === undefined) return undefined
  const minutes = Math.max(0, Math.round(hours * 60))
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

export function calculateDpcPaceCard(input: Parameters<typeof calculateDpcPace>[0]) {
  const pace = calculateDpcPace(input)
  return {
    pace,
    baselineWeeklyText: formatPaceHours(pace.baselineWeeklyHours),
    remainingHoursText: formatPaceHours(pace.remainingHours),
    remainingWeeklyText: formatPaceHours(pace.remainingWeeklyHours),
  }
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
