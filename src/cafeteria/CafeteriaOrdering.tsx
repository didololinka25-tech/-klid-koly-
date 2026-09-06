import { useCallback, useEffect, useRef, useState } from 'react'
import { cafeteriaErrorMessage, cafeteriaRepository } from './cafeteriaRepository'
import {
  formatWeekLabel,
  isBeforeCutoff,
  isCurrentWeek,
  lateRequestMessage,
  normalOrderVariant,
  pragueDateKey,
  shiftWeek,
  showDinerPicker,
  weekForDate,
} from './orderingModel'
import type { BulkWeekResult, CafeteriaDiner, CafeteriaMealWeek, MealWeekDay, WeekRange } from './types'

export function CafeteriaOrdering({ diners }: { diners: CafeteriaDiner[] }) {
  const [selectedDinerId, setSelectedDinerId] = useState(() => diners[0]?.id ?? '')
  const [week, setWeek] = useState<WeekRange>(() => weekForDate(pragueDateKey()))
  const [mealWeek, setMealWeek] = useState<CafeteriaMealWeek | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({})
  const [savingDays, setSavingDays] = useState<Set<string>>(() => new Set())
  const [dayMessages, setDayMessages] = useState<Record<string, string>>({})
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkSummary, setBulkSummary] = useState<string[]>([])
  const requestId = useRef(0)

  useEffect(() => {
    if (!diners.some((diner) => diner.id === selectedDinerId)) setSelectedDinerId(diners[0]?.id ?? '')
  }, [diners, selectedDinerId])

  const selectedDiner = diners.find((diner) => diner.id === selectedDinerId) ?? null
  const loadWeek = useCallback(async (background = false) => {
    const activeRequest = ++requestId.current
    if (!selectedDiner) {
      setMealWeek(null)
      setLoading(false)
      return
    }
    if (!background) {
      setLoading(true)
      setError('')
    }
    try {
      const result = await cafeteriaRepository.loadMealWeek(selectedDiner, week)
      if (activeRequest === requestId.current) setMealWeek(result)
    } catch (loadError) {
      if (activeRequest === requestId.current) {
        if (background) throw loadError
        setError(cafeteriaErrorMessage(loadError))
      }
    } finally {
      if (!background && activeRequest === requestId.current) setLoading(false)
    }
  }, [selectedDiner, week])

  useEffect(() => { void loadWeek() }, [loadWeek])

  const runDayAction = async (day: MealWeekDay, action: () => Promise<unknown>, successMessage: string) => {
    if (!day.meal || savingDays.has(day.meal.id)) return
    const mealDayId = day.meal.id
    setSavingDays((current) => new Set(current).add(mealDayId))
    setDayMessages((current) => ({ ...current, [day.mealDate]: '' }))
    try {
      await action()
      await loadWeek(true)
      setDayMessages((current) => ({ ...current, [day.mealDate]: successMessage }))
    } catch (actionError) {
      setDayMessages((current) => ({ ...current, [day.mealDate]: cafeteriaErrorMessage(actionError) }))
    } finally {
      setSavingDays((current) => {
        const next = new Set(current)
        next.delete(mealDayId)
        return next
      })
    }
  }

  const orderDay = (day: MealWeekDay) => {
    if (!day.meal || day.price == null) return
    const variantId = normalOrderVariant(day, selectedVariants[day.meal.id] ?? null)
    if (!variantId) return
    const action = day.order?.status === 'cancelled'
      ? () => cafeteriaRepository.reorderOrder(day.order!.id, variantId)
      : () => cafeteriaRepository.createOrder(selectedDiner!.id, day.meal!.id, variantId)
    void runDayAction(day, action, '✓ Oběd objednán')
  }

  const requestLateChange = (day: MealWeekDay, requestType: 'add' | 'cancel' | 'change_variant') => {
    if (!day.meal || !selectedDiner || day.lateRequest?.status === 'pending') return
    const requestedVariantId = requestType === 'cancel' ? null : normalOrderVariant(day, selectedVariants[day.meal.id] ?? null)
    if (requestType !== 'cancel' && !requestedVariantId) return
    void runDayAction(day, () => cafeteriaRepository.createLateRequest({
      dinerId: selectedDiner.id,
      mealDayId: day.meal!.id,
      requestType,
      requestedVariantId,
    }), 'Žádost byla odeslána.')
  }

  const orderWholeWeek = async () => {
    if (!mealWeek || bulkLoading) return
    setBulkLoading(true)
    setBulkSummary([])
    try {
      const result = await cafeteriaRepository.bulkOrderWeek(mealWeek)
      await loadWeek(true)
      setBulkSummary(bulkResultMessages(result))
    } catch (bulkError) {
      setBulkSummary([cafeteriaErrorMessage(bulkError)])
    } finally {
      setBulkLoading(false)
    }
  }

  if (!diners.length) return <section className="empty cafeteria-empty"><span>👤</span><p>Ke školnímu účtu zatím není propojen žádný strávník.</p></section>

  return (
    <section className="cafeteria-ordering">
      {showDinerPicker(diners.length) && (
        <div className="diner-chips" role="group" aria-label="Vyberte strávníka">
          {diners.map((diner) => <button type="button" key={diner.id} className={diner.id === selectedDinerId ? 'active' : ''} onClick={() => { setSelectedDinerId(diner.id); setSelectedVariants({}); setBulkSummary([]) }}>{diner.fullName}</button>)}
        </div>
      )}
      {selectedDiner && <p className="ordering-diner"><b>{selectedDiner.fullName}</b><small>{selectedDiner.portionName ?? 'Porce zatím není nastavena'}</small></p>}
      <div className="week-picker">
        <button type="button" aria-label="Předchozí týden" onClick={() => { setWeek((current) => shiftWeek(current, -1)); setBulkSummary([]) }}>‹</button>
        <strong>{formatWeekLabel(week)}</strong>
        <button type="button" aria-label="Následující týden" onClick={() => { setWeek((current) => shiftWeek(current, 1)); setBulkSummary([]) }}>›</button>
      </div>
      {!isCurrentWeek(week) && <button type="button" className="this-week-button" onClick={() => setWeek(weekForDate(pragueDateKey()))}>Tento týden</button>}
      {loading && <div className="ordering-loading"><span className="loading-spinner" /> Načítám týden…</div>}
      {!loading && error && <section className="panel cafeteria-state"><p>{error}</p><button type="button" onClick={() => void loadWeek()}>Zkusit znovu</button></section>}
      {!loading && !error && mealWeek && (
        <>
          <button type="button" className="bulk-order-button" disabled={bulkLoading} onClick={() => void orderWholeWeek()}>{bulkLoading ? 'Přihlašuji…' : 'Přihlásit celý týden'}</button>
          {bulkSummary.length > 0 && <div className="bulk-summary" aria-live="polite">{bulkSummary.map((message) => <p key={message}>{message}</p>)}</div>}
          <div className="meal-week-list">
            {mealWeek.days.map((day) => <MealDayCard
              key={day.mealDate}
              day={day}
              selectedVariantId={day.meal ? selectedVariants[day.meal.id] ?? null : null}
              saving={Boolean(day.meal && savingDays.has(day.meal.id))}
              message={dayMessages[day.mealDate] ?? ''}
              onSelectVariant={(variantId) => day.meal && setSelectedVariants((current) => ({ ...current, [day.meal!.id]: variantId }))}
              onOrder={() => orderDay(day)}
              onCancel={() => day.order && void runDayAction(day, () => cafeteriaRepository.cancelOrder(day.order!.id), 'Oběd odhlášen.')}
              onChangeVariant={() => {
                if (!day.meal || !day.order) return
                const variantId = selectedVariants[day.meal.id]
                if (variantId && variantId !== day.order.mealVariantId) void runDayAction(day, () => cafeteriaRepository.changeOrderVariant(day.order!.id, variantId), '✓ Jídlo změněno')
              }}
              onLateAdd={() => requestLateChange(day, 'add')}
              onLateCancel={() => requestLateChange(day, 'cancel')}
              onLateVariant={() => requestLateChange(day, 'change_variant')}
            />)}
          </div>
        </>
      )}
    </section>
  )
}

