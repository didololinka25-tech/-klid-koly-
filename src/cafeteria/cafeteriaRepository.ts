import { supabase } from '../supabase'
import { isMissingCafeteriaSchema, type CafeteriaRole } from '../system/access'
import { buildMealWeek, bulkDayDecision, pragueDateKey } from './orderingModel'
import type {
  BulkWeekResult,
  CafeteriaAccount,
  CafeteriaData,
  CafeteriaDiner,
  CafeteriaDraftSaveResult,
  CafeteriaFamilyMealWeek,
  CafeteriaFamily,
  CafeteriaFulfillmentStatus,
  CafeteriaKitchenCount,
  CafeteriaKitchenDiner,
  CafeteriaKitchenLateRequest,
  CafeteriaKitchenPortion,
  CafeteriaKitchenServiceOrder,
  CafeteriaLateChangeRequest,
  CafeteriaLateRequestType,
  CafeteriaMealWeek,
  CafeteriaOrder,
  CafeteriaOrderDraftChange,
  CafeteriaPriceRule,
  CafeteriaRoleUser,
  CafeteriaSettings,
  MealDay,
  WeekRange,
} from './types'

type DbError = { code?: string; message?: string } | null
type DinerRow = {
  id: string
  diner_type: 'child' | 'adult'
  full_name: string
  profile_id: string | null
  family_id: string | null
  account_id: string
  portion_category_id: string
  cafeteria_portion_categories: { name: string } | Array<{ name: string }> | null
}
type MealDayRow = { id: string; meal_date: string; cutoff_at: string; note: string | null; status: 'draft' | 'published' | 'cancelled' }
type MealVariantRow = { id: string; meal_day_id: string; name: string; note: string | null; sort_order: number }
type OrderRow = {
  id: string
  diner_id: string
  meal_day_id: string
  meal_variant_id: string
  account_id: string
  portion_category_id: string
  unit_price: number | string
  status: 'ordered' | 'cancelled'
  ordered_at: string
  cancelled_at: string | null
}
type PriceRuleRow = { id: string; portion_category_id: string; valid_from: string; valid_to: string | null; price: number | string; active: boolean }
type LateRequestRow = {
  id: string
  order_id: string | null
  diner_id: string
  meal_day_id: string
  request_type: CafeteriaLateRequestType
  requested_variant_id: string | null
  status: 'pending' | 'approved' | 'denied'
  billing_outcome: 'charged' | 'not_charged' | 'not_applicable' | null
  requested_at: string
}
type KitchenCountRow = {
  meal_day_id: string; meal_date: string; cutoff_at: string; meal_variant_id: string; meal_variant_name: string
  portion_category_id: string; portion_code: string; portion_name: string
  cutoff_count: number | string; current_count: number | string; late_delta: number | string
}
type KitchenServiceRow = {
  order_id: string; diner_id: string; diner_name: string; portion_code: string; portion_name: string
  variant_id: string; variant_name: string; fulfillment_status: CafeteriaFulfillmentStatus
}
type KitchenDinerRow = {
  diner_id: string; diner_name: string; portion_category_id: string; portion_code: string; portion_name: string
}
type KitchenLateRequestRow = {
  request_id: string; request_type: CafeteriaLateRequestType; requested_at: string
  meal_day_id: string; meal_date: string; diner_id: string; diner_name: string; portion_name: string
  order_id: string | null; current_variant_id: string | null; current_variant_name: string | null
  requested_variant_id: string | null; requested_variant_name: string | null
}

function client() {
  if (!supabase) throw new Error('Supabase není nakonfigurovaný.')
  return supabase
}

