import type {
  CafeteriaLateChangeRequest,
  CafeteriaFamilyMealWeek,
  CafeteriaDraftChoice,
  CafeteriaMealWeek,
  CafeteriaOrderDraft,
  CafeteriaOrderDraftChange,
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

export const orderDraftKey = (dinerId: string, mealDayId: string) => `${dinerId}:${mealDayId}`

export function serverChoice(day: MealWeekDay): CafeteriaDraftChoice {
  const ordered = day.order?.status === 'ordered'
  return { ordered, variantId: ordered ? day.order?.mealVariantId ?? null : null }
}

export function effectiveChoice(day: MealWeekDay, dinerId: string, draft: CafeteriaOrderDraft): CafeteriaDraftChoice {
  if (!day.meal) return { ordered: false, variantId: null }
  return draft[orderDraftKey(dinerId, day.meal.id)] ?? serverChoice(day)
}

export function updateOrderDraft(
  draft: CafeteriaOrderDraft,
  dinerId: string,
  day: MealWeekDay,
  choice: CafeteriaDraftChoice,
): CafeteriaOrderDraft {
  if (!day.meal) return draft
  const key = orderDraftKey(dinerId, day.meal.id)
  const original = serverChoice(day)
  const normalized = choice.ordered ? choice : { ordered: false, variantId: null }
  const next = { ...draft }
  if (normalized.ordered === original.ordered && normalized.variantId === original.variantId) delete next[key]
  else next[key] = normalized
  return next
}

export function toggleSingleVariant(
  draft: CafeteriaOrderDraft,
  dinerId: string,
  day: MealWeekDay,
): CafeteriaOrderDraft {
  if (!day.meal || day.meal.status !== 'published' || day.meal.variants.length !== 1) return draft
  const current = effectiveChoice(day, dinerId, draft)
  return updateOrderDraft(draft, dinerId, day, {
    ordered: !current.ordered,
    variantId: current.ordered ? null : day.meal.variants[0].id,
  })
}

export function chooseDraftVariant(
  draft: CafeteriaOrderDraft,
  dinerId: string,
  day: MealWeekDay,
  variantId: string | null,
): CafeteriaOrderDraft {
  if (!day.meal || day.meal.status !== 'published') return draft
  if (variantId && !day.meal.variants.some((variant) => variant.id === variantId)) return draft
  return updateOrderDraft(draft, dinerId, day, { ordered: Boolean(variantId), variantId })
}

export function draftAllForDiner(
  familyWeek: CafeteriaFamilyMealWeek,
  dinerId: string,
  draft: CafeteriaOrderDraft,
  now = new Date(),
): CafeteriaOrderDraft {
  const dinerWeek = familyWeek.dinerWeeks.find((item) => item.diner.id === dinerId)
  if (!dinerWeek) return draft
  return dinerWeek.days.reduce((next, day) => {
    if (!day.meal || day.meal.status !== 'published' || !isBeforeCutoff(day, now) || day.meal.variants.length !== 1 || day.price == null) return next
    if (effectiveChoice(day, dinerId, next).ordered) return next
    return updateOrderDraft(next, dinerId, day, { ordered: true, variantId: day.meal.variants[0].id })
  }, draft)
}

export function orderDraftChanges(familyWeek: CafeteriaFamilyMealWeek, draft: CafeteriaOrderDraft): CafeteriaOrderDraftChange[] {
  const changes: CafeteriaOrderDraftChange[] = []
  for (const dinerWeek of familyWeek.dinerWeeks) {
    for (const day of dinerWeek.days) {
      if (!day.meal) continue
      const key = orderDraftKey(dinerWeek.diner.id, day.meal.id)
      const choice = draft[key]
      if (!choice) continue
      const original = serverChoice(day)
      const action = original.ordered
        ? choice.ordered ? 'change_variant' : 'cancel'
        : choice.ordered ? day.order?.status === 'cancelled' ? 'reorder' : 'create' : null
      if (!action) continue
      changes.push({
        key,
        dinerId: dinerWeek.diner.id,
        dinerName: dinerWeek.diner.fullName,
        mealDate: day.mealDate,
        mealDayId: day.meal.id,
        orderId: day.order?.id ?? null,
        action,
        variantId: choice.variantId,
      })
    }
  }
  return changes
}

export function dinerWeekOrderCount(dinerWeek: CafeteriaMealWeek, draft: CafeteriaOrderDraft): number {
  return dinerWeek.days.filter((day) => effectiveChoice(day, dinerWeek.diner.id, draft).ordered).length
}

export function dinerWeekHeaderPrice(dinerWeek: CafeteriaMealWeek): number | null {
  const prices = [...new Set(dinerWeek.days.filter((day) => day.meal?.status === 'published' && day.price != null).map((day) => day.price as number))]
  return prices.length === 1 ? prices[0] : null
}

export const isBeforeCutoff = (day: MealWeekDay, now = new Date()): boolean =>
  Boolean(day.meal && now.getTime() < new Date(day.meal.cutoffAt).getTime())

export function normalOrderVariant(day: MealWeekDay, selectedVariantId: string | null): string | null {
  if (!day.meal || day.meal.status !== 'published') return null
  if (day.meal.variants.length === 1) return day.meal.variants[0].id
  return selectedVariantId && day.meal.variants.some((variant) => variant.id === selectedVariantId) ? selectedVariantId : null
}

export type BulkDayDecision = 'order' | 'reorder' | 'already_ordered' | 'needs_variant' | 'closed' | 'missing_price' | 'no_menu'

export function bulkDayDecision(day: MealWeekDay, now = new Date()): BulkDayDecision {
  if (!day.meal || day.meal.status !== 'published' || day.meal.variants.length === 0) return 'no_menu'
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
