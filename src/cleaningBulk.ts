import type { Task } from './types'

const neverBulkActivity = new Set(['windows', 'deep_clean', 'laundry'])

export function inferredBulkCompletable(task: Pick<Task, 'roomId' | 'frequency' | 'activityType' | 'periodMonths'>) {
  return Boolean(
    task.roomId
      && task.frequency !== 'měsíčně'
      && task.frequency !== 'mimořádně'
      && !task.periodMonths
      && !neverBulkActivity.has(task.activityType),
  )
}

export function isBulkCompletableTask(task: Task) {
  return inferredBulkCompletable(task) && task.bulkCompletable !== false
}

export function bulkTasks(tasks: Task[]) {
  return tasks.filter((task) => task.active && task.roomActive !== false && isBulkCompletableTask(task))
}

export function orderTasksByDependency(tasks: Task[], allTasks: Task[] = tasks) {
  const remaining = new Map(tasks.filter((task) => !task.done).map((task) => [task.id, task]))
  const ordered: Task[] = []
  for (const task of remaining.values()) {
    if (task.prerequisite && !allTasks.find((item) => item.id === task.prerequisite)?.done && !remaining.has(task.prerequisite)) {
      throw new Error(`Nejdříve dokončete předchozí činnost pro „${task.title}“.`)
    }
  }
  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter((task) => !task.prerequisite || allTasks.find((item) => item.id === task.prerequisite)?.done || !remaining.has(task.prerequisite))
      .sort((a, b) => a.sortOrder - b.sortOrder)
    if (!ready.length) throw new Error('Úkoly mají neplatnou kruhovou závislost.')
    for (const task of ready) {
      ordered.push(task)
      remaining.delete(task.id)
    }
  }
  return ordered
}

export function applyBulkUndo(tasks: Task[], taskIds: string[]) {
  const reverted = new Set(taskIds)
  return tasks.map((task) => reverted.has(task.id)
    ? { ...task, done: false, completedBy: null, completedById: null, completedAt: null }
    : task)
}

type BulkActionLike = {
  id: string
  roomId: string
  taskIds: string[]
  canUndo: boolean
}

export function findUndoableRoomAction<T extends BulkActionLike>(tasks: Task[], actions: T[]): T | undefined {
  const roomId = tasks.find((task) => task.roomId)?.roomId
  const routine = bulkTasks(tasks)
  if (!roomId || !routine.length || routine.some((task) => !task.done)) return undefined

  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const candidates = actions.filter((action) =>
    action.roomId === roomId
    && action.canUndo
    && action.taskIds.length > 0
    && action.taskIds.every((taskId) => {
      const task = taskById.get(taskId)
      return Boolean(task?.done && isBulkCompletableTask(task))
    }),
  )

  // Při více současně vratných akcích není bezpečné hádat, kterou uživatel zamýšlí.
  return candidates.length === 1 ? candidates[0] : undefined
}
