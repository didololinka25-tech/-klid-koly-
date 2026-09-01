import type { Task } from './types'
import type { CleaningDayContext } from './scheduling'
import { isExtraCleaningTask, summarizeCleaningDay } from './cleaningPresentation.ts'
import { cleaningRotationForDate, workersForDate, type PlannedWorker, type RotationForDate, type WorkerPlanningData } from './workerPlanning.ts'

export type CalendarExceptionInput = {
  kind: 'extraordinary' | 'rescheduled'
  executionDate: string
  sourceDate?: string | null
  title: string
  status: 'active' | 'cancelled'
}

export type CalendarExtraCategory = {
  key: 'windows' | 'doors' | 'laundry' | 'furniture' | 'tiles' | 'deep_clean' | 'surfaces' | 'staircase' | 'floors' | 'mirrors' | 'other'
  /** Krátká ASCII značka; na rozdíl od emoji je spolehlivá v každé PWA fontové sadě. */
  symbol: string
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
  fourthFloorRotation: RotationForDate | null
  // Rezervované místo pro budoucí sekundární vrstvu školních akcí.
  // Google Calendar ani jeho data se v této iteraci neimplementují.
  schoolEvents: Array<{ id: string; title: string; collision: boolean }>
}

const extraCategoryMeta: Record<CalendarExtraCategory['key'], Pick<CalendarExtraCategory, 'symbol' | 'label'>> = {
  windows: { symbol: 'OK', label: 'Okna / skla' },
  doors: { symbol: 'DV', label: 'Dveře' },
  laundry: { symbol: 'PR', label: 'Praní' },
  furniture: { symbol: 'ST', label: 'Stoly / lavičky' },
  tiles: { symbol: 'OB', label: 'Obklady / sprcha' },
  deep_clean: { symbol: 'HL', label: 'Hloubkový úklid' },
  surfaces: { symbol: 'PO', label: 'Skříňky / povrchy' },
  staircase: { symbol: 'SCH', label: 'Schodiště' },
  floors: { symbol: 'PD', label: 'Podlahy / koberce' },
  mirrors: { symbol: 'ZR', label: 'Zrcadla' },
  other: { symbol: '+', label: 'Další práce' },
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
  if (task.activityType === 'vacuum' || task.activityType === 'mop') return 'floors'
  if (task.activityType === 'mirror') return 'mirrors'
  return 'other'
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
  planning = { assignments: [], exceptions: [], rotationDefinitions: [], rotationSlots: [], available: false },
  workerId = 'all',
}: {
  date: string
  today: string
  tasks: Task[]
  context: CleaningDayContext
  exceptions?: CalendarExceptionInput[]
  planning?: WorkerPlanningData
  workerId?: string
}): CalendarDaySummary {
  const allWorkers = workersForDate(date, planning)
  const rotation = cleaningRotationForDate(date, planning)
  const workers = workerId === 'all' ? allWorkers : allWorkers.filter((worker) => worker.workerId === workerId)
  const selectedAssignments = workers.filter((worker) => worker.workerId === workerId)
  const cleaningTasks = workerId === 'all' ? tasks : tasks.filter((task) => {
    if (task.floor === '4. patro') return rotation?.assignment?.workerId === workerId
    return selectedAssignments.some((worker) => worker.buildingId === task.buildingId && (!worker.floorId || !task.floorId || worker.floorId === task.floorId))
  })
  const visibleRotation = cleaningTasks.some((task) => task.floor === '4. patro') ? rotation : null
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
    workers,
    workplaces: buildingSummary.map((workplace) => ({
      name: workplace.name,
      icon: workplace.name === 'Školka' ? 'MŠ' : 'Š',
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
    tasks: cleaningTasks,
    fourthFloorRotation: visibleRotation,
    schoolEvents: [],
  }
}

export function calendarWorkerOptions(planning: WorkerPlanningData) {
  const values = new Map<string, string>()
  planning.assignments.filter((item) => item.active).forEach((item) => values.set(item.workerId, item.workerName));
  (planning.rotationSlots ?? []).filter((item) => item.active && item.workerId).forEach((item) => values.set(item.workerId!, item.workerName || 'Pracovník'))
  return [...values.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'cs'))
}

export function filterCalendarTasks(tasks: Task[], buildingId: string) {
  return buildingId === 'all' ? tasks : tasks.filter((task) => task.buildingId === buildingId)
}

export function circledFloor(marker: string) {
  return ({ '1': '①', '2': '②', '3': '③', '4': '④' } as Record<string, string>)[marker] ?? marker
}
