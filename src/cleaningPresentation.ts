import type { ActivityType, Task } from './types'

export type FloorPresentationKind = 'standard' | 'rotation' | 'additional'

export type FloorPresentation = {
  name: string
  kind: FloorPresentationKind
  tasks: Task[]
}

export type BuildingPresentation = {
  name: string
  tasks: Task[]
  floors: FloorPresentation[]
  roomCount: number
  completedRoomCount: number
  extraTasks: Task[]
}

const normalizedFrequency = (frequency: string) => ({
  cleaning_day: 'denně',
  weekly: 'týdně',
  monthly: 'měsíčně',
  extraordinary: 'mimořádně',
})[frequency] ?? frequency

/**
 * Standard je běžná práce při každé návštěvě prostoru. Rotace patra mění
 * pouze den návštěvy; z jeho běžných činností nedělá periodickou práci.
 */
export function isStandardCleaningTask(task: Task) {
  return normalizedFrequency(task.frequency) === 'denně'
    && !task.periodMonths
    && task.monthlyDay == null
}

export function isExtraCleaningTask(task: Task) {
  return !isStandardCleaningTask(task)
}

export function roomIsComplete(tasks: Task[]) {
  return tasks.length > 0 && tasks.every((task) => task.done)
}

export function floorPresentationKind(tasks: Task[]): FloorPresentationKind {
  if (tasks.some((task) => (task.cleaningCycleLength ?? 0) > 1)) return 'rotation'
  if (tasks.some(isStandardCleaningTask)) return 'standard'
  return 'additional'
}

export function summarizeCleaningDay(tasks: Task[]): BuildingPresentation[] {
  const buildings = new Map<string, Task[]>()
  tasks.forEach((task) => buildings.set(task.building, [...(buildings.get(task.building) ?? []), task]))

  return [...buildings.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'cs'))
    .map(([name, buildingTasks]) => {
      const floorTasks = new Map<string, Task[]>()
      const roomTasks = new Map<string, Task[]>()
      buildingTasks.filter((task) => task.roomId).forEach((task) => {
        floorTasks.set(task.floor, [...(floorTasks.get(task.floor) ?? []), task])
        const roomKey = `${task.buildingId ?? task.building}|${task.roomId}`
        roomTasks.set(roomKey, [...(roomTasks.get(roomKey) ?? []), task])
      })
      const floors = [...floorTasks.entries()]
        .sort(([, a], [, b]) => a[0].floorSort - b[0].floorSort)
        .map(([floorName, items]) => ({ name: floorName, kind: floorPresentationKind(items), tasks: items }))
      return {
        name,
        tasks: buildingTasks,
        floors,
        roomCount: roomTasks.size,
        completedRoomCount: [...roomTasks.values()].filter(roomIsComplete).length,
        extraTasks: buildingTasks.filter(isExtraCleaningTask),
      }
    })
}

export function extraActivityTypes(tasks: Task[]) {
  return [...new Set(tasks.filter(isExtraCleaningTask).map((task) => task.activityType))] as ActivityType[]
}

export function floorKindLabel(kind: FloorPresentationKind) {
  if (kind === 'rotation') return 'dnes v rotaci'
  if (kind === 'additional') return 'dnes navíc'
  return 'standard'
}
