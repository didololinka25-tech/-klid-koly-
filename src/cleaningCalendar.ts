import type { Task } from './types'
import type { CleaningDayContext } from './scheduling'
import { isExtraCleaningTask, summarizeCleaningDay } from './cleaningPresentation.ts'
import { workersForDate, type PlannedWorker, type WorkerPlanningData } from './workerPlanning.ts'

export type CalendarExceptionInput = {
  kind: 'extraordinary' | 'rescheduled'
  executionDate: string
  sourceDate?: string | null
  title: string
  status: 'active' | 'cancelled'
}

export type CalendarExtraCategory = {
  key: 'windows' | 'doors' | 'laundry' | 'furniture' | 'tiles' | 'deep_clean' | 'surfaces' | 'staircase'
  icon: string
  label: string
  taskCount: number
  scopes: string[]
}

export type CalendarSectionSummary = {
  workplace: string
  name: string
  marker: string
  rotating: boolean
  staircase: boolean
}

export type CalendarWorkplaceSummary = {
  name: string
  icon: string
  sections: CalendarSectionSummary[]
  extraCategories: CalendarExtraCategory[]
}

export type CalendarDaySummary = {
  date: string
  isToday: boolean
  isWeekend: boolean
  workers: PlannedWorker[]
  workplaces: CalendarWorkplaceSummary[]
  sections: CalendarSectionSummary[]
  rotatingSections: CalendarSectionSummary[]
  extraCategories: CalendarExtraCategory[]
  extraordinary: string[]
  rescheduled: string[]
  movedTo?: string
  cancelledExceptions: string[]
  context: CleaningDayContext
  tasks: Task[]
  // Rezervované místo pro budoucí sekundární vrstvu školních akcí.
  // Google Calendar ani jeho data se v této iteraci neimplementují.
  schoolEvents: Array<{ id: string; title: string; collision: boolean }>
}

const extraCategoryMeta: Record<CalendarExtraCategory['key'], Pick<CalendarExtraCategory, 'icon' | 'label'>> = {
  windows: { icon: '🪟', label: 'Okna / skla' },
  doors: { icon: '🚪', label: 'Dveře' },
  laundry: { icon: '🧺', label: 'Praní' },
  furniture: { icon: '🪑', label: 'Stoly / lavičky' },
  tiles: { icon: '🧱', label: 'Obklady / sprcha' },
  deep_clean: { icon: '🧽', label: 'Hloubkový úklid' },
  surfaces: { icon: '🗄', label: 'Skříňky / povrchy' },
  staircase: { icon: '🪜', label: 'Schodiště' },
}

function extraCategory(task: Task): CalendarExtraCategory['key'] | null {
  if (!isExtraCleaningTask(task)) return null
  if (task.floor === 'Schodiště') return 'staircase'
  if (task.activityType === 'windows') return 'windows'
  if (task.activityType === 'doors') return 'doors'
  if (task.activityType === 'laundry') return 'laundry'
  if (task.activityType === 'tables') return 'furniture'
  if (task.activityType === 'tiles') return 'tiles'
  if (task.activityType === 'deep_clean') return 'deep_clean'
  if (task.activityType === 'surfaces') return 'surfaces'
  return null
}

function sectionMarker(name: string) {
  if (name === 'Schodiště') return 'SCH'
  return name.match(/^[1-4]/)?.[0] ?? '•'
}

function isWeekend(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return weekday === 0 || weekday === 6
}

export function buildCalendarDaySummary({
  date,
  today,
  tasks,
  context,
  exceptions = [],
  planning = { assignments: [], exceptions: [], available: false },
}: {
  date: string
  today: string
  tasks: Task[]
  context: CleaningDayContext
  exceptions?: CalendarExceptionInput[]
  planning?: WorkerPlanningData
}): CalendarDaySummary {
  const cleaningTasks = tasks
  const buildingSummary = summarizeCleaningDay(cleaningTasks)
  const sections = buildingSummary.flatMap((workplace) => workplace.floors.map((floor) => ({
    workplace: workplace.name,
    name: floor.name,
    marker: sectionMarker(floor.name),
    rotating: floor.kind === 'rotation',
    staircase: floor.name === 'Schodiště',
  })))
  const categoriesFor = (items: Task[]) => {
    const categoryCounts = new Map<CalendarExtraCategory['key'], number>()
    items.forEach((task) => {
      const category = extraCategory(task)
      if (category) categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
    })
    return [...categoryCounts.entries()].map(([key, taskCount]) => ({
      key, taskCount, ...extraCategoryMeta[key],
      scopes: [...new Set(items.filter((task) => extraCategory(task) === key).map((task) => `${task.building} · ${task.floor}${task.room && task.room !== 'Společné úkoly' ? ` · ${task.room}` : ''}`))],
    }))
  }
  const activeExecuting = exceptions.filter((item) => item.status === 'active' && item.executionDate === date)
  const cancelled = exceptions.filter((item) => item.status === 'cancelled' && item.executionDate === date)
  return {
    date,
    isToday: date === today,
    isWeekend: isWeekend(date),
    workers: workersForDate(date, planning),
    workplaces: buildingSummary.map((workplace) => ({
      name: workplace.name,
      icon: workplace.name === 'Školka' ? '🌱' : '🏫',
      sections: sections.filter((section) => section.workplace === workplace.name),
      extraCategories: categoriesFor(cleaningTasks.filter((task) => task.building === workplace.name)),
    })),
    sections,
    rotatingSections: sections.filter((section) => section.rotating),
    extraCategories: categoriesFor(cleaningTasks),
    extraordinary: activeExecuting.filter((item) => item.kind === 'extraordinary').map((item) => item.title),
    rescheduled: activeExecuting.filter((item) => item.kind === 'rescheduled').map((item) => item.title),
    movedTo: context.kind === 'moved_away' ? context.movedTo : undefined,
    cancelledExceptions: cancelled.map((item) => item.title),
    context,
    tasks,
    schoolEvents: [],
  }
}

export function filterCalendarTasks(tasks: Task[], buildingId: string) {
  return buildingId === 'all' ? tasks : tasks.filter((task) => task.buildingId === buildingId)
}

export function circledFloor(marker: string) {
  return ({ '1': '①', '2': '②', '3': '③', '4': '④' } as Record<string, string>)[marker] ?? marker
}
