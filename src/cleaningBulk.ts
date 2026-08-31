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