function MealDayCard({ day, selectedVariantId, saving, message, onSelectVariant, onOrder, onCancel, onChangeVariant, onLateAdd, onLateCancel, onLateVariant }: {
  day: MealWeekDay
  selectedVariantId: string | null
  saving: boolean
  message: string
  onSelectVariant: (id: string) => void
  onOrder: () => void
  onCancel: () => void
  onChangeVariant: () => void
  onLateAdd: () => void
  onLateCancel: () => void
  onLateVariant: () => void
}) {
  const meal = day.meal
  if (!meal) return <article className="panel ordering-day no-menu"><h2>{formatDay(day.mealDate)}</h2><p>Jídelníček není zveřejněn.</p></article>
  const open = isBeforeCutoff(day)
  const ordered = day.order?.status === 'ordered'
  const currentVariant = meal.variants.find((variant) => variant.id === day.order?.mealVariantId)
  const effectiveSelection = selectedVariantId ?? (ordered ? day.order?.mealVariantId ?? null : null)
  const orderVariantId = normalOrderVariant(day, effectiveSelection)
  const multipleVariants = meal.variants.length > 1
  const pending = day.lateRequest?.status === 'pending'

  return (
    <article className="panel ordering-day">
      <h2>{formatDay(day.mealDate)}</h2>
      {multipleVariants ? <fieldset className="meal-variants"><legend>Vyberte jídlo:</legend>{meal.variants.map((variant) => <label key={variant.id}><input type="radio" name={`meal-${meal.id}`} value={variant.id} checked={effectiveSelection === variant.id} disabled={saving || pending} onChange={() => onSelectVariant(variant.id)} /><span><b>{variant.name}</b>{variant.note && <small>{variant.note}</small>}</span></label>)}</fieldset> : meal.variants[0] ? <div className="single-meal"><b>{meal.variants[0].name}</b>{meal.variants[0].note && <p>{meal.variants[0].note}</p>}</div> : <p>Jídlo zatím není doplněno.</p>}
      {meal.note && <p className="hint">{meal.note}</p>}
      <p className="meal-price">{day.price == null ? 'Cena není nastavena.' : formatPrice(day.price)}</p>
      {ordered && <p className="order-status">✅ Objednáno{currentVariant ? ` · ${currentVariant.name}` : ''}</p>}
      {!open && <p className="cutoff-status">🔒 Uzavřeno</p>}
      {day.lateRequest && <p className={`late-result ${pending ? 'pending' : ''}`}>{lateRequestMessage(day.lateRequest)}</p>}
      {message && <p className="day-operation-message" aria-live="polite">{message}</p>}
      <div className="order-actions">
        {open && !ordered && <button type="button" disabled={saving || day.price == null || !orderVariantId || meal.variants.length === 0} onClick={onOrder}>{saving ? 'Ukládám…' : day.order?.status === 'cancelled' ? 'Objednat znovu' : 'Objednat'}</button>}
        {open && ordered && multipleVariants && <button type="button" className="secondary" disabled={saving || !effectiveSelection || effectiveSelection === day.order?.mealVariantId} onClick={onChangeVariant}>{saving ? 'Ukládám…' : 'Změnit jídlo'}</button>}
        {open && ordered && <button type="button" className="secondary danger" disabled={saving} onClick={onCancel}>{saving ? 'Ukládám…' : 'Odhlásit'}</button>}
        {!open && !pending && !ordered && <button type="button" disabled={saving || day.price == null || !orderVariantId || meal.variants.length === 0} onClick={onLateAdd}>{saving ? 'Odesílám…' : 'Požádat o dodatečné přihlášení'}</button>}
        {!open && !pending && ordered && <button type="button" className="secondary danger" disabled={saving} onClick={onLateCancel}>{saving ? 'Odesílám…' : 'Požádat o odhlášení'}</button>}
        {!open && !pending && ordered && multipleVariants && <button type="button" className="secondary" disabled={saving || !effectiveSelection || effectiveSelection === day.order?.mealVariantId} onClick={onLateVariant}>{saving ? 'Odesílám…' : 'Požádat o změnu varianty'}</button>}
      </div>
    </article>
  )
}

function bulkResultMessages(result: BulkWeekResult): string[] {
  const messages = [`Objednány ${result.ordered} ${result.ordered === 1 ? 'oběd' : result.ordered >= 2 && result.ordered <= 4 ? 'obědy' : 'obědů'}.`]
  if (result.needsVariant.length) messages.push(`${dayList(result.needsVariant)}: vyberte variantu.`)
  if (result.closed.length) messages.push(`${dayList(result.closed)}: objednávka je již uzavřena.`)
  if (result.missingPrice.length) messages.push(`${dayList(result.missingPrice)}: cena není nastavena.`)
  if (result.failed.length) messages.push(`${result.failed.length} ${result.failed.length === 1 ? 'objednávku se nepodařilo uložit' : 'objednávky se nepodařilo uložit'}.`)
  return messages
}

const formatDay = (value: string) => capitalize(new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`)))
const shortDay = (value: string) => capitalize(new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`)))
const dayList = (dates: string[]) => dates.map(shortDay).join(', ')
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
const formatPrice = (price: number) => new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: price % 1 === 0 ? 0 : 2 }).format(price)
