import { bulkTasks, findUndoableRoomAction } from './cleaningBulk.ts'
import { isStandardCleaningTask } from './cleaningPresentation.ts'
import type { Task } from './types'

export type TodayWorkRoom = {
  id: string
  name: string
  floor: string
  floorSort: number
  tasks: Task[]
}

export type TodayWorkBlock = {
  id: string
  building: string
  buildingId?: string
  title: string
  optional: boolean
  queue: boolean
  sortOrder: number
  tasks: Task[]
  rooms: TodayWorkRoom[]
}

export type TodayBuildingWork = {
  building: string
  buildingId?: string
  blocks: TodayWorkBlock[]
  wcQueue?: TodayWorkBlock
}

const isWcRoom = (task: Task) => /^wc(?:\s|\s*\/|$)/i.test(task.room.trim())

function roomsFor(tasks: Task[]) {
  const grouped = new Map<string, Task[]>()
  tasks.forEach((task) => {
    const key = task.roomId ?? `${task.floor}|${task.room}`
    grouped.set(key, [...(grouped.get(key) ?? []), task])
  })
  return [...grouped.entries()]
    .map(([id, roomTasks]) => ({
      id,
      name: roomTasks[0].room,
      floor: roomTasks[0].floor,
      floorSort: roomTasks[0].floorSort,
      tasks: roomTasks.sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    .sort((a, b) => {
      const firstPriority = Math.min(...a.tasks.map((task) => task.plannerPriority ?? Number.POSITIVE_INFINITY))
      const secondPriority = Math.min(...b.tasks.map((task) => task.plannerPriority ?? Number.POSITIVE_INFINITY))
      return a.floorSort - b.floorSort || firstPriority - secondPriority || a.name.localeCompare(b.name, 'cs')
    })
}

function block(id: string, title: string, tasks: Task[], sortOrder: number, options?: { optional?: boolean; queue?: boolean }): TodayWorkBlock {
  return {
    id,
    building: tasks[0].building,
    buildingId: tasks[0].buildingId,
    title,
    optional: options?.optional ?? false,
    queue: options?.queue ?? false,
    sortOrder,
    tasks,
    rooms: roomsFor(tasks),
  }
}

/**
 * Překládá jediný výsledek scheduleru do krátkých pracovních celků. Neurčuje,
 * co je splatné; pouze seskupuje již vyřešené due tasky pro mobilní obrazovku.
 */
export function buildTodayWorkBlocks(tasks: Task[]): TodayBuildingWork[] {
  // For dynamic school days, planReason comes from the server RPC and is more
  // authoritative than legacy task frequency metadata. Extras remain outside
  // the main blocks and are rendered separately.
  const standard = tasks.filter((task) => task.roomId && (
    task.plannerReason === 'routine'
    || task.plannerReason === 'wc-queue'
    || (!task.plannerReason && isStandardCleaningTask(task))
  ))
  const byBuilding = new Map<string, Task[]>()
  standard.forEach((task) => {
    const key = task.buildingId ?? task.building
    byBuilding.set(key, [...(byBuilding.get(key) ?? []), task])
  })

  return [...byBuilding.values()].map((buildingTasks) => {
    const queuedWc = buildingTasks.filter((task) => task.plannerReason === 'wc-queue' && isWcRoom(task))
    const required = buildingTasks.filter((task) => task.plannerReason !== 'wc-queue')
    const requiredWc = required.filter(isWcRoom)
    const floorTasks = required.filter((task) => !isWcRoom(task))
    const floors = new Map<string, Task[]>()
    floorTasks.forEach((task) => floors.set(task.floor, [...(floors.get(task.floor) ?? []), task]))

    const blocks = [...floors.entries()]
      .sort(([, first], [, second]) => first[0].floorSort - second[0].floorSort)
      .map(([floor, items], index) => block(
        `${items[0].buildingId ?? items[0].building}|floor|${items[0].floorId ?? floor}`,
        `${items[0].building.toLocaleLowerCase('cs').includes('školk') ? 'Úklid' : 'Podlahy'} – ${floor}`,
        items,
        10 + index,
      ))

    if (requiredWc.length) {
      blocks.push(block(
        `${requiredWc[0].buildingId ?? requiredWc[0].building}|wc-all`,
        'WC – celá škola',
        requiredWc,
        50,
      ))
    }

    const wcQueue = queuedWc.length
      ? block(
          `${queuedWc[0].buildingId ?? queuedWc[0].building}|wc-queue`,
          'WC – otevřená fronta',
          queuedWc,
          50,
          { optional: true, queue: true },
        )
      : undefined

    return {
      building: buildingTasks[0].building,
      buildingId: buildingTasks[0].buildingId,
      blocks: blocks.sort((a, b) => a.sortOrder - b.sortOrder),
      wcQueue,
    }
  }).sort((a, b) => a.building.localeCompare(b.building, 'cs'))
}

export function workBlockIsComplete(block: TodayWorkBlock) {
  const routine = bulkTasks(block.tasks)
  return routine.length > 0 && routine.every((task) => task.done)
}

export function incompleteWorkBlockTasksByRoom(block: TodayWorkBlock) {
  return block.rooms
    .map((room) => bulkTasks(room.tasks).filter((task) => !task.done))
    .filter((tasks) => tasks.length > 0)
}

type BulkActionLike = {
  id: string
  roomId: string
  taskIds: string[]
  canUndo: boolean
}

export function undoableWorkBlockActions<T extends BulkActionLike>(block: TodayWorkBlock, actions: T[]) {
  const found = block.rooms
    .map((room) => findUndoableRoomAction(room.tasks, actions))
    .filter((action): action is T => Boolean(action))
  return [...new Map(found.map((action) => [action.id, action])).values()]
}

export function mandatoryWorkBlockProgress(buildings: TodayBuildingWork[]) {
  const blocks = buildings.flatMap((building) => building.blocks).filter((item) => !item.optional)
  return { total: blocks.length, done: blocks.filter(workBlockIsComplete).length }
}
