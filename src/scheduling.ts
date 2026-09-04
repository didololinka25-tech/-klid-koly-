export type SchedulableTask = {
  id?: string
  frequency: string
  schedule_days?: number[] | string | null
  monthly_day?: number | null
  cleaning_cycle_length?: number | null
  cleaning_cycle_offset?: number | null
  period_months?: number | null
  period_week?: number | null
  period_anchor_month?: string | null
}

export type CleaningDayException = {
  id: string
  kind: 'extraordinary' | 'rescheduled' | 'cancelled_standard'
  executionDate: string
  sourceDate?: string | null
  title: string
  note?: string | null
  status: 'active' | 'cancelled'
  taskOverrides?: Record<string, boolean>
}

export type CleaningDayContext = {
  kind: 'standard' | 'extraordinary' | 'rescheduled' | 'moved_away' | 'cancelled' | 'preview'
  executionDate: string
  scheduleDate: string
  title: string
  note?: string | null
  movedTo?: string
  exceptionId?: string
  taskOverrides?: Record<string, boolean>
}

function dateParts(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return { year, month, day }
}

const normalizeFrequency = (frequency: string) => ({
  denně: 'cleaning_day', týdně: 'weekly', '1–2× týdně': 'once_or_twice_weekly',
  měsíčně: 'monthly', mimořádně: 'extraordinary',
})[frequency] ?? frequency

function dateKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function addDays(date: string, amount: number) {
  const { year, month, day } = dateParts(date)
  return dateKey(new Date(Date.UTC(year, month - 1, day + amount)))
}

export function monthGridDates(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year, monthNumber - 1, 1))
  const offset = (first.getUTCDay() || 7) - 1
  const start = new Date(Date.UTC(year, monthNumber - 1, 1 - offset))
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setUTCDate(start.getUTCDate() + index)
    return dateKey(date)
  })
}

export function dateRangeChunks(from: string, to: string, maximumDays = 7) {
  if (maximumDays < 1 || from > to) return []
  const chunks: Array<{ from: string; to: string }> = []
  let cursor = from
  while (cursor <= to) {
    const chunkTo = addDays(cursor, maximumDays - 1)
    chunks.push({ from: cursor, to: chunkTo < to ? chunkTo : to })
    cursor = addDays(chunkTo, 1)
  }
  return chunks
}

function daysBetween(start: string, end: string) {
  const a = dateParts(start); const b = dateParts(end)
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000)
}

function countCleaningDays(start: string, end: string) {
  const length = daysBetween(start, end)
  if (length <= 0) return 0
  const fullWeeks = Math.floor(length / 7)
  let count = fullWeeks * 3
  for (let offset = fullWeeks * 7; offset < length; offset += 1) {
    if ([1, 3, 5].includes(isoDay(addDays(start, offset)))) count += 1
  }
  return count
}

export function cleaningDaySequenceIndex(date: string) {
  const anchor = '2026-08-31'
  return date >= anchor ? countCleaningDays(anchor, date) : -countCleaningDays(date, anchor)
}

function taskDays(task: SchedulableTask) {
  const rawDays = task.schedule_days
  return Array.isArray(rawDays)
    ? rawDays.map(Number)
    : typeof rawDays === 'string'
      ? rawDays.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number)
      : []
}

function monthDifference(anchor: string, date: string) {
  const a = dateParts(anchor); const b = dateParts(date)
  return (b.year - a.year) * 12 + b.month - a.month
}

function isTaskCandidateOnDate(task: SchedulableTask, date: string) {
  const frequency = normalizeFrequency(task.frequency)
  if (frequency === 'extraordinary') return false
  const cycleLength = task.cleaning_cycle_length ?? null
  const cycleOffset = task.cleaning_cycle_offset ?? null
  if (cycleLength && cycleOffset !== null) {
    const remainder = ((cleaningDaySequenceIndex(date) - cycleOffset) % cycleLength + cycleLength) % cycleLength
    if (remainder !== 0) return false
  }
  const periodMonths = task.period_months ?? null
  if (periodMonths) {
    const anchor = task.period_anchor_month
    const periodWeek = task.period_week
    if (!anchor || !periodWeek) return false
    const monthRemainder = ((monthDifference(anchor, date) % periodMonths) + periodMonths) % periodMonths
    if (monthRemainder !== 0) return false
    const day = dateParts(date).day
    if (periodWeek < 4 && (day < (periodWeek - 1) * 7 + 1 || day > periodWeek * 7)) return false
    if (periodWeek === 4 && day < 22) return false
    return taskDays(task).includes(isoDay(date))
  }
  if (frequency === 'monthly') return task.monthly_day === dateParts(date).day
  return taskDays(task).includes(isoDay(date))
}

