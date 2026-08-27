export type Worker = 'Dana' | 'Martina' | 'David'
export type Frequency = 'denně' | 'týdně' | '1–2× týdně' | 'měsíčně' | 'mimořádně'
export type Task = { id: string; room: string; title: string; frequency: Frequency; assignedTo: Worker; done: boolean; prerequisite?: string; canComplete?: boolean }
export type Shift = { worker: Worker; start: string; end: string }
export type Attendance = { id?: string; worker: Worker; start: string; end?: string; date: string; type: 'směna' | 'praní' }
