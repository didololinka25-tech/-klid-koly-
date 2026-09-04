import type { Task } from './types'
import type { CleaningDayContext } from './scheduling'
import { isExtraCleaningTask, summarizeCleaningDay } from './cleaningPresentation.ts'
import { cleaningRotationForOccurrence, workersForDate, type PlannedWorker, type RotationForDate, type WorkerPlanningData } from './workerPlanning.ts'
import { buildTodayWorkBlocks, type TodayBuildingWork } from './todayWorkBlocks.ts'

export type CalendarExceptionInput = {
  id?: string
  buildingId?: string
  buildingName?: string
  kind: 'extraordinary' | 'rescheduled' | 'cancelled_standard'
  executionDate: string
  sourceDate?: string | null
  title: string
  note?: string | null
  status: 'active' | 'cancelled'
}

export type CancelledWorkplace = {
  id: string
  buildingId: string
  buildingName: string
  title: string
  note?: string | null
}

export type CalendarExtraCategory = {
  key: 'windows' | 'doors' | 'laundry' | 'furniture' | 'tiles' | 'deep_clean' | 'surfaces' | 'staircase' | 'floors' | 'mirrors' | 'other'
  /** Krátká ASCII značka; na rozdíl od emoji je spolehlivá v každé PWA fontové sadě. */
  symbol: string
  label: string
  taskCount: number
  scopes: string[]
  overdue: boolean
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
  cancelledWorkplaces: CancelledWorkplace[]
  context: CleaningDayContext
  tasks: Task[]
  workBlocks: TodayBuildingWork[]
  fourthFloorRotation: RotationForDate | null
  fourthFloorAssignedWorker: { workerId: string; workerName: string } | null
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
  // The server planner is the source of truth. A planned occurrence can be
  // overdue or capacity-sized even when its canonical task still carries a
  // legacy frequency value, so do not discard it based on frequency alone.
  const plannedExtra = ['small', 'large', 'weekly-special', 'overdue'].includes(task.plannerReason ?? '')
  if (!plannedExtra && !isExtraCleaningTask(task)) return null
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
  const hasFourthFloor = tasks.some((task) => task.floor === '4. patro')
  const serverFourthFloorWorkerId = tasks.find((task) => task.floor === '4. patro' && task.plannerAssignedWorkerId)?.plannerAssignedWorkerId ?? null
  // Explicitní výsledek serverového planneru má přednost. A/B/C je pouze
  // zpětně kompatibilní fallback pro týdny bez uložené osobní povinnosti.
  const rotation = hasFourthFloor && !serverFourthFloorWorkerId ? cleaningRotationForOccurrence(date, planning) : null
  const workers = workerId === 'all' ? allWorkers : allWorkers.filter((worker) => worker.workerId === workerId)
  const workerBuildingIds = new Set(workers.map((worker) => worker.buildingId))
  // Stable work areas determine planner capacity; they are not assignments of
  // shared cleaning tasks to an individual. A worker filter must therefore keep
  // the complete shared server plan and may only hide work explicitly assigned
  // by the planner (currently the 4th-floor rotation).
  const cleaningTasks = workerId === 'all' ? tasks : tasks.filter((task) => {
    if (!task.buildingId || !workerBuildingIds.has(task.buildingId)) return false
    if (task.floor === '4. patro' && !task.plannerAssignedWorkerId) return rotation?.assignment?.workerId === workerId
    if (!task.plannerAssignedWorkerId) return true
    return task.plannerAssignedWorkerId === workerId
  })
  const assignedFourthFloorWorkerId = cleaningTasks.find((task) => task.floor === '4. patro' && task.plannerAssignedWorkerId)?.plannerAssignedWorkerId ?? null
  const assignedFourthFloorWorkerName = assignedFourthFloorWorkerId
    ? allWorkers.find((worker) => worker.workerId === assignedFourthFloorWorkerId)?.workerName
      ?? planning.planningWorkers?.find((worker) => worker.id === assignedFourthFloorWorkerId)?.name
      ?? planning.assignments.find((assignment) => assignment.workerId === assignedFourthFloorWorkerId)?.workerName
      ?? null
    : null
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
      overdue: items.some((task) => extraCategory(task) === key && task.plannerReason === 'overdue'),
      scopes: [...new Set(items.filter((task) => extraCategory(task) === key).map((task) => `${task.building} · ${task.floor}${task.room && task.room !== 'Společné úkoly' ? ` · ${task.room}` : ''}`))],
    }))
  }
  const activeExecuting = exceptions.filter((item) => item.status === 'active' && item.executionDate === date)
  const cancelledWorkplaces = exceptions.filter((item) => item.status === 'active' && item.kind === 'cancelled_standard' && item.executionDate === date).map((item) => ({
    id: item.id ?? '',
    buildingId: item.buildingId ?? '',
    buildingName: item.buildingName ?? 'Pracoviště',
    title: item.title,
    note: item.note,
  }))
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
    cancelledExceptions: cancelledWorkplaces.map((item) => `${item.buildingName} · ÚKLID ZRUŠEN`),
    cancelledWorkplaces,
    context,
    tasks: cleaningTasks,
    workBlocks: buildTodayWorkBlocks(cleaningTasks),
    fourthFloorRotation: visibleRotation,
    fourthFloorAssignedWorker: assignedFourthFloorWorkerId ? {
      workerId: assignedFourthFloorWorkerId,
      workerName: assignedFourthFloorWorkerName ?? 'Přiřazený pracovník',
    } : null,
    schoolEvents: [],
  }
}