export function isoDay(date: string) {
  const { year, month, day } = dateParts(date)
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return dayOfWeek === 0 ? 7 : dayOfWeek
}

export function isTaskDueOnDate(task: SchedulableTask, date: string, previewStandardCleaningDay = false) {
  const frequency = normalizeFrequency(task.frequency)
  // Náhled simuluje obecný standardní úklidový den. Nepředstírá konkrétní
  // pondělí, takže nepřidává středeční ani Po/Pá úkoly.
  if (previewStandardCleaningDay) return frequency === 'cleaning_day'
  if (!isTaskCandidateOnDate(task, date)) return false
  if (!task.period_months || !task.period_week) return true
  const startDay = task.period_week === 4 ? 22 : (task.period_week - 1) * 7 + 1
  const { year, month, day } = dateParts(date)
  for (let earlier = startDay; earlier < day; earlier += 1) {
    const candidate = `${year}-${String(month).padStart(2, '0')}-${String(earlier).padStart(2, '0')}`
    if (isTaskCandidateOnDate(task, candidate)) return false
  }
  return true
}

export function resolveCleaningDay(
  executionDate: string,
  exceptions: CleaningDayException[],
  previewStandardCleaningDay = false,
): CleaningDayContext {
  if (previewStandardCleaningDay) {
    return {
      kind: 'preview',
      executionDate,
      scheduleDate: executionDate,
      title: 'Testovací standardní úklid',
    }
  }

  const active = exceptions.filter((item) => item.status === 'active')
  const executing = active.find((item) => item.executionDate === executionDate)
  if (executing?.kind === 'cancelled_standard') {
    return {
      kind: 'cancelled',
      executionDate,
      scheduleDate: executionDate,
      title: executing.title,
      note: executing.note,
      exceptionId: executing.id,
    }
  }
  if (executing?.kind === 'rescheduled' && executing.sourceDate) {
    return {
      kind: 'rescheduled',
      executionDate,
      scheduleDate: executing.sourceDate,
      title: executing.title,
      note: executing.note,
      exceptionId: executing.id,
      taskOverrides: executing.taskOverrides,
    }
  }
  if (executing?.kind === 'extraordinary') {
    return {
      kind: 'extraordinary',
      executionDate,
      scheduleDate: executionDate,
      title: executing.title,
      note: executing.note,
      exceptionId: executing.id,
      taskOverrides: executing.taskOverrides,
    }
  }

  const moved = active.find(
    (item) => item.kind === 'rescheduled' && item.sourceDate === executionDate,
  )
  if (moved) {
    return {
      kind: 'moved_away',
      executionDate,
      scheduleDate: executionDate,
      title: 'Pravidelný úklid byl přesunut',
      note: moved.note,
      movedTo: moved.executionDate,
    }
  }

  return {
    kind: 'standard',
    executionDate,
    scheduleDate: executionDate,
    title: 'Standardní úklid',
  }
}

export function isTaskDueForCleaningDay(
  task: SchedulableTask,
  context: CleaningDayContext,
) {
  if (context.kind === 'moved_away' || context.kind === 'cancelled') return false
  if (context.kind === 'preview') return isTaskDueOnDate(task, context.scheduleDate, true)
  if (context.kind === 'extraordinary') {
    const baseline = normalizeFrequency(task.frequency) === 'cleaning_day'
      || isTaskDueOnDate(task, context.executionDate)
    if (task.id && context.taskOverrides
      && Object.prototype.hasOwnProperty.call(context.taskOverrides, task.id)) {
      return context.taskOverrides[task.id]
    }
    return baseline
  }
  if (context.kind === 'rescheduled') {
    return isTaskDueOnDate(task, context.scheduleDate)
      || isTaskDueOnDate(task, context.executionDate)
  }
  return isTaskDueOnDate(task, context.scheduleDate)
}