const knownDatabaseMessages = [
  'Pro tento den je nutné vybrat variantu jídla.',
  'Pro tento den není aktivní žádná varianta jídla.',
  'Vybraná varianta nepatří k tomuto jídelnímu dni.',
  'Pro tuto porci není nastavená platná cena.',
  'Strávník není aktivní.',
  'Strávník není pro tento den aktivní.',
  'Jídelní den není zveřejněný.',
  'Uzávěrka ještě neproběhla; použijte běžnou změnu objednávky.',
  'Není aktivní objednávka, kterou lze pozdě zrušit.',
  'Není aktivní objednávka, u které lze změnit variantu.',
  'Oběd už je objednaný.',
  'Je nutné vybrat variantu jídla.',
  'Změnu už nelze uložit, protože proběhla uzávěrka nebo nemáte oprávnění.',
  'Objednávka se mezitím změnila. Zkontrolujte aktuální stav.',
  'Žádost už čeká na potvrzení.',
  'Nemáte oprávnění pro výdej obědů.',
  'Nemáte oprávnění hledat strávníky.',
  'Nemáte oprávnění měnit stav výdeje.',
  'Nemáte oprávnění číst pozdní žádosti.',
  'Nemáte oprávnění rozhodovat pozdní změny.',
  'Aktivní dnešní objednávka nebyla nalezena.',
  'Neplatný stav výdeje.',
  'O této žádosti už bylo rozhodnuto.',
  'U pozdního zrušení je nutné určit, zda se oběd účtuje.',
  'Kuchyňský provoz zatím není aktivovaný.',
]

export function cafeteriaErrorMessage(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { code?: string; message?: string } : null
  if (isMissingCafeteriaSchema(value)) return 'Jídelna zatím není aktivována.'
  const message = value?.message ?? (error instanceof Error ? error.message : '')
  const known = knownDatabaseMessages.find((item) => message.includes(item))
  if (known) return known
  if (message.includes('Jídelna zatím není aktivována.')) return 'Jídelna zatím není aktivována.'
  if (message.includes('cafeteria_late_change_one_pending')) return 'Žádost už čeká na potvrzení.'
  if (value?.code === 'PGRST202') return 'Kuchyňský provoz zatím není aktivovaný.'
  if (value?.code === '23505') return 'Objednávka se mezitím změnila. Zkontrolujte aktuální stav.'
  if (value?.code === '42501' || value?.code === 'PGRST116') return 'Změnu už nelze uložit, protože proběhla uzávěrka nebo nemáte oprávnění.'
  return 'Operaci se nepodařilo dokončit. Zkuste to prosím znovu.'
}

const failIfError = (error: DbError) => {
  if (error) throw new Error(cafeteriaErrorMessage(error))
}

const dinerSelect = 'id,diner_type,full_name,profile_id,family_id,account_id,portion_category_id,cafeteria_portion_categories(name)'
const orderSelect = 'id,diner_id,meal_day_id,meal_variant_id,account_id,portion_category_id,unit_price,status,ordered_at,cancelled_at'
const lateRequestSelect = 'id,order_id,diner_id,meal_day_id,request_type,requested_variant_id,status,billing_outcome,requested_at'

const mapDiner = (row: DinerRow): CafeteriaDiner => {
  const portion = Array.isArray(row.cafeteria_portion_categories) ? row.cafeteria_portion_categories[0] : row.cafeteria_portion_categories
  return {
    id: row.id,
    dinerType: row.diner_type,
    fullName: row.full_name,
    profileId: row.profile_id,
    familyId: row.family_id,
    accountId: row.account_id,
    portionCategoryId: row.portion_category_id,
    portionName: portion?.name ?? null,
  }
}

const mapOrder = (row: OrderRow): CafeteriaOrder => ({
  id: row.id,
  dinerId: row.diner_id,
  mealDayId: row.meal_day_id,
  mealVariantId: row.meal_variant_id,
  accountId: row.account_id,
  portionCategoryId: row.portion_category_id,
  unitPrice: Number(row.unit_price),
  status: row.status,
  orderedAt: row.ordered_at,
  cancelledAt: row.cancelled_at,
})

const mapLateRequest = (row: LateRequestRow): CafeteriaLateChangeRequest => ({
  id: row.id,
  orderId: row.order_id,
  dinerId: row.diner_id,
  mealDayId: row.meal_day_id,
  requestType: row.request_type,
  requestedVariantId: row.requested_variant_id,
  status: row.status,
  billingOutcome: row.billing_outcome,
  requestedAt: row.requested_at,
})

