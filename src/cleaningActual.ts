import type { Task } from './types.ts'
import { workersForDate, type PlannedWorker, type WorkerPlanningData } from './workerPlanning.ts'

export type CleaningActualCategory = 'routine' | 'as_needed' | 'detail' | 'frequency'
export type CleaningActualOutcome = 'completed' | 'skipped'
export type CleaningSkipReason = 'occupied' | 'no_time' | 'not_needed' | 'problem' | 'unavailable' | 'other'
export type RecommendationPriority = 'low' | 'normal' | 'increased' | 'high'

export type WorkerCleaningArea = {
  id: string; workerId: string; workerName: string; linkedProfileId?: string | null
  buildingId: string; buildingName: string; floorId?: string | null; floorName?: string | null
  areaCode: string; title: string; visitsPerWeek: number
  rotationMode: 'none' | 'alternating_ab' | 'history'; alwaysIncludeWc: boolean
  validFrom: string; validTo?: string | null; active: boolean
}

export type WorkerAvailabilityChange = {
  id: string; workerId: string; workerName: string; date: string
  status: 'planned' | 'absent' | 'rescheduled' | 'time_changed' | 'partial' | 'substitute'
  alternateDate?: string | null; startsAt?: string | null; endsAt?: string | null
  substitutesForWorkerId?: string | null; substitutesForWorkerName?: string | null
  note: string; active: boolean; createdAt: string; createdBy: string
}

export type CleaningActualRecord = {
  id: string; workDate: string; workerId?: string | null; workerName?: string | null
  subjectProfileId?: string | null; recordedBy: string; recordedByName: string
  buildingId: string; buildingName: string; floorId?: string | null; floorName?: string | null
  roomId?: string | null; roomName?: string | null; taskId?: string | null
  category: CleaningActualCategory; outcome: CleaningActualOutcome; skipReason?: CleaningSkipReason | null
  label: string; note: string; occurredAt: string; active: boolean
}

export type CleaningActualData = {
  areas: WorkerCleaningArea[]
  availability: WorkerAvailabilityChange[]
  records: CleaningActualRecord[]
  available: boolean
}

export type CleaningActualDraft = {
  buildingId: string; floorId?: string | null; roomId?: string | null; taskId?: string | null
  category: CleaningActualCategory; outcome: CleaningActualOutcome; skipReason?: CleaningSkipReason | null
  label: string; note?: string
}

export type CleaningRecommendation = {
  id: string; buildingId?: string; floorId?: string | null; roomId?: string
  title: string; reason: string; priority: RecommendationPriority; tasks: Task[]
  blockedByCalendar: boolean; recommendedPart?: 'A' | 'B'
}

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000)
const isWc = (task: Task) => /^wc(?:\s|\s*\/|$)/i.test(task.room)
const secondFloorPart = (task: Task): 'A' | 'B' | undefined => {
  const room = task.room.toLocaleLowerCase('cs-CZ')
  if (/týmovn|zázemí/.test(room)) return 'A'
  if (/učebn/.test(room)) return 'B'
  return undefined
}

export function availabilityForDate(date: string, planning: WorkerPlanningData, changes: WorkerAvailabilityChange[]): PlannedWorker[] {
  const base = workersForDate(date, planning)
  const active = changes.filter((item) => item.active)
  const absent = new Set(active.filter((item) => item.date === date && ['absent', 'rescheduled'].includes(item.status)).map((item) => item.workerId))
  const replacements = active.filter((item) => (item.status === 'rescheduled' && item.alternateDate === date) || (item.status === 'substitute' && item.date === date))
  const byId = new Map(base.filter((item) => !absent.has(item.workerId)).map((item) => [item.workerId, item]))
  for (const change of replacements) {
    const worker = planning.planningWorkers?.find((item) => item.id === change.workerId)
    const represented = base.find((item) => item.workerId === (change.substitutesForWorkerId ?? change.workerId))
      ?? planning.assignments.find((item) => item.workerId === (change.substitutesForWorkerId ?? change.workerId))
    if (!worker || !represented) continue
    byId.set(worker.id, {
      workerId: worker.id, workerName: worker.name, initials: worker.name.slice(0, 2).toLocaleUpperCase('cs-CZ'), colorIndex: 0,
      buildingId: represented.buildingId, buildingName: represented.buildingName,
      floorId: represented.floorId, areaLabel: represented.areaLabel, exception: true, note: change.note,
    })
  }
  return [...byId.values()].sort((a, b) => a.workerName.localeCompare(b.workerName, 'cs'))
}

