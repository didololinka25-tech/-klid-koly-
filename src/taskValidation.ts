export type TaskDefinition = {
  id?: string
  roomId?: string
  title: string
  frequency: string
  scheduleDays: number[]
  monthlyDay?: number | null
}

const normalizedDays = (days: number[]) => [...new Set(days)].sort((a, b) => a - b)

export function isSameTaskDefinition(left: TaskDefinition, right: TaskDefinition) {
  return (left.roomId ?? null) === (right.roomId ?? null)
    && left.title.trim().toLocaleLowerCase('cs') === right.title.trim().toLocaleLowerCase('cs')
    && left.frequency === right.frequency
    && (left.monthlyDay ?? null) === (right.monthlyDay ?? null)
    && normalizedDays(left.scheduleDays).join(',') === normalizedDays(right.scheduleDays).join(',')
}
