export type Worker = 'Dana' | 'Martina' | 'David'
export type Frequency = 'denně' | 'týdně' | '1–2× týdně' | 'měsíčně' | 'mimořádně'
export type Task = {
  id: string; roomId?: string; room: string; floor: string; floorSort: number; building: string; title: string
  frequency: Frequency; assignedTo: string; done: boolean; prerequisite?: string; canComplete?: boolean; dueToday: boolean
  sortOrder: number; scheduleDays: number[]; monthlyDay?: number | null; workPartId?: string | null
  assignmentMode: 'fixed' | 'rotating'; rotationAnchorDate?: string | null; rotationIntervalWeeks?: number | null; active: boolean
}
export type Shift = { worker: Worker; start: string; end: string }
export type Attendance = { id?: string; worker: Worker; start: string; end?: string; date: string; type: 'směna' | 'praní' }
