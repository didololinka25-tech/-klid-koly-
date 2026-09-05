import { supabase } from '../supabase'
import { isMissingCafeteriaSchema, type CafeteriaRole } from '../system/access'
import type { CafeteriaAccount, CafeteriaData, CafeteriaDiner, CafeteriaFamily, CafeteriaRoleUser, CafeteriaSettings, MealDay } from './types'

function client() {
  if (!supabase) throw new Error('Supabase není nakonfigurovaný.')
  return supabase
}

const failIfError = (error: { code?: string; message?: string } | null) => {
  if (isMissingCafeteriaSchema(error)) throw new Error('Jídelna zatím není aktivována.')
  if (error) throw error
}

async function loadMeals(includeUnpublished = false): Promise<MealDay[]> {
  const db = client()
  let dayQuery = db.from('cafeteria_meal_days').select('id,meal_date,cutoff_at,note,status').order('meal_date')
  if (!includeUnpublished) dayQuery = dayQuery.eq('status', 'published')
  const days = await dayQuery
  failIfError(days.error)
  const ids = (days.data ?? []).map((row: any) => row.id)
  const variants = ids.length
    ? await db.from('cafeteria_meal_variants').select('id,meal_day_id,name,note,sort_order').in('meal_day_id', ids).eq('active', true).order('sort_order')
    : { data: [], error: null }
  failIfError(variants.error)
  return (days.data ?? []).map((row: any) => ({
    id: row.id,
    mealDate: row.meal_date,
    cutoffAt: row.cutoff_at,
    note: row.note ?? null,
    variants: (variants.data ?? []).filter((variant: any) => variant.meal_day_id === row.id).map((variant: any) => ({
      id: variant.id, mealDayId: variant.meal_day_id, name: variant.name, note: variant.note ?? null, sortOrder: Number(variant.sort_order),
    })),
  }))
}

async function loadFamilies(): Promise<{ families: CafeteriaFamily[]; diners: CafeteriaDiner[]; accounts: CafeteriaAccount[] }> {
  const db = client()
  const links = await db.from('cafeteria_family_users').select('family_id').eq('active', true)
  failIfError(links.error)
  const familyIds = [...new Set((links.data ?? []).map((row: any) => String(row.family_id)))]
  if (!familyIds.length) return { families: [], diners: [], accounts: [] }
  const [families, diners, accounts] = await Promise.all([
    db.from('cafeteria_families').select('id,display_name').in('id', familyIds).eq('active', true).order('display_name'),
    db.from('cafeteria_diners').select('id,diner_type,full_name,family_id,portion_category_id,cafeteria_portion_categories(name)').in('family_id', familyIds).eq('active', true).order('full_name'),
    db.from('cafeteria_accounts').select('id,family_id,label,variable_symbol').in('family_id', familyIds).eq('active', true).order('label'),
  ])
  failIfError(families.error); failIfError(diners.error); failIfError(accounts.error)
  return {
    families: (families.data ?? []).map((row: any) => ({ id: row.id, displayName: row.display_name })),
    diners: (diners.data ?? []).map(mapDiner),
    accounts: (accounts.data ?? []).map(mapAccount),
  }
}

async function loadOwnDiners(): Promise<CafeteriaDiner[]> {
  const result = await client().from('cafeteria_diners').select('id,diner_type,full_name,family_id,portion_category_id,cafeteria_portion_categories(name)').eq('active', true).order('full_name')
  failIfError(result.error)
  return (result.data ?? []).map(mapDiner)
}

const mapDiner = (row: any): CafeteriaDiner => ({
  id: row.id,
  dinerType: row.diner_type,
  fullName: row.full_name,
  familyId: row.family_id ?? null,
  portionName: Array.isArray(row.cafeteria_portion_categories) ? row.cafeteria_portion_categories[0]?.name ?? null : row.cafeteria_portion_categories?.name ?? null,
})

const mapAccount = (row: any): CafeteriaAccount => ({ id: row.id, familyId: row.family_id ?? null, label: row.label, variableSymbol: row.variable_symbol ?? null })

async function loadAdminData(): Promise<{ families: CafeteriaFamily[]; diners: CafeteriaDiner[]; accounts: CafeteriaAccount[]; roleUsers: CafeteriaRoleUser[]; settings: CafeteriaSettings | null }> {
  const db = client()
  const [families, diners, accounts, roles, settings] = await Promise.all([
    db.from('cafeteria_families').select('id,display_name').order('display_name'),
    db.from('cafeteria_diners').select('id,diner_type,full_name,family_id,portion_category_id,cafeteria_portion_categories(name)').order('full_name'),
    db.from('cafeteria_accounts').select('id,family_id,label,variable_symbol').order('label'),
    db.from('user_module_roles').select('user_id,role,profiles(full_name)').eq('module', 'cafeteria').order('user_id'),
    db.from('cafeteria_settings').select('cutoff_days_before,cutoff_time,payment_mode,allow_negative_balance,negative_balance_limit').eq('id', true).maybeSingle(),
  ])
  ;[families, diners, accounts, roles, settings].forEach((result) => failIfError(result.error))
  const roleUsers = new Map<string, CafeteriaRoleUser>()
  for (const row of roles.data ?? []) {
    const profile: any = Array.isArray((row as any).profiles) ? (row as any).profiles[0] : (row as any).profiles
    const current: CafeteriaRoleUser = roleUsers.get((row as any).user_id) ?? { userId: (row as any).user_id, fullName: profile?.full_name ?? 'Uživatel', roles: [] }
    current.roles.push((row as any).role)
    roleUsers.set(current.userId, current)
  }
  const settingRow: any = settings.data
  return {
    families: (families.data ?? []).map((row: any) => ({ id: row.id, displayName: row.display_name })),
    diners: (diners.data ?? []).map(mapDiner),
    accounts: (accounts.data ?? []).map(mapAccount),
    roleUsers: [...roleUsers.values()],
    settings: settingRow ? {
      cutoffDaysBefore: Number(settingRow.cutoff_days_before), cutoffTime: String(settingRow.cutoff_time).slice(0, 5), paymentMode: settingRow.payment_mode,
      allowNegativeBalance: Boolean(settingRow.allow_negative_balance), negativeBalanceLimit: settingRow.negative_balance_limit == null ? null : Number(settingRow.negative_balance_limit),
    } : null,
  }
}

export const cafeteriaRepository = {
  load: async (roles: CafeteriaRole[]): Promise<CafeteriaData> => {
    const meals = await loadMeals(roles.includes('admin'))
    let data: CafeteriaData = { meals, families: [], diners: [], accounts: [], roleUsers: [], settings: null }
    if (roles.includes('admin')) data = { ...data, ...(await loadAdminData()) }
    else {
      if (roles.includes('parent')) data = { ...data, ...(await loadFamilies()) }
      if (roles.includes('diner')) data.diners = [...new Map([...data.diners, ...(await loadOwnDiners())].map((item) => [item.id, item])).values()]
    }
    return data
  },
}
