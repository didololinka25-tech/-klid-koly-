import type { Shift, Task, Worker } from './types'

export const workers: { name: Worker; role: string; color: string }[] = [
  { name: 'Dana', role: 'uklízečka', color: '#166b61' }, { name: 'Martina', role: 'uklízečka', color: '#7b4f9f' }, { name: 'David', role: 'školník / správce', color: '#b45c17' }
]
export const defaultShifts: Shift[] = [{ worker: 'Dana', start: '16:00', end: '18:00' }, { worker: 'Martina', start: '17:00', end: '19:00' }]
export const initialTasks: Task[] = [
  { id: 'route', room: 'Celá škola', title: 'Projít školu a odstranit věci z cesty', frequency: 'denně', assignedTo: 'David', done: false },
  { id: 'sweep', room: 'Chodba – přízemí', title: 'Zamést / vysát', frequency: 'denně', assignedTo: 'Dana', done: false },
  { id: 'mop', room: 'Chodba – přízemí', title: 'Vytřít podlahu', frequency: 'denně', assignedTo: 'Dana', done: false, prerequisite: 'sweep' },
  { id: 'bins', room: 'Třídy', title: 'Vynést koše', frequency: 'denně', assignedTo: 'Martina', done: false },
  { id: 'toilets', room: 'Toalety', title: 'Vyčistit toalety', frequency: 'denně', assignedTo: 'Martina', done: false },
  { id: 'doors', room: 'Celá škola', title: 'Otřít kliky a vypínače', frequency: 'týdně', assignedTo: 'Dana', done: false }
]
