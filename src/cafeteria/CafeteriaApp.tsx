import { useEffect, useMemo, useState } from 'react'
import type { Profile } from '../schoolRepository'
import type { CafeteriaRole } from '../system/access'
import { cafeteriaRepository } from './cafeteriaRepository'
import type { CafeteriaData, MealDay } from './types'

const emptyData: CafeteriaData = { meals: [], families: [], diners: [], accounts: [], roleUsers: [], settings: null }
const roleLabels: Record<CafeteriaRole, string> = { parent: 'Rodič', diner: 'Strávník', kitchen: 'Kuchyně', admin: 'Správa' }

export function CafeteriaApp({ profile, roles, onOpenLauncher, onSignOut }: { profile: Profile; roles: CafeteriaRole[]; onOpenLauncher: () => void; onSignOut: () => Promise<void> }) {
  const [role, setRole] = useState<CafeteriaRole>(() => roles.includes('admin') ? 'admin' : roles[0])
  const [section, setSection] = useState('')
  const [data, setData] = useState<CafeteriaData>(emptyData)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const navigation = useMemo(() => role === 'parent' ? ['Obědy', 'Platby', 'Rodina'] : role === 'diner' ? ['Jídelníček', 'Profil'] : role === 'kitchen' ? ['Dnes', 'Jídelníček', 'Žádosti'] : ['Přehled', 'Jídelníček', 'Lidé', 'Finance', 'Více'], [role])
  const activeSection = navigation.includes(section) ? section : navigation[0]

  useEffect(() => {
    setStatus('loading')
    cafeteriaRepository.load(roles).then((next) => { setData(next); setStatus('ready') }).catch((error) => {
      console.error('Jídelnu se nepodařilo načíst:', error)
      setMessage(error instanceof Error ? error.message : 'Jídelnu se nepodařilo načíst.')
      setStatus('error')
    })
  }, [roles.join('|')])

  return (
    <main className="app cafeteria-app">
      <header className="cafeteria-header">
        <button className="back-to-modules" type="button" onClick={onOpenLauncher} aria-label="Zpět na moduly">‹</button>
        <div><p className="eyebrow">JÍDELNA</p><h1>{activeSection}</h1></div>
        <button className="avatar" type="button" title={profile.full_name} aria-label="Odhlásit se" onClick={() => { if (window.confirm('Odhlásit se?')) void onSignOut() }}>{profile.full_name[0]}</button>
      </header>
      {roles.length > 1 && <label className="cafeteria-role-picker">Zobrazení<select value={role} onChange={(event) => { setRole(event.target.value as CafeteriaRole); setSection('') }}>{roles.map((item) => <option value={item} key={item}>{roleLabels[item]}</option>)}</select></label>}
      {status === 'loading' && <section className="panel cafeteria-state"><span className="loading-spinner" /><p>Načítám Jídelnu…</p></section>}
      {status === 'error' && <section className="panel cafeteria-state"><h2>Jídelna není dostupná</h2><p>{message}</p><button onClick={onOpenLauncher}>Zpět na moduly</button></section>}
      {status === 'ready' && <CafeteriaContent role={role} section={activeSection} data={data} />}
      <nav className="cafeteria-nav" style={{ gridTemplateColumns: `repeat(${navigation.length}, minmax(0, 1fr))` }}>{navigation.map((item) => <button key={item} className={activeSection === item ? 'active' : ''} onClick={() => setSection(item)}><i>{navIcon(item)}</i><span>{item}</span></button>)}</nav>
    </main>
  )
}

function CafeteriaContent({ role, section, data }: { role: CafeteriaRole; section: string; data: CafeteriaData }) {
  if (['Obědy', 'Jídelníček'].includes(section)) return <MealList meals={data.meals} />
  if (role === 'kitchen' && section === 'Dnes') return <MealList meals={data.meals.filter((meal) => meal.mealDate === localDateKey())} today />
  if (section === 'Platby' || section === 'Finance') return <EmptyState icon="💰" text="Finanční přehled bude dostupný po aktivaci plateb." />
  if (section === 'Žádosti') return <EmptyState icon="🔔" text="Žádosti budou dostupné po aktivaci změn objednávek." />
  if (section === 'Rodina') return <FamilyView data={data} />
  if (role === 'diner' && section === 'Profil') return <DinerList diners={data.diners} empty="Profil strávníka zatím není propojen." />
  if (role === 'admin' && section === 'Přehled') return <AdminOverview data={data} />
  if (role === 'admin' && section === 'Lidé') return <PeopleView data={data} />
  if (role === 'admin' && section === 'Více') return <SettingsView data={data} />
  return <EmptyState icon="🍽️" text="Tato část zatím nemá žádná data." />
}