async function loadMeals(includeUnpublished = false, week?: WeekRange): Promise<MealDay[]> {
  const db = client()
  let dayQuery = db.from('cafeteria_meal_days').select('id,meal_date,cutoff_at,note,status').order('meal_date')
  if (!includeUnpublished) dayQuery = dayQuery.in('status', ['published', 'cancelled'])
  if (week) dayQuery = dayQuery.gte('meal_date', week.start).lte('meal_date', week.end)
  const days = await dayQuery
  failIfError(days.error)
  const dayRows = (days.data ?? []) as unknown as MealDayRow[]
  const ids = dayRows.map((row) => row.id)
  const variants = ids.length
    ? await db.from('cafeteria_meal_variants').select('id,meal_day_id,name,note,sort_order').in('meal_day_id', ids).eq('active', true).order('sort_order')
    : { data: [], error: null }
  failIfError(variants.error)
  const variantRows = (variants.data ?? []) as unknown as MealVariantRow[]
  return dayRows.map((row) => ({
    id: row.id,
    mealDate: row.meal_date,
    cutoffAt: row.cutoff_at,
    status: row.status,
    note: row.note ?? null,
    variants: variantRows.filter((variant) => variant.meal_day_id === row.id).map((variant) => ({
      id: variant.id,
      mealDayId: variant.meal_day_id,
      name: variant.name,
      note: variant.note ?? null,
      sortOrder: Number(variant.sort_order),
    })),
  }))
}

async function familyIdsForUser(userId: string): Promise<string[]> {
  const today = pragueDateKey()
  const links = await client().from('cafeteria_family_users').select('family_id')
    .eq('user_id', userId).eq('active', true).lte('valid_from', today).or(`valid_to.is.null,valid_to.gte.${today}`)
  failIfError(links.error)
  return [...new Set((links.data ?? []).map((row) => String(row.family_id)))]
}

async function loadAvailableDiners(userId: string, roles: CafeteriaRole[]): Promise<CafeteriaDiner[]> {
  const db = client()
  const familyIds = roles.includes('parent') ? await familyIdsForUser(userId) : []
  const requests = []
  if (familyIds.length) requests.push(db.from('cafeteria_diners').select(dinerSelect).in('family_id', familyIds).eq('active', true).order('full_name'))
  if (roles.includes('diner')) requests.push(db.from('cafeteria_diners').select(dinerSelect).eq('profile_id', userId).eq('active', true).order('full_name'))
  if (!requests.length) return []
  const results = await Promise.all(requests)
  const diners = new Map<string, CafeteriaDiner>()
  for (const result of results) {
    failIfError(result.error)
    for (const row of (result.data ?? []) as unknown as DinerRow[]) diners.set(row.id, mapDiner(row))
  }
  return [...diners.values()].sort((a, b) => a.fullName.localeCompare(b.fullName, 'cs'))
}

async function loadFamilies(userId: string): Promise<{ families: CafeteriaFamily[]; diners: CafeteriaDiner[]; accounts: CafeteriaAccount[] }> {
  const db = client()
  const familyIds = await familyIdsForUser(userId)
  if (!familyIds.length) return { families: [], diners: [], accounts: [] }
  const [families, diners, accounts] = await Promise.all([
    db.from('cafeteria_families').select('id,display_name').in('id', familyIds).eq('active', true).order('display_name'),
    db.from('cafeteria_diners').select(dinerSelect).in('family_id', familyIds).eq('active', true).order('full_name'),
    db.from('cafeteria_accounts').select('id,family_id,label,variable_symbol').in('family_id', familyIds).eq('active', true).order('label'),
  ])
  failIfError(families.error); failIfError(diners.error); failIfError(accounts.error)
  return {
    families: ((families.data ?? []) as Array<{ id: string; display_name: string }>).map((row) => ({ id: row.id, displayName: row.display_name })),
    diners: ((diners.data ?? []) as unknown as DinerRow[]).map(mapDiner),
    accounts: ((accounts.data ?? []) as Array<{ id: string; family_id: string | null; label: string; variable_symbol: string | null }>).map(mapAccount),
  }
}

async function loadOwnDiners(userId: string): Promise<CafeteriaDiner[]> {
  const result = await client().from('cafeteria_diners').select(dinerSelect).eq('profile_id', userId).eq('active', true).order('full_name')
  failIfError(result.error)
  return ((result.data ?? []) as unknown as DinerRow[]).map(mapDiner)
}

const mapAccount = (row: { id: string; family_id: string | null; label: string; variable_symbol: string | null }): CafeteriaAccount => ({
  id: row.id,
  familyId: row.family_id ?? null,
  label: row.label,
  variableSymbol: row.variable_symbol ?? null,
})

