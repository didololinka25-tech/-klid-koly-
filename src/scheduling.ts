export type SchedulableTask = {
  frequency: string
  schedule_days?: number[] | string | null
  monthly_day?: number | null
}

function dateParts(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return { year, month, day }
}

export function isoDay(date: string) {
  const { year, month, day } = dateParts(date)
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return dayOfWeek === 0 ? 7 : dayOfWeek
}

export function isTaskDueOnDate(task: SchedulableTask, date: string, previewStandardCleaningDay = false) {
  const { day } = dateParts(date)
  if (task.frequency === 'monthly') return task.monthly_day === day
  if (task.frequency === 'extraordinary') return false
  // Náhled simuluje obecný standardní úklidový den. Nepředstírá konkrétní
  // pondělí, takže nepřidává středeční ani Po/Pá úkoly.
  if (previewStandardCleaningDay) return task.frequency === 'cleaning_day'
  const rawDays = task.schedule_days
  const scheduleDays = Array.isArray(rawDays)
    ? rawDays.map(Number)
    : typeof rawDays === 'string'
      ? rawDays.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number)
      : []
  return scheduleDays.includes(isoDay(date))
}
