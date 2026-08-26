import { useEffect, useMemo, useState } from 'react'
import { defaultShifts, initialTasks, workers } from './data'
import { taskRepository } from './repository'
import type { Attendance, Frequency, Task, Worker } from './types'

type Section = 'Dnes' | 'Úklid' | 'Docházka' | 'Kalendář' | 'Zásoby' | 'Praní' | 'Závady' | 'Nastavení'
const sections: Section[] = ['Dnes', 'Úklid', 'Docházka', 'Kalendář', 'Zásoby', 'Praní', 'Závady', 'Nastavení']
const icon: Record<Section, string> = { Dnes: '☀', Úklid: '✓', Docházka: '◷', Kalendář: '▣', Zásoby: '▤', Praní: '♨', Závady: '⚠', Nastavení: '⚙' }
const today = new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())
const isCleaningDay = [1, 3, 5].includes(new Date().getDay())

export default function App() {
  const [section, setSection] = useState<Section>('Dnes')
  const [tasks, setTasks] = useState<Task[]>(() => taskRepository.load().length ? taskRepository.load() : initialTasks)
  const [attendance, setAttendance] = useState<Attendance[]>([])
  const [selectedWorker, setSelectedWorker] = useState<Worker>('Dana')
  const [notice, setNotice] = useState('')
  useEffect(() => taskRepository.save(tasks), [tasks])
  const complete = (id: string) => {
    const target = tasks.find(t => t.id === id)
    if (target?.prerequisite && !tasks.find(t => t.id === target.prerequisite)?.done) { setNotice('Nejdříve je potřeba zamést nebo vysát.'); return }
    setTasks(all => all.map(t => t.id === id ? { ...t, done: !t.done } : t)); setNotice('')
  }
  const clock = () => {
    const open = attendance.find(a => a.worker === selectedWorker && a.type === 'směna' && !a.end)
    if (open) setAttendance(all => all.map(a => a === open ? { ...a, end: new Date().toISOString() } : a))
    else setAttendance(all => [...all, { worker: selectedWorker, start: new Date().toISOString(), date: new Date().toISOString().slice(0,10), type: 'směna' }])
  }
  const hours = useMemo(() => attendance.filter(a => a.type === 'směna' && a.end).reduce((sum, a) => sum + (new Date(a.end!).getTime() - new Date(a.start).getTime()) / 36e5, 0), [attendance])
  const openShift = Boolean(attendance.find(a => a.worker === selectedWorker && !a.end && a.type === 'směna'))
  const visible = section === 'Dnes' ? tasks.filter(t => t.frequency === 'denně') : tasks
  const addEmergency = () => { const title = prompt('Název mimořádného úkolu'); if (title) setTasks(all => [...all, { id: crypto.randomUUID(), room: 'Celá škola', title, frequency: 'mimořádně', assignedTo: selectedWorker, done: false }]) }

  return <main className="app">
    <header><div><p className="eyebrow">ÚKLID ŠKOLY · ŠKOLA</p><h1>{section}</h1><p className="date">{today}</p></div><button className="avatar" aria-label="Vybrat pracovníka" onClick={() => setSelectedWorker(selectedWorker === 'Dana' ? 'Martina' : selectedWorker === 'Martina' ? 'David' : 'Dana')}>{selectedWorker[0]}</button></header>
    {notice && <div className="notice">{notice}</div>}
    {section === 'Dnes' && <><section className="hero"><span>{isCleaningDay ? 'Dnes je standardní úklidový den.' : 'Dnes není pravidelný úklidový den.'}</span><strong>{tasks.filter(t => t.done).length} / {tasks.length} hotovo</strong></section><h2>Nejdříve připravit cestu</h2><TaskList tasks={visible} onComplete={complete}/><button className="secondary" onClick={addEmergency}>＋ Přidat mimořádný úkol</button></>}
    {section === 'Úklid' && <><div className="filters">{(['denně','týdně','měsíčně','mimořádně'] as Frequency[]).map(f => <span key={f}>{f}</span>)}</div><TaskList tasks={visible} onComplete={complete}/><button className="secondary" onClick={addEmergency}>＋ Mimořádný úkol</button></>}
    {section === 'Docházka' && <section className="panel"><label>Pracovník<select value={selectedWorker} onChange={e => setSelectedWorker(e.target.value as Worker)}>{workers.map(w => <option key={w.name}>{w.name}</option>)}</select></label><div className="timecard"><small>{openShift ? 'Směna probíhá' : 'Připraveno k evidenci'}</small><strong>{selectedWorker}</strong><button onClick={clock}>{openShift ? 'Ukončit směnu' : 'Začít směnu'}</button></div><div className="summary"><span>Dnes <b>{attendance.filter(a => a.type === 'směna').length} směna</b></span><span>Měsíc <b>{hours.toFixed(1)} h</b></span></div><p className="hint">Praní evidujte v samostatné části — do pracovní doby se nezapočítává.</p></section>}
    {section === 'Kalendář' && <Placeholder title="Plán úklidu" text="Připraveno pro propojení sdíleného Google Kalendáře. Před naplánováním úklidu se budou kontrolovat školní akce a případné kolize." />}
    {section === 'Zásoby' && <Placeholder title="Zásoby" text="Základ pro budoucí evidenci čisticích prostředků, minimálních stavů a žádostí o nákup." />}
    {section === 'Praní' && <Placeholder title="Praní" text="Záznamy praní budou vedeny odděleně od docházky a nebudou se započítávat do pracovních hodin." />}
    {section === 'Závady' && <Placeholder title="Závady" text="Zde půjde nahlásit závadu, přiložit fotku a přiřadit ji Davidovi nebo správci." />}
    {section === 'Nastavení' && <section className="panel"><h2>Budovy a výchozí směny</h2><div className="building"><b>Škola</b><span>aktivní budova</span></div><div className="building muted"><b>Školka</b><span>připravena k přidání</span></div>{defaultShifts.map(s => <div className="shift" key={s.worker}><span>{s.worker}</span><span>{s.start}–{s.end}</span></div>)}<p className="hint">Časy směn budou později upravitelné podle uživatele a budovy.</p></section>}
    <nav>{sections.map(s => <button key={s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}><i>{icon[s]}</i><span>{s}</span></button>)}</nav>
  </main>
}

function TaskList({ tasks, onComplete }: { tasks: Task[]; onComplete: (id: string) => void }) { return <section className="tasks">{tasks.map(task => <article className={task.done ? 'task done' : 'task'} key={task.id}><button className="check" onClick={() => onComplete(task.id)} aria-label="Označit hotovo">{task.done ? '✓' : ''}</button><div><small>{task.room} · {task.frequency}</small><h3>{task.title}</h3><p>{task.assignedTo}</p></div>{task.prerequisite && <span className="rule">nejdřív zamést</span>}</article>)}</section> }
function Placeholder({ title, text }: { title: string; text: string }) { return <section className="empty"><span>○</span><h2>{title}</h2><p>{text}</p></section> }
