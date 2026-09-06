import type {
  CafeteriaLateChangeRequest,
  CafeteriaOrder,
  CafeteriaPriceRule,
  MealDay,
  MealWeekDay,
  WeekRange,
} from './types'

const DAY_MS = 24 * 60 * 60 * 1000

const dateAtNoonUtc = (dateKey: string) => new Date(`${dateKey}T12:00:00Z`)
const dateKey = (date: Date) => date.toISOString().slice(0, 10)
const addDays = (value: string, days: number) => dateKey(new Date(dateAtNoonUtc(value).getTime() + days * DAY_MS))

export function pragueDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(now)
}

export function weekForDate(value: string): WeekRange {
  const date = dateAtNoonUtc(value)
  const mondayOffset = (date.getUTCDay() + 6) % 7
  const start = addDays(value, -mondayOffset)
  return { start, end: addDays(start, 4) }
}

export function shiftWeek(week: WeekRange, weeks: number): WeekRange {
  return weekForDate(addDays(week.start, weeks * 7))
}

export function weekDateKeys(week: WeekRange): string[] {
  return Array.from({ length: 5 }, (_, index) => addDays(week.start, index))
}

export function isCurrentWeek(week: WeekRange, now = new Date()): boolean {
  return week.start === weekForDate(pragueDateKey(now)).start
}

export function formatWeekLabel(week: WeekRange): string {
  const start = dateAtNoonUtc(week.start)
  const end = dateAtNoonUtc(week.end)
  const startDay = start.getUTCDate()
  const endDay = end.getUTCDate()
  const formatter = new Intl.DateTimeFormat('cs-CZ', { month: 'long', timeZone: 'UTC' })
  if (start.getUTCMonth() === end.getUTCMonth()) return `${startDay}.–${endDay}. ${formatter.format(end)}`
  return `${startDay}. ${formatter.format(start)} – ${endDay}. ${formatter.format(end)}`
}

export function showDinerPicker(dinerCount: number): boolean {
  return dinerCount > 1
}

export function applicablePrice(rules: CafeteriaPriceRule[], portionCategoryId: string, mealDate: string): number | null {
  const matches = rules
    .filter((rule) => rule.active && rule.portionCategoryId === portionCategoryId && rule.validFrom <= mealDate && (!rule.validTo || rule.validTo >= mealDate))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
  return matches[0]?.price ?? null
}

function relevantLateRequest(requests: CafeteriaLateChangeRequest[], mealDayId: string): CafeteriaLateChangeRequest | null {
  const matches = requests.filter((request) => request.mealDayId === mealDayId)
  return matches.find((request) => request.status === 'pending')
    ?? matches.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0]
    ?? null
}

export function buildMealWeek(input: {
  week: WeekRange
  portionCategoryId: string
  meals: MealDay[]
  orders: CafeteriaOrder[]
  priceRules: CafeteriaPriceRule[]
  lateRequests: CafeteriaLateChangeRequest[]
}): MealWeekDay[] {
  return weekDateKeys(input.week).map((mealDate) => {
    const meal = input.meals.find((item) => item.mealDate === mealDate) ?? null
    const order = meal ? input.orders.find((item) => item.mealDayId === meal.id) ?? null : null
    return {
      mealDate,
      meal,
      order,
      lateRequest: meal ? relevantLateRequest(input.lateRequests, meal.id) : null,
      price: order?.status === 'ordered' ? order.unitPrice : applicablePrice(input.priceRules, input.portionCategoryId, mealDate),
    }
  })
}

export const isBeforeCutoff = (day: MealWeekDay, now = new Date()): boolean =>
  Boolean(day.meal && now.getTime() < new Date(day.meal.cutoffAt).getTime())

export function normalOrderVariant(day: MealWeekDay, selectedVariantId: string | null): string | null {
  if (!day.meal) return null
  if (day.meal.variants.length === 1) return day.meal.variants[0].id
  return selectedVariantId && day.meal.variants.some((variant) => variant.id === selectedVariantId) ? selectedVariantId : null
}

export type BulkDayDecision = 'order' | 'reorder' | 'already_ordered' | 'needs_variant' | 'closed' | 'missing_price' | 'no_menu'

export function bulkDayDecision(day: MealWeekDay, now = new Date()): BulkDayDecision {
  if (!day.meal || day.meal.variants.length === 0) return 'no_menu'
  if (day.order?.status === 'ordered') return 'already_ordered'
  if (!isBeforeCutoff(day, now)) return 'closed'
  if (day.meal.variants.length !== 1) return 'needs_variant'
  if (day.price == null) return 'missing_price'
  return day.order?.status === 'cancelled' ? 'reorder' : 'order'
}

export function lateRequestMessage(request: CafeteriaLateChangeRequest): string {
  if (request.status === 'pending') return '⏳ Čeká na potvrzení'
  if (request.status === 'denied') return 'Žádost o změnu nebyla schválena.'
  if (request.requestType === 'cancel' && request.billingOutcome === 'not_charged') return '✅ Oběd byl odhlášen bez účtování.'
  if (request.requestType === 'cancel' && request.billingOutcome === 'charged') return 'Oběd byl odhlášen, ale bude účtován.'
  if (request.requestType === 'add') return '✅ Dodatečné přihlášení bylo schváleno.'
  if (request.requestType === 'change_variant') return '✅ Změna jídla byla schválena.'
  return 'Žádost byla vyřízena.'
}

export function lateRequestTypeFor(day: MealWeekDay): 'add' | 'cancel' {
  return day.order?.status === 'ordered' ? 'cancel' : 'add'
}