async function loadAdminData(): Promise<{ families: CafeteriaFamily[]; diners: CafeteriaDiner[]; accounts: CafeteriaAccount[]; roleUsers: CafeteriaRoleUser[]; settings: CafeteriaSettings | null }> {
  const db = client()
  const [families, diners, accounts, roles, settings] = await Promise.all([
    db.from('cafeteria_families').select('id,display_name').order('display_name'),
    db.from('cafeteria_diners').select(dinerSelect).order('full_name'),
    db.from('cafeteria_accounts').select('id,family_id,label,variable_symbol').order('label'),
    db.from('user_module_roles').select('user_id,role,profiles(full_name)').eq('module', 'cafeteria').order('user_id'),
    db.from('cafeteria_settings').select('cutoff_days_before,cutoff_time,payment_mode,allow_negative_balance,negative_balance_limit').eq('id', true).maybeSingle(),
  ])
  ;[families, diners, accounts, roles, settings].forEach((result) => failIfError(result.error))
  const roleUsers = new Map<string, CafeteriaRoleUser>()
  for (const row of (roles.data ?? []) as unknown as Array<{ user_id: string; role: string; profiles: { full_name: string } | Array<{ full_name: string }> | null }>) {
    const linkedProfile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles
    const current = roleUsers.get(row.user_id) ?? { userId: row.user_id, fullName: linkedProfile?.full_name ?? 'Uživatel', roles: [] }
    current.roles.push(row.role)
    roleUsers.set(current.userId, current)
  }
  const settingRow = settings.data as null | { cutoff_days_before: number; cutoff_time: string; payment_mode: CafeteriaSettings['paymentMode']; allow_negative_balance: boolean; negative_balance_limit: number | string | null }
  return {
    families: ((families.data ?? []) as Array<{ id: string; display_name: string }>).map((row) => ({ id: row.id, displayName: row.display_name })),
    diners: ((diners.data ?? []) as unknown as DinerRow[]).map(mapDiner),
    accounts: ((accounts.data ?? []) as Array<{ id: string; family_id: string | null; label: string; variable_symbol: string | null }>).map(mapAccount),
    roleUsers: [...roleUsers.values()],
    settings: settingRow ? {
      cutoffDaysBefore: Number(settingRow.cutoff_days_before),
      cutoffTime: String(settingRow.cutoff_time).slice(0, 5),
      paymentMode: settingRow.payment_mode,
      allowNegativeBalance: Boolean(settingRow.allow_negative_balance),
      negativeBalanceLimit: settingRow.negative_balance_limit == null ? null : Number(settingRow.negative_balance_limit),
    } : null,
  }
}

