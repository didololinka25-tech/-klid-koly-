export type SchedulableTask = {
  id?: string
  frequency: string
  schedule_days?: number[] | string | null
  monthly_day?: number | null
}

export type CleaningDayException = {
  id: string
  kind: 'extraordinary' | 'rescheduled'
  executionDate: string
  sourceDate?: string | null
  title: string
  note?: string | null
  status: 'active' | 'cancelled'
  taskOverrides?: Record<string, boolean>
}

export type CleaningDayContext = {
  kind: 'standard' | 'extraordinary' | 'rescheduled' | 'moved_away' | 'preview'
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
  if (context.kind === 'moved_away') return false
  if (context.kind === 'preview') return isTaskDueOnDate(task, context.scheduleDate, true)
  if (context.kind === 'extraordinary') {
    const baseline = task.frequency === 'cleaning_day'
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
