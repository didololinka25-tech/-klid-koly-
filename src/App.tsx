import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { defaultShifts } from './data'
import { isTestCleaningDay, schoolRepository, type Profile } from './schoolRepository'
import { isSupabaseConfigured } from './supabase'
import type { Attendance, Frequency, Task } from './types'

type Section = 'Dnes' | 'Úklid' | 'Docházka' | 'Kalendář' | 'Zásoby' | 'Praní' | 'Závady' | 'Nastavení'
const sections: Section[] = ['Dnes', 'Úklid', 'Docházka', 'Kalendář', 'Zásoby', 'Praní', 'Závady', 'Nastavení']
const icon: Record<Section, string> = { Dnes: '☀', Úklid: '✓', Docházka: '◷', Kalendář: '▣', Zásoby: '▤', Praní: '♨', Závady: '⚠', Nastavení: '⚙' }
const todayLabel = new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())
const isCleaningDay = isTestCleaningDay || [1, 3, 5].includes(new Date().getDay())

export default function App() {
  const [session, setSession] = useState<Session | null>(null); const [profile, setProfile] = useState<Profile | null>(null)
  const [tasks, setTasks] = useState<Task[]>([]); const [attendance, setAttendance] = useState<Attendance[]>([])
  const [section, setSection] = useState<Section>('Dnes'); const [notice, setNotice] = useState('')
  const hours = useMemo(() => attendance.filter(item => item.end).reduce((sum, item) => sum + (new Date(item.end!).getTime() - new Date(item.start).getTime()) / 36e5, 0), [attendance])
  const load = useCallback(async (current: Session, knownProfile?: Profile | null) => {
    const activeProfile = knownProfile ?? await schoolRepository.profile(current.user.id)
    if (!activeProfile?.active) { setNotice('Účet není aktivní. Obraťte se na správce.'); return }
    setProfile(activeProfile); const [nextTasks, nextAttendance] = await Promise.all([schoolRepository.tasks(activeProfile), schoolRepository.attendance(activeProfile.id)])
    setTasks(nextTasks); setAttendance(nextAttendance)
  }, [])
  useEffect(() => { if (!isSupabaseConfigured) return; schoolRepository.getSession().then(next => { setSession(next); if (next) load(next).catch(error => setNotice(error.message)) }); const { data } = schoolRepository.onAuthChange(next => { setSession(next); setProfile(null); setTasks([]); setAttendance([]); if (next) load(next).catch(error => setNotice(error.message)) }); return () => data.subscription.unsubscribe() }, [load])
  useEffect(() => { if (!session || !profile) return; const channel = schoolRepository.subscribe(() => load(session, profile).catch(error => setNotice(error.message))); return () => { channel.unsubscribe() } }, [session, profile, load])
  if (!isSupabaseConfigured) return <SetupScreen />
  if (!session || !profile) return <LoginScreen notice={notice} onLoginWithGoogle={async () => { try { setNotice(''); await schoolRepository.signInWithGoogle() } catch (error) { setNotice(error instanceof Error ? error.message : 'Přihlášení přes Google se nezdařilo.') } }} />
  const complete = async (id: string) => { const target = tasks.find(task => task.id === id); if (!target || !target.canComplete) return; if (target.prerequisite && !tasks.find(task => task.id === target.prerequisite)?.done) { setNotice('Nejdříve je potřeba zamést nebo vysát.'); return } try { setNotice(''); await schoolRepository.setCompletion(id, profile.id, !target.done); await load(session, profile) } catch (error) { setNotice(error instanceof Error ? error.message : 'Úkol se nepodařilo uložit.') } }
  const clock = async () => { const open = attendance.find(item => !item.end); try { setNotice(''); if (open?.id) await schoolRepository.finishAttendance(open.id); else await schoolRepository.startAttendance(profile.id); await load(session, profile) } catch (error) { setNotice(error instanceof Error ? error.message : 'Docházku se nepodařilo uložit.') } }
  const openShift = attendance.find(item => !item.end); const visible = section === 'Dnes' ? tasks.filter(task => task.dueToday) : tasks
  return <main className="app"><header><div><p className="eyebrow">ÚKLID ŠKOLY · ŠKOLA</p><h1>{section}</h1><p className="date">{todayLabel}</p></div><button className="avatar" aria-label="Odhlásit" title="Odhlásit" onClick={() => schoolRepository.signOut()}>{profile.full_name[0]}</button></header>{notice && <div className="notice">{notice}</div>}
    {section === 'Dnes' && <><section className="hero"><span>{isTestCleaningDay ? 'Testovací zobrazení úklidového dne.' : isCleaningDay ? 'Dnes je standardní úklidový den.' : 'Dnes není pravidelný úklidový den.'}</span><strong>{tasks.filter(task => task.done).length} / {tasks.length} hotovo</strong></section><h2>Nejdříve připravit cestu</h2><TaskList tasks={visible} onComplete={complete} /></>}
    {section === 'Úklid' && <><div className="filters">{(['denně', 'týdně', '1–2× týdně', 'měsíčně', 'mimořádně'] as Frequency[]).map(frequency => <span key={frequency}>{frequency}</span>)}</div><TaskList tasks={visible} onComplete={complete} /></>}
    {section === 'Docházka' && <section className="panel"><div className="timecard"><small>{openShift ? 'Směna probíhá' : 'Připraveno k evidenci'}</small><strong>{profile.full_name}</strong><button onClick={clock}>{openShift ? 'Ukončit směnu' : 'Začít směnu'}</button></div><div className="summary"><span>Dnes <b>{attendance.filter(item => item.date === new Date().toISOString().slice(0, 10)).length} směna</b></span><span>Měsíc <b>{hours.toFixed(1)} h</b></span></div><p className="hint">Docházka se ukládá do sdílené databáze. Praní se do pracovní doby nezapočítává.</p></section>}
    {section === 'Kalendář' && <Placeholder title="Plán úklidu" text="Připraveno pro budoucí propojení sdíleného Google Kalendáře a kontrolu kolizí školních akcí." />}{section === 'Zásoby' && <Placeholder title="Zásoby" text="Datový model zásob je připraven. Správu zásob doplníme v další fázi." />}{section === 'Praní' && <Placeholder title="Praní" text="Datový model praní je samostatný a nezapočítává se do docházky." />}{section === 'Závady' && <Placeholder title="Závady" text="Datový model závad a budoucích fotografií je připraven." />}
    {section === 'Nastavení' && <section className="panel"><h2>Budovy a výchozí směny</h2><div className="building"><b>Škola</b><span>aktivní budova</span></div><div className="building muted"><b>Školka</b><span>připravena k přidání</span></div>{defaultShifts.map(shift => <div className="shift" key={shift.worker}><span>{shift.worker}</span><span>{shift.start}–{shift.end}</span></div>)}<p className="hint">Přihlášen: {profile.full_name} · {profile.role === 'caretaker' ? 'správce' : 'uklízečka'}</p></section>}
    <nav>{sections.map(item => <button key={item} className={section === item ? 'active' : ''} onClick={() => setSection(item)}><i>{icon[item]}</i><span>{item}</span></button>)}</nav></main>
}
function TaskList({ tasks, onComplete }: { tasks: Task[]; onComplete: (id: string) => void }) { return <section className="tasks">{tasks.map(task => <article className={task.done ? 'task done' : 'task'} key={task.id}><button className="check" disabled={!task.canComplete} onClick={() => onComplete(task.id)} aria-label="Označit hotovo">{task.done ? '✓' : ''}</button><div><small>{task.room} · {task.frequency}</small><h3>{task.title}</h3><p>{task.assignedTo}</p></div>{task.prerequisite && <span className="rule">nejdřív zamést</span>}</article>)}</section> }
function Placeholder({ title, text }: { title: string; text: string }) { return <section className="empty"><span>○</span><h2>{title}</h2><p>{text}</p></section> }
function SetupScreen() { return <main className="app"><section className="empty"><span>⚙</span><h1>Dokončete propojení</h1><p>Do souboru <code>.env.local</code> vložte veřejnou adresu projektu Supabase a anon klíč podle <code>.env.example</code>. Poté aplikaci restartujte.</p></section></main> }
function LoginScreen({ notice, onLoginWithGoogle }: { notice: string; onLoginWithGoogle: () => Promise<void> }) { return <main className="app"><section className="panel login"><p className="eyebrow">ÚKLID ŠKOLY</p><h1>Přihlášení</h1><p className="hint">Přihlaste se školním účtem. Zobrazí se pouze data podle vašich oprávnění.</p>{notice && <div className="notice">{notice}</div>}<button type="button" onClick={() => void onLoginWithGoogle()}>Pokračovat přes Google</button></section></main> }
