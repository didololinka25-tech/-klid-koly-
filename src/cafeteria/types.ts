export type MealVariant = { id: string; mealDayId: string; name: string; note: string | null; sortOrder: number }
export type CafeteriaMealDayStatus = 'draft' | 'published' | 'cancelled'
export type MealDay = { id: string; mealDate: string; cutoffAt: string; status: CafeteriaMealDayStatus; note: string | null; variants: MealVariant[] }
export type CafeteriaFamily = { id: string; displayName: string }
export type CafeteriaDiner = {
  id: string
  fullName: string
  dinerType: 'child' | 'adult'
  profileId: string | null
  familyId: string | null
  accountId: string
  portionCategoryId: string
  portionName: string | null
}
export type CafeteriaAccount = { id: string; familyId: string | null; label: string; variableSymbol: string | null }
export type CafeteriaRoleUser = { userId: string; fullName: string; roles: string[] }
export type CafeteriaSettings = { cutoffDaysBefore: number; cutoffTime: string; paymentMode: 'credit' | 'postpaid' | 'mixed'; allowNegativeBalance: boolean; negativeBalanceLimit: number | null }
export type CafeteriaOrderStatus = 'ordered' | 'cancelled'
export type CafeteriaOrder = {
  id: string
  dinerId: string
  mealDayId: string
  mealVariantId: string
  accountId: string
  portionCategoryId: string
  unitPrice: number
  quantity: number
  status: CafeteriaOrderStatus
  orderedAt: string
  cancelledAt: string | null
}
export type CafeteriaLateRequestType = 'add' | 'cancel' | 'change_variant'
export type CafeteriaLateRequestStatus = 'pending' | 'approved' | 'denied'
export type CafeteriaBillingOutcome = 'charged' | 'not_charged' | 'not_applicable' | null
export type CafeteriaLateChangeRequest = {
  id: string
  orderId: string | null
  dinerId: string
  mealDayId: string
  requestType: CafeteriaLateRequestType
  requestedVariantId: string | null
  status: CafeteriaLateRequestStatus
  billingOutcome: CafeteriaBillingOutcome
  requestedAt: string
}
export type CafeteriaPriceRule = {
  id: string
  portionCategoryId: string
  validFrom: string
  validTo: string | null
  price: number
  active: boolean
}
export type WeekRange = { start: string; end: string }
export type MealWeekDay = {
  mealDate: string
  meal: MealDay | null
  order: CafeteriaOrder | null
  lateRequest: CafeteriaLateChangeRequest | null
  price: number | null
}
export type CafeteriaMealWeek = { week: WeekRange; diner: CafeteriaDiner; days: MealWeekDay[] }
export type CafeteriaFamilyMealWeek = { week: WeekRange; diners: CafeteriaDiner[]; dinerWeeks: CafeteriaMealWeek[] }
export type CafeteriaDraftChoice = { ordered: boolean; variantId: string | null }
export type CafeteriaOrderDraft = Record<string, CafeteriaDraftChoice>
export type CafeteriaOrderDraftAction = 'create' | 'cancel' | 'reorder' | 'change_variant'
export type CafeteriaOrderDraftChange = {
  key: string
  dinerId: string
  dinerName: string
  mealDate: string
  mealDayId: string
  orderId: string | null
  action: CafeteriaOrderDraftAction
  variantId: string | null
}
export type CafeteriaDraftSaveResult = {
  saved: number
  failed: Array<{ change: CafeteriaOrderDraftChange; message: string }>
}
export type CafeteriaFulfillmentStatus = 'waiting' | 'boxed' | 'issued'
export type CafeteriaKitchenCount = {
  mealDayId: string
  mealDate: string
  cutoffAt: string
  mealVariantId: string
  mealVariantName: string
  portionCategoryId: string
  portionCode: string
  portionName: string
  cutoffCount: number
  currentCount: number
  lateDelta: number
}
export type CafeteriaKitchenPortion = { id: string; code: string; name: string; sortOrder: number }
export type CafeteriaKitchenServiceOrder = {
  orderId: string
  dinerId: string
  dinerName: string
  quantity: number
  portionCode: string
  portionName: string
  variantId: string
  variantName: string
  fulfillmentStatus: CafeteriaFulfillmentStatus
}
export type CafeteriaKitchenDiner = {
  dinerId: string
  dinerName: string
  portionCategoryId: string
  portionCode: string
  portionName: string
}
export type CafeteriaKitchenLateRequest = {
  requestId: string
  requestType: CafeteriaLateRequestType
  requestedAt: string
  mealDayId: string
  mealDate: string
  dinerId: string
  dinerName: string
  portionName: string
  orderId: string | null
  currentVariantId: string | null
  currentVariantName: string | null
  requestedVariantId: string | null
  requestedVariantName: string | null
}
export type CafeteriaKitchenTotals = { cutoff: number; late: number; current: number; small: number; large: number }
export type BulkWeekResult = {
  ordered: number
  needsVariant: string[]
  closed: string[]
  missingPrice: string[]
  failed: Array<{ mealDate: string; message: string }>
}
export type CafeteriaData = {
  meals: MealDay[]
  families: CafeteriaFamily[]
  diners: CafeteriaDiner[]
  orderingDiners: CafeteriaDiner[]
  accounts: CafeteriaAccount[]
  ownFamilies: CafeteriaFamily[]
  ownDiners: CafeteriaDiner[]
  ownAccounts: CafeteriaAccount[]
  roleUsers: CafeteriaRoleUser[]
  settings: CafeteriaSettings | null
}
