export type Worker = 'Dana' | 'Martina' | 'David'
export type Frequency = 'denně' | 'týdně' | '1–2× týdně' | 'měsíčně' | 'mimořádně'
export type ActivityType = 'trash' | 'toilet' | 'sink' | 'mirror' | 'vacuum' | 'mop' | 'tables' | 'windows' | 'doors' | 'tiles' | 'surfaces' | 'deep_clean' | 'laundry' | 'other'
export type Task = {
  id: string; roomId?: string; room: string; floor: string; floorSort: number; building: string; title: string
  activityType: ActivityType
  frequency: Frequency; assignedTo: string; done: boolean; prerequisite?: string; canComplete?: boolean; dueToday: boolean
  sortOrder: number; scheduleDays: number[]; monthlyDay?: number | null; active: boolean
  roomActive?: boolean
  cleaningCycleLength?: number | null; cleaningCycleOffset?: number | null
  periodMonths?: number | null; periodWeek?: number | null; periodAnchorMonth?: string | null
}
export type Shift = { worker: Worker; start: string; end: string }
export type Attendance = {
  id: string
  workerId: string
  buildingId?: string
  buildingName: string
  start: string
  end?: string
  date: string
  note?: string
  editedAt?: string
}