function MealList({ meals, today = false }: { meals: MealDay[]; today?: boolean }) {
  if (!meals.length) return <EmptyState icon="🍽️" text={today ? 'Na dnešek není zveřejněné jídlo.' : 'Jídelníček zatím není zveřejněn.'} />
  return <section className="cafeteria-list">{meals.map((meal) => <article className="panel meal-card" key={meal.id}><small>{formatDate(meal.mealDate)}</small>{meal.variants.length ? meal.variants.map((variant) => <div key={variant.id}><b>{variant.name}</b>{variant.note && <p>{variant.note}</p>}</div>) : <p>Varianty zatím nejsou doplněné.</p>}{meal.note && <p className="hint">{meal.note}</p>}</article>)}</section>
}

function FamilyView({ data }: { data: CafeteriaData }) {
  if (!data.families.length) return <EmptyState icon="👨‍👩‍👧" text="Rodina zatím není propojena." />
  return <section className="cafeteria-list">{data.families.map((family) => <article className="panel" key={family.id}><h2>{family.displayName}</h2><DinerList diners={data.diners.filter((diner) => diner.familyId === family.id)} empty="Rodina zatím nemá propojené strávníky." />{data.accounts.filter((account) => account.familyId === family.id).map((account) => <p className="account-line" key={account.id}><b>{account.label}</b>{account.variableSymbol && <small>VS {account.variableSymbol}</small>}</p>)}</article>)}</section>
}

function DinerList({ diners, empty }: { diners: CafeteriaData['diners']; empty: string }) {
  if (!diners.length) return <p className="hint">{empty}</p>
  return <div className="diner-list">{diners.map((diner) => <div key={diner.id}><span aria-hidden="true">{diner.dinerType === 'child' ? '🧒' : '👤'}</span><span><b>{diner.fullName}</b><small>{diner.portionName ?? 'Porce zatím není nastavena'}</small></span></div>)}</div>
}

function AdminOverview({ data }: { data: CafeteriaData }) {
  return <section className="admin-counts"><article className="panel"><b>{data.families.length}</b><span>rodin</span></article><article className="panel"><b>{data.diners.length}</b><span>strávníků</span></article><article className="panel"><b>{data.meals.length}</b><span>zveřejněných dnů</span></article></section>
}

function PeopleView({ data }: { data: CafeteriaData }) {
  if (!data.families.length && !data.diners.length && !data.roleUsers.length) return <EmptyState icon="👥" text="V Jídelně zatím nejsou žádní lidé." />
  return <section className="cafeteria-list"><article className="panel"><h2>Rodiny</h2>{data.families.map((item) => <p key={item.id}>{item.displayName}</p>)}{!data.families.length && <p className="hint">Žádné rodiny</p>}</article><article className="panel"><h2>Strávníci</h2><DinerList diners={data.diners} empty="Žádní strávníci" /></article><article className="panel"><h2>Uživatelé</h2>{data.roleUsers.map((item) => <p className="role-user" key={item.userId}><b>{item.fullName}</b><small>{item.roles.map((role) => roleLabels[role as CafeteriaRole] ?? role).join(' · ')}</small></p>)}{!data.roleUsers.length && <p className="hint">Žádné role Jídelny</p>}</article></section>
}

function SettingsView({ data }: { data: CafeteriaData }) {
  if (!data.settings) return <EmptyState icon="⚙️" text="Nastavení Jídelny zatím není dostupné." />
  return <section className="panel settings-summary"><h2>Nastavení Jídelny</h2><p><span>Uzávěrka</span><b>{data.settings.cutoffDaysBefore} den předem v {data.settings.cutoffTime}</b></p><p><span>Platby</span><b>{data.settings.paymentMode === 'mixed' ? 'Smíšený režim' : data.settings.paymentMode === 'credit' ? 'Kredit' : 'Zpětně'}</b></p><p><span>Záporný zůstatek</span><b>{data.settings.allowNegativeBalance ? 'Povolen' : 'Zakázán'}</b></p></section>
}

function EmptyState({ icon, text }: { icon: string; text: string }) {
  return <section className="empty cafeteria-empty"><span>{icon}</span><p>{text}</p></section>
}

const localDateKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date())
const formatDate = (date: string) => new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))
const navIcon = (item: string) => ({ Obědy: '🍽️', Platby: '💰', Rodina: '👨‍👩‍👧', Jídelníček: '📅', Profil: '👤', Dnes: '🍳', Žádosti: '🔔', Přehled: '⌂', Lidé: '👥', Finance: '💰', Více: '•••' }[item] ?? '•')
