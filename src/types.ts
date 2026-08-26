export type Worker = 'Dana' | 'Martina' | 'David'
export type Frequency = 'denně' | 'týdně' | 'měsíčně' | 'mimořádně'
export type Task = { id: string; room: string; title: string; frequency: Frequency; assignedTo: Worker; done: boolean; prerequisite?: string }
export type Shift = { worker: Worker; start: string; end: string }
export type Attendance = { worker: Worker; start: string; end?: string; date: string; type: 'směna' | 'praní' }