/**
 * Projects the authoritative RPC result onto the locally loaded task catalog.
 * It intentionally performs no scheduling of its own.
 */
export function projectDynamicSchoolPlan(tasks: Task[], serverTasks: ReadonlyMap<string, {
  planReason: Task['plannerReason']
  assignedWorkerId: string | null
  plannerPriority: number | null
}>) {
  return tasks
    .filter((task) => task.active && task.roomActive !== false && serverTasks.has(task.id))
    .map((task) => {
      const planned = serverTasks.get(task.id)!
      return {
        ...task,
        plannerReason: planned.planReason,
        plannerAssignedWorkerId: planned.assignedWorkerId,
        plannerPriority: planned.plannerPriority,
      }
    })
}

export function calendarWorkerOptions(planning: WorkerPlanningData) {
  const values = new Map<string, string>()
  ;(planning.planningWorkers ?? []).filter((item) => item.active).forEach((item) => values.set(item.id, item.name))
  planning.assignments.filter((item) => item.active).forEach((item) => values.set(item.workerId, item.workerName));
  (planning.rotationSlots ?? []).filter((item) => item.active && item.workerId).forEach((item) => values.set(item.workerId!, item.workerName || 'Pracovník'))
  return [...values.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'cs'))
}

export function filterCalendarTasks(tasks: Task[], buildingId: string) {
  return buildingId === 'all' ? tasks : tasks.filter((task) => task.buildingId === buildingId)
}

/**
 * Jediný prezentační pohled nad vyřešeným serverovým plánem. Buňka měsíce,
 * detail dne i tisk díky němu odvozují 4. patro a práci navíc ze stejných dat.
 */
export function calendarDayPlanView(summary: CalendarDaySummary) {
  const hasFourthFloor = summary.tasks.some((task) => task.floor === '4. patro')
  const mainBlocks = summary.workBlocks.flatMap((workplace) => [
    ...workplace.blocks.map((block) => ({ building: workplace.building, block })),
    ...(workplace.wcQueue ? [{ building: workplace.building, block: workplace.wcQueue }] : []),
  ])
  const extras = summary.extraCategories.flatMap((category) => {
    if (!hasFourthFloor || category.key !== 'floors') return [category]
    const scopes = category.scopes.filter((scope) => !scope.includes('· 4. patro'))
    return scopes.length ? [{ ...category, scopes }] : []
  })
  return {
    mainBlocks,
    extras,
    hasFourthFloor,
    fourthFloorWorker: summary.fourthFloorAssignedWorker?.workerName
      ?? summary.fourthFloorRotation?.assignment?.workerName
      ?? null,
  }
}

export function calendarDayCellScope(summary: CalendarDaySummary) {
  const view = calendarDayPlanView(summary)
  const blockTitles = view.mainBlocks.map(({ block }) => block.title)
  const floors = [...new Set(blockTitles.flatMap((title) => {
    const match = title.match(/Podlahy\s*[–-]\s*([1-4])\. patro/i)
    return match ? [`${match[1]}F`] : []
  }))]
  const hasWc = blockTitles.some((title) => /^WC\s*[–-]/i.test(title))
  const hasStairs = view.extras.some((category) => category.key === 'staircase')
  const hasFourthFloor = view.hasFourthFloor
  const extraCount = view.extras.filter((category) => category.key !== 'staircase' && category.key !== 'floors').length
  return {
    workers: summary.workers.length,
    floors: floors.filter((floor) => floor !== '4F'),
    hasWc,
    hasStairs,
    hasFourthFloor,
    extraCount,
  }
}

export type CalendarPrintDay = {
  date: string
  workers: Array<{ id: string; name: string; building: string; area: string }>
  mainPlan: Array<{ building: string; title: string; queue: boolean }>
  extras: CalendarExtraCategory[]
  hasFourthFloor: boolean
  fourthFloorWorker: string | null
  workplaces: string[]
  cancellations: Array<{ building: string; note?: string | null }>
  hasWork: boolean
}

/**
 * Převádí již vyřešený výsledek kalendáře do tiskového view modelu.
 * Neprovádí žádné plánování a záměrně nevypisuje jednotlivé mikroúkoly.
 */
export function calendarPrintDay(summary: CalendarDaySummary): CalendarPrintDay {
  const view = calendarDayPlanView(summary)
  const mainPlan = view.mainBlocks.map(({ building, block }) => ({ building, title: block.title, queue: block.queue }))
  const workplaces = [...new Set([
    ...summary.workplaces.map((workplace) => workplace.name),
    ...summary.workers.map((worker) => worker.buildingName),
    ...mainPlan.map((item) => item.building),
  ])]
  return {
    date: summary.date,
    workers: summary.workers.map((worker) => ({
      id: worker.workerId,
      name: worker.workerName,
      building: worker.buildingName,
      area: worker.areaLabel,
    })),
    mainPlan,
    extras: view.extras,
    hasFourthFloor: view.hasFourthFloor,
    fourthFloorWorker: view.fourthFloorWorker,
    workplaces,
    cancellations: summary.cancelledWorkplaces.map((item) => ({ building: item.buildingName, note: item.note })),
    hasWork: summary.tasks.length > 0 || summary.workers.length > 0 || summary.extraordinary.length > 0 || summary.rescheduled.length > 0 || summary.cancelledWorkplaces.length > 0,
  }
}

export function circledFloor(marker: string) {
  return ({ '1': '①', '2': '②', '3': '③', '4': '④' } as Record<string, string>)[marker] ?? marker
}
