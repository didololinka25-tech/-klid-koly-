import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cafeteriaErrorMessage, cafeteriaRepository } from './cafeteriaRepository'
import { buildMenuWeek } from './menuModel'
import { formatWeekLabel, isCurrentWeek, pragueDateKey, shiftWeek, weekForDate } from './orderingModel'
import type { MealDay, WeekRange } from './types'

export function CafeteriaMenu() {
  const [week, setWeek] = useState<WeekRange>(() => weekForDate(pragueDateKey()))
  const [meals, setMeals] = useState<MealDay[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const requestId = useRef(0)

  const loadWeek = useCallback(async () => {
    const activeRequest = ++requestId.current
    setStatus('loading')
    setMessage('')
    try {
      const result = await cafeteriaRepository.loadMenuWeek(week)
      if (activeRequest === requestId.current) {
        setMeals(result)
        setStatus('ready')
      }
    } catch (error) {
      if (activeRequest === requestId.current) {
        setMessage(cafeteriaErrorMessage(error))
        setStatus('error')
      }
    }
  }, [week])

  useEffect(() => { void loadWeek() }, [loadWeek])
  const days = useMemo(() => buildMenuWeek(meals, week), [meals, week])

  return <section className="cafeteria-menu" aria-label="Týdenní jídelníček">
    <div className="week-picker"><button type="button" aria-label="Předchozí týden" onClick={() => setWeek((current) => shiftWeek(current, -1))}>‹</button><strong>{formatWeekLabel(week)}</strong><button type="button" aria-label="Následující týden" onClick={() => setWeek((current) => shiftWeek(current, 1))}>›</button></div>
    {!isCurrentWeek(week) && <button type="button" className="this-week-button" onClick={() => setWeek(weekForDate(pragueDateKey()))}>Tento týden</button>}
    {status === 'loading' && <div className="ordering-loading"><span className="loading-spinner" /> Načítám jídelníček…</div>}
    {status === 'error' && <section className="panel cafeteria-state"><p>{message}</p><button type="button" onClick={() => void loadWeek()}>Zkusit znovu</button></section>}
    {status === 'ready' && <div className="cafeteria-menu-days">{days.map(({ mealDate, meal }) => <MenuDayCard mealDate={mealDate} meal={meal} key={mealDate} />)}</div>}
  </section>
}

function MenuDayCard({ mealDate, meal }: { mealDate: string; meal: MealDay | null }) {
  const cancelled = meal?.status === 'cancelled'
  return <article className={`panel cafeteria-menu-day${cancelled ? ' cancelled' : ''}`}>
    <header><div><small>{weekday(mealDate)}</small><h2>{formatDate(mealDate)}</h2></div>{cancelled && <span className="menu-day-status">Nevaří se / Volno</span>}</header>
    {!meal && <p className="hint">Jídelníček není zveřejněn.</p>}
    {meal && !cancelled && <div className="cafeteria-menu-variants">
      {meal.variants.map((variant) => <div key={variant.id}><b>{variant.name}</b>{variant.note && <p>{variant.note}</p>}</div>)}
      {!meal.variants.length && <p className="hint">Jídla zatím nejsou doplněná.</p>}
    </div>}
    {meal?.note && <p className="cafeteria-menu-note"><b>Poznámka:</b> {meal.note}</p>}
  </article>
}

const dateAtNoon = (date: string) => new Date(`${date}T12:00:00Z`)
const weekday = (date: string) => new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', timeZone: 'UTC' }).format(dateAtNoon(date))
const formatDate = (date: string) => new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(dateAtNoon(date))
