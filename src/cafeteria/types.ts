export type MealVariant = { id: string; mealDayId: string; name: string; note: string | null; sortOrder: number }
export type MealDay = { id: string; mealDate: string; cutoffAt: string; note: string | null; variants: MealVariant[] }
export type CafeteriaFamily = { id: string; displayName: string }
export type CafeteriaDiner = { id: string; fullName: string; dinerType: 'child' | 'adult'; familyId: string | null; portionName: string | null }
export type CafeteriaAccount = { id: string; familyId: string | null; label: string; variableSymbol: string | null }
export type CafeteriaRoleUser = { userId: string; fullName: string; roles: string[] }
export type CafeteriaSettings = { cutoffDaysBefore: number; cutoffTime: string; paymentMode: 'credit' | 'postpaid' | 'mixed'; allowNegativeBalance: boolean; negativeBalanceLimit: number | null }
export type CafeteriaData = {
  meals: MealDay[]
  families: CafeteriaFamily[]
  diners: CafeteriaDiner[]
  accounts: CafeteriaAccount[]
  roleUsers: CafeteriaRoleUser[]
  settings: CafeteriaSettings | null
}
