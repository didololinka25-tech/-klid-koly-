import { weekDateKeys } from './orderingModel.ts'
import type { MealDay, WeekRange } from './types'

export type CafeteriaMenuWeekDay = { mealDate: string; meal: MealDay | null }

export function buildMenuWeek(meals: MealDay[], week: WeekRange): CafeteriaMenuWeekDay[] {
  return weekDateKeys(week).map((mealDate) => ({
    mealDate,
    meal: meals.find((meal) => meal.mealDate === mealDate) ?? null,
  }))
}