async function loadMealWeek(diner: CafeteriaDiner, week: WeekRange): Promise<CafeteriaMealWeek> {
  const db = client()
  const meals = await loadMeals(false, week)
  const mealDayIds = meals.map((meal) => meal.id)
  const [ordersResult, lateResult, pricesResult] = await Promise.all([
    mealDayIds.length
      ? db.from('cafeteria_orders').select(orderSelect).eq('diner_id', diner.id).in('meal_day_id', mealDayIds)
      : Promise.resolve({ data: [], error: null }),
    mealDayIds.length
      ? db.from('cafeteria_late_change_requests').select(lateRequestSelect).eq('diner_id', diner.id).in('meal_day_id', mealDayIds).order('requested_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    db.from('cafeteria_price_rules').select('id,portion_category_id,valid_from,valid_to,price,active')
      .eq('portion_category_id', diner.portionCategoryId).eq('active', true).lte('valid_from', week.end).or(`valid_to.is.null,valid_to.gte.${week.start}`),
  ])
  failIfError(ordersResult.error); failIfError(lateResult.error); failIfError(pricesResult.error)
  const orders = ((ordersResult.data ?? []) as unknown as OrderRow[]).map(mapOrder)
  const lateRequests = ((lateResult.data ?? []) as unknown as LateRequestRow[]).map(mapLateRequest)
  const priceRules: CafeteriaPriceRule[] = ((pricesResult.data ?? []) as unknown as PriceRuleRow[]).map((row) => ({
    id: row.id,
    portionCategoryId: row.portion_category_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    price: Number(row.price),
    active: row.active,
  }))
  return { week, diner, days: buildMealWeek({ week, portionCategoryId: diner.portionCategoryId, meals, orders, priceRules, lateRequests }) }
}

async function loadFamilyMealWeek(diners: CafeteriaDiner[], week: WeekRange): Promise<CafeteriaFamilyMealWeek> {
  const db = client()
  const meals = await loadMeals(false, week)
  if (!diners.length) return { week, diners: [], dinerWeeks: [] }
  const mealDayIds = meals.map((meal) => meal.id)
  const dinerIds = diners.map((diner) => diner.id)
  const portionCategoryIds = [...new Set(diners.map((diner) => diner.portionCategoryId))]
  const [ordersResult, lateResult, pricesResult] = await Promise.all([
    mealDayIds.length
      ? db.from('cafeteria_orders').select(orderSelect).in('diner_id', dinerIds).in('meal_day_id', mealDayIds)
      : Promise.resolve({ data: [], error: null }),
    mealDayIds.length
      ? db.from('cafeteria_late_change_requests').select(lateRequestSelect).in('diner_id', dinerIds).in('meal_day_id', mealDayIds).order('requested_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    mealDayIds.length
      ? db.from('cafeteria_price_rules').select('id,portion_category_id,valid_from,valid_to,price,active')
        .in('portion_category_id', portionCategoryIds).eq('active', true).lte('valid_from', week.end).or(`valid_to.is.null,valid_to.gte.${week.start}`)
      : Promise.resolve({ data: [], error: null }),
  ])
  failIfError(ordersResult.error); failIfError(lateResult.error); failIfError(pricesResult.error)
  const orders = ((ordersResult.data ?? []) as unknown as OrderRow[]).map(mapOrder)
  const lateRequests = ((lateResult.data ?? []) as unknown as LateRequestRow[]).map(mapLateRequest)
  const priceRules: CafeteriaPriceRule[] = ((pricesResult.data ?? []) as unknown as PriceRuleRow[]).map((row) => ({
    id: row.id,
    portionCategoryId: row.portion_category_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    price: Number(row.price),
    active: row.active,
  }))
  return {
    week,
    diners,
    dinerWeeks: diners.map((diner) => ({
      week,
      diner,
      days: buildMealWeek({
        week,
        portionCategoryId: diner.portionCategoryId,
        meals,
        orders: orders.filter((order) => order.dinerId === diner.id),
        priceRules,
        lateRequests: lateRequests.filter((request) => request.dinerId === diner.id),
      }),
    })),
  }
}

async function createOrder(dinerId: string, mealDayId: string, mealVariantId: string): Promise<CafeteriaOrder> {
  const result = await client().from('cafeteria_orders').insert({ diner_id: dinerId, meal_day_id: mealDayId, meal_variant_id: mealVariantId, status: 'ordered' }).select(orderSelect).single()
  failIfError(result.error)
  return mapOrder(result.data as unknown as OrderRow)
}

async function updateOrder(orderId: string, values: { status?: 'ordered' | 'cancelled'; meal_variant_id?: string }): Promise<CafeteriaOrder> {
  const result = await client().from('cafeteria_orders').update(values).eq('id', orderId).select(orderSelect).single()
  failIfError(result.error)
  return mapOrder(result.data as unknown as OrderRow)
}

async function createLateRequest(input: { dinerId: string; mealDayId: string; requestType: CafeteriaLateRequestType; requestedVariantId?: string | null }): Promise<{ created: boolean; request: CafeteriaLateChangeRequest }> {
  const db = client()
  const pending = await db.from('cafeteria_late_change_requests').select(lateRequestSelect)
    .eq('diner_id', input.dinerId).eq('meal_day_id', input.mealDayId).eq('status', 'pending').maybeSingle()
  failIfError(pending.error)
  if (pending.data) return { created: false, request: mapLateRequest(pending.data as unknown as LateRequestRow) }
  const result = await db.from('cafeteria_late_change_requests').insert({
    diner_id: input.dinerId,
    meal_day_id: input.mealDayId,
    request_type: input.requestType,
    requested_variant_id: input.requestedVariantId ?? null,
  }).select(lateRequestSelect).single()
  failIfError(result.error)
  return { created: true, request: mapLateRequest(result.data as unknown as LateRequestRow) }
}

async function bulkOrderWeek(week: CafeteriaMealWeek, now = new Date()): Promise<BulkWeekResult> {
  const result: BulkWeekResult = { ordered: 0, needsVariant: [], closed: [], missingPrice: [], failed: [] }
  for (const day of week.days) {
    const decision = bulkDayDecision(day, now)
    if (decision === 'needs_variant') result.needsVariant.push(day.mealDate)
    else if (decision === 'closed') result.closed.push(day.mealDate)
    else if (decision === 'missing_price') result.missingPrice.push(day.mealDate)
    else if (decision === 'order' || decision === 'reorder') {
      try {
        const variantId = day.meal?.variants[0]?.id
        if (!variantId) continue
        if (decision === 'reorder' && day.order) await updateOrder(day.order.id, { status: 'ordered', meal_variant_id: variantId })
        else if (day.meal) await createOrder(week.diner.id, day.meal.id, variantId)
        result.ordered += 1
      } catch (error) {
        result.failed.push({ mealDate: day.mealDate, message: cafeteriaErrorMessage(error) })
      }
    }
  }
  return result
}

async function saveOrderDraft(changes: CafeteriaOrderDraftChange[]): Promise<CafeteriaDraftSaveResult> {
  const result: CafeteriaDraftSaveResult = { saved: 0, failed: [] }
  for (const change of changes) {
    try {
      if (change.action === 'create' && change.variantId) await createOrder(change.dinerId, change.mealDayId, change.variantId)
      else if (change.action === 'cancel' && change.orderId) await updateOrder(change.orderId, { status: 'cancelled' })
      else if (change.action === 'reorder' && change.orderId && change.variantId) await updateOrder(change.orderId, { status: 'ordered', meal_variant_id: change.variantId })
      else if (change.action === 'change_variant' && change.orderId && change.variantId) await updateOrder(change.orderId, { meal_variant_id: change.variantId })
      else throw new Error('Neúplná změna objednávky.')
      result.saved += 1
    } catch (error) {
      result.failed.push({ change, message: cafeteriaErrorMessage(error) })
    }
  }
  return result
}

async function loadKitchenCounts(targetDate: string): Promise<CafeteriaKitchenCount[]> {
  const result = await client().from('cafeteria_kitchen_order_counts').select(
    'meal_day_id,meal_date,cutoff_at,meal_variant_id,meal_variant_name,portion_category_id,portion_code,portion_name,cutoff_count,current_count,late_delta',
  ).eq('meal_date', targetDate)
  failIfError(result.error)
  return ((result.data ?? []) as unknown as KitchenCountRow[]).map((row) => ({
    mealDayId: row.meal_day_id,
    mealDate: row.meal_date,
    cutoffAt: row.cutoff_at,
    mealVariantId: row.meal_variant_id,
    mealVariantName: row.meal_variant_name,
    portionCategoryId: row.portion_category_id,
    portionCode: row.portion_code,
    portionName: row.portion_name,
    cutoffCount: Number(row.cutoff_count),
    currentCount: Number(row.current_count),
    lateDelta: Number(row.late_delta),
  }))
}

async function loadKitchenPortions(): Promise<CafeteriaKitchenPortion[]> {
  const result = await client().from('cafeteria_portion_categories').select('id,code,name,sort_order').eq('active', true).order('sort_order')
  failIfError(result.error)
  return ((result.data ?? []) as Array<{ id: string; code: string; name: string; sort_order: number }>).map((row) => ({
    id: row.id, code: row.code, name: row.name, sortOrder: Number(row.sort_order),
  }))
}

async function loadKitchenService(targetDate: string): Promise<CafeteriaKitchenServiceOrder[]> {
  const result = await client().rpc('cafeteria_kitchen_service', { target_date: targetDate })
  failIfError(result.error)
  return ((result.data ?? []) as unknown as KitchenServiceRow[]).map((row) => ({
    orderId: row.order_id,
    dinerId: row.diner_id,
    dinerName: row.diner_name,
    portionCode: row.portion_code,
    portionName: row.portion_name,
    variantId: row.variant_id,
    variantName: row.variant_name,
    fulfillmentStatus: row.fulfillment_status,
  }))
}

async function searchKitchenDiners(searchText: string, targetDate: string): Promise<CafeteriaKitchenDiner[]> {
  const result = await client().rpc('cafeteria_kitchen_search_diners', { search_text: searchText, target_date: targetDate })
  failIfError(result.error)
  return ((result.data ?? []) as unknown as KitchenDinerRow[]).map((row) => ({
    dinerId: row.diner_id,
    dinerName: row.diner_name,
    portionCategoryId: row.portion_category_id,
    portionCode: row.portion_code,
    portionName: row.portion_name,
  }))
}

async function setKitchenFulfillment(orderId: string, status: CafeteriaFulfillmentStatus): Promise<void> {
  const result = await client().rpc('cafeteria_set_order_fulfillment', { target_order_id: orderId, target_status: status })
  failIfError(result.error)
}

async function loadKitchenPendingRequests(): Promise<CafeteriaKitchenLateRequest[]> {
  const result = await client().rpc('cafeteria_kitchen_pending_requests')
  failIfError(result.error)
  return ((result.data ?? []) as unknown as KitchenLateRequestRow[]).map((row) => ({
    requestId: row.request_id,
    requestType: row.request_type,
    requestedAt: row.requested_at,
    mealDayId: row.meal_day_id,
    mealDate: row.meal_date,
    dinerId: row.diner_id,
    dinerName: row.diner_name,
    portionName: row.portion_name,
    orderId: row.order_id,
    currentVariantId: row.current_variant_id,
    currentVariantName: row.current_variant_name,
    requestedVariantId: row.requested_variant_id,
    requestedVariantName: row.requested_variant_name,
  }))
}

async function decideKitchenLateRequest(
  requestId: string,
  decision: 'approved' | 'denied',
  billingOutcome: 'charged' | 'not_charged' | null = null,
): Promise<void> {
  const result = await client().rpc('cafeteria_decide_late_change', {
    target_request_id: requestId,
    target_decision: decision,
    target_billing_outcome: billingOutcome,
    target_note: null,
  })
  failIfError(result.error)
}

async function addKitchenOrder(dinerId: string, mealDayId: string, mealVariantId: string): Promise<CafeteriaOrder> {
  const db = client()
  const existing = await db.from('cafeteria_orders').select(orderSelect)
    .eq('diner_id', dinerId).eq('meal_day_id', mealDayId).maybeSingle()
  failIfError(existing.error)
  if (!existing.data) return createOrder(dinerId, mealDayId, mealVariantId)
  const order = mapOrder(existing.data as unknown as OrderRow)
  if (order.status === 'ordered') throw new Error('Oběd už je objednaný.')
  return updateOrder(order.id, { status: 'ordered', meal_variant_id: mealVariantId })
}

const emptyData: CafeteriaData = {
  meals: [], families: [], diners: [], orderingDiners: [], accounts: [],
  ownFamilies: [], ownDiners: [], ownAccounts: [], roleUsers: [], settings: null,
}

export const cafeteriaRepository = {
  loadAvailableDiners,
  loadMealWeek,
  loadFamilyMealWeek,
  createOrder,
  cancelOrder: (orderId: string) => updateOrder(orderId, { status: 'cancelled' }),
  reorderOrder: (orderId: string, mealVariantId: string) => updateOrder(orderId, { status: 'ordered', meal_variant_id: mealVariantId }),
  changeOrderVariant: (orderId: string, mealVariantId: string) => updateOrder(orderId, { meal_variant_id: mealVariantId }),
  createLateRequest,
  bulkOrderWeek,
  saveOrderDraft,
  loadKitchenCounts,
  loadKitchenPortions,
  loadKitchenService,
  searchKitchenDiners,
  setKitchenFulfillment,
  loadKitchenPendingRequests,
  decideKitchenLateRequest,
  addKitchenOrder,
  load: async (roles: CafeteriaRole[], userId: string): Promise<CafeteriaData> => {
    const meals = roles.includes('admin') || roles.includes('kitchen') ? await loadMeals(roles.includes('admin')) : []
    const ownFamilyData = roles.includes('parent') ? await loadFamilies(userId) : { families: [], diners: [], accounts: [] }
    const ownDirectDiners = roles.includes('diner') ? await loadOwnDiners(userId) : []
    const orderingDiners = [...new Map([...ownFamilyData.diners, ...ownDirectDiners].map((item) => [item.id, item])).values()]
    let data: CafeteriaData = {
      ...emptyData,
      meals,
      families: ownFamilyData.families,
      diners: orderingDiners,
      accounts: ownFamilyData.accounts,
      orderingDiners,
      ownFamilies: ownFamilyData.families,
      ownDiners: ownFamilyData.diners,
      ownAccounts: ownFamilyData.accounts,
    }
    if (roles.includes('admin')) data = { ...data, ...(await loadAdminData()), orderingDiners }
    return data
  },
}