/** Alternates every actual scheduled visit. It is a recommendation, never a task filter or permission gate. */
export function recommendedAlternatingPart(date: string, validFrom: string, weekdays: number[]): 'A' | 'B' {
  let visits = 0
  for (let day = dayNumber(validFrom); day <= dayNumber(date); day += 1) {
    const isoDay = new Date(day * 86_400_000).getUTCDay() || 7
    if (weekdays.includes(isoDay)) visits += 1
  }
  return visits % 2 === 1 ? 'A' : 'B'
}

function elapsedDays(date: string, previous?: string) {
  return previous ? Math.max(0, dayNumber(date) - dayNumber(previous)) : Number.POSITIVE_INFINITY
}

export function buildCleaningRecommendations(input: {
  date: string; workerId: string; tasks: Task[]; planning: WorkerPlanningData
  areas: WorkerCleaningArea[]; records: CleaningActualRecord[]; blockedRoomIds?: Set<string>
}): CleaningRecommendation[] {
  const { date, workerId, tasks, planning, records } = input
  const areas = input.areas.filter((area) => area.active && area.workerId === workerId && area.validFrom <= date && (!area.validTo || area.validTo >= date))
  const assignment = planning.assignments.find((item) => item.workerId === workerId && item.active && item.validFrom <= date && (!item.validTo || item.validTo >= date))
  const recommendedPart = areas.some((area) => area.rotationMode === 'alternating_ab') && assignment
    ? recommendedAlternatingPart(date, assignment.validFrom, assignment.weekdays) : undefined
  const candidates = tasks.filter((task) => task.active && task.roomActive !== false && (
    task.plannerAssignedWorkerId === workerId || areas.some((area) =>
      task.buildingId === area.buildingId && (!area.floorId || task.floorId === area.floorId || (area.alwaysIncludeWc && isWc(task))),
    )
  ))
  const grouped = new Map<string, Task[]>()
  for (const task of candidates) if (task.roomId) grouped.set(task.roomId, [...(grouped.get(task.roomId) ?? []), task])
  const recommendations = [...grouped.entries()].map(([roomId, roomTasks]): CleaningRecommendation => {
    const history = records.filter((item) => item.active && item.roomId === roomId && item.workDate <= date).sort((a, b) => b.workDate.localeCompare(a.workDate) || b.occurredAt.localeCompare(a.occurredAt))
    const last = history[0]
    const skipped = history.find((item) => item.outcome === 'skipped' && !history.some((newer) => newer.outcome === 'completed' && newer.workDate >= item.workDate))
    const age = elapsedDays(date, history.find((item) => item.outcome === 'completed')?.workDate)
    const blocked = input.blockedRoomIds?.has(roomId) ?? false
    const part = secondFloorPart(roomTasks[0])
    let priority: RecommendationPriority = age >= 14 ? 'high' : age >= 7 ? 'increased' : age <= 1 ? 'low' : 'normal'
    let reason = last ? `Naposledy uklizeno před ${age} dny.` : 'Zatím bez záznamu skutečného úklidu.'
    if (recommendedPart && part === recommendedPart) reason = `Doporučená část ${recommendedPart}. ${reason}`
    if (roomTasks.some((task) => task.plannerAssignedWorkerId === workerId)) reason = `Přidělená týdenní nebo periodická práce. ${reason}`
    if (skipped) { priority = 'high'; reason = `Minule vynecháno: ${skipReasonLabel(skipped.skipReason)}.` }
    if (blocked) { priority = 'high'; reason = 'Prostor může být obsazený školní akcí; ověřte dostupnost.' }
    return { id: roomId, buildingId: roomTasks[0].buildingId, floorId: roomTasks[0].floorId, roomId, title: roomTasks[0].room, reason, priority, tasks: roomTasks, blockedByCalendar: blocked, recommendedPart }
  })
  return recommendations.sort((a, b) => ['high', 'increased', 'normal', 'low'].indexOf(a.priority) - ['high', 'increased', 'normal', 'low'].indexOf(b.priority) || a.title.localeCompare(b.title, 'cs'))
}

export function skipReasonLabel(reason?: CleaningSkipReason | null) {
  return ({ occupied: 'obsazeno', no_time: 'nebyl čas', not_needed: 'nebylo potřeba', problem: 'porucha / problém', unavailable: 'nedostupné', other: 'jiný důvod' } as const)[reason ?? 'other']
}
