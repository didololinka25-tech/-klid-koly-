import { useCallback, useEffect, useState } from 'react'
import { cafeteriaErrorMessage, cafeteriaRepository } from './cafeteriaRepository'
import {
  filterKitchenService,
  fulfillmentLabels,
  fulfillmentSummary,
  signedCount,
  sortKitchenService,
  summarizeKitchenCounts,
  type KitchenServiceFilter,
} from './kitchenModel'
import type {
  CafeteriaFulfillmentStatus,
  CafeteriaKitchenCount,
  CafeteriaKitchenDiner,
  CafeteriaKitchenLateRequest,
  CafeteriaKitchenPortion,
  CafeteriaKitchenServiceOrder,
  MealDay,
} from './types'

type KitchenSection = 'Dnes' | 'Výdej' | 'Žádosti'

export function CafeteriaKitchen({
  section,
  meals,
  onPendingCountChange,
}: {
  section: KitchenSection
  meals: MealDay[]
  onPendingCountChange: (count: number) => void
}) {
  const [requests, setRequests] = useState<CafeteriaKitchenLateRequest[]>([])
  const [requestError, setRequestError] = useState('')
  const reloadRequests = useCallback(async () => {
    try {
      const next = await cafeteriaRepository.loadKitchenPendingRequests()
      setRequests(next)
      setRequestError('')
      onPendingCountChange(next.length)
    } catch (error) {
      setRequestError(cafeteriaErrorMessage(error))
      onPendingCountChange(0)
    }
  }, [onPendingCountChange])

  useEffect(() => { void reloadRequests() }, [reloadRequests])

  if (section === 'Dnes') return <KitchenToday meals={meals} />
  if (section === 'Výdej') return <KitchenService meals={meals} />
  return <KitchenRequests requests={requests} error={requestError} onReload={reloadRequests} />
}

function KitchenToday({ meals }: { meals: MealDay[] }) {
  const today = pragueDateKey()
  const meal = meals.find((item) => item.mealDate === today && item.status === 'published') ?? null
  const [counts, setCounts] = useState<CafeteriaKitchenCount[]>([])
  const [portions, setPortions] = useState<CafeteriaKitchenPortion[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [adding, setAdding] = useState(false)

  const reload = useCallback(async () => {
    setStatus('loading')
    try {
      const [nextCounts, nextPortions] = await Promise.all([
        cafeteriaRepository.loadKitchenCounts(today),
        cafeteriaRepository.loadKitchenPortions(),
      ])
      setCounts(nextCounts)
      setPortions(nextPortions)
      setStatus('ready')
    } catch (error) {
      setMessage(cafeteriaErrorMessage(error))
      setStatus('error')
    }
  }, [today])

  useEffect(() => { void reload() }, [reload])
  const totals = summarizeKitchenCounts(counts)

  return <section className="kitchen-page">
    <div className="kitchen-title-row">
      <div><p className="eyebrow">DNES</p><h2>{formatLongDate(today)}</h2></div>
      <button className="primary small kitchen-add" type="button" onClick={() => setAdding(true)} disabled={!meal}>+ Přidat oběd</button>
    </div>
    {!meal && <KitchenEmpty text="Na dnešek není zveřejněné jídlo." />}
    {meal && <>
      <article className="panel kitchen-menu"><small>Co se vaří</small>{meal.variants.map((variant) => <b key={variant.id}>{variant.name}</b>)}</article>
      {status === 'loading' && <KitchenLoading />}
      {status === 'error' && <KitchenError message={message} onRetry={reload} />}
      {status === 'ready' && <>
        <div className="kitchen-metrics" aria-label="Souhrn dnešních objednávek">
          <Metric label="K přípravě podle uzávěrky" value={totals.cutoff} />
          <Metric label="Pozdní změny" value={signedCount(totals.late)} accent={totals.late !== 0} />
          <Metric label="Aktuálně očekáváno" value={totals.current} strong />
        </div>
        {totals.current === 0 && <KitchenEmpty text="Na dnešek zatím nejsou žádné objednávky." />}
        <section className="kitchen-variant-list" aria-label="Počty podle jídla a porce">
          {meal.variants.map((variant) => {
            const variantRows = counts.filter((row) => row.mealVariantId === variant.id)
            const total = variantRows.reduce((sum, row) => sum + row.currentCount, 0)
            return <article className="panel kitchen-variant-card" key={variant.id}>
              <h3>{variant.name}</h3>
              <div className="kitchen-portion-counts">
                {portions.map((portion) => <span key={portion.id}><small>{portion.name.replace(/ porce$/i, '')}</small><b>{variantRows.find((row) => row.portionCategoryId === portion.id)?.currentCount ?? 0}</b></span>)}
                <span className="total"><small>Celkem</small><b>{total}</b></span>
              </div>
            </article>
          })}
        </section>
      </>}
    </>}
    {adding && meal && <ManualOrderDialog meal={meal} onClose={() => setAdding(false)} onAdded={async () => { setAdding(false); await reload(); setMessage('Oběd byl přidán.') }} />}
    {message && status === 'ready' && <p className="success-banner" role="status">{message}</p>}
  </section>
}

function KitchenService({ meals }: { meals: MealDay[] }) {
  const today = pragueDateKey()
  const meal = meals.find((item) => item.mealDate === today && item.status === 'published') ?? null
  const [orders, setOrders] = useState<CafeteriaKitchenServiceOrder[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'success' | 'error'>('success')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<KitchenServiceFilter>('all')
  const [variantId, setVariantId] = useState('')
  const [savingId, setSavingId] = useState('')
  const [adding, setAdding] = useState(false)

  const reload = useCallback(async () => {
    try {
      const next = await cafeteriaRepository.loadKitchenService(today)
      setOrders(sortKitchenService(next))
      setStatus('ready')
    } catch (error) {
      setMessage(cafeteriaErrorMessage(error))
      setStatus('error')
    }
  }, [today])
  useEffect(() => { void reload() }, [reload])

  const summary = fulfillmentSummary(orders)
  const variants = [...new Map(orders.map((order) => [order.variantId, order.variantName])).entries()]
  const visible = filterKitchenService(orders, filter, search, variantId)
  const changeStatus = async (order: CafeteriaKitchenServiceOrder, next: CafeteriaFulfillmentStatus) => {
    setSavingId(order.orderId)
    setMessage('')
    try {
      await cafeteriaRepository.setKitchenFulfillment(order.orderId, next)
      await reload()
      setMessageKind('success')
      setMessage(`${order.dinerName}: ${fulfillmentLabels[next]}.`)
    } catch (error) {
      setMessageKind('error')
      setMessage(cafeteriaErrorMessage(error))
    } finally {
      setSavingId('')
    }
  }

  return <section className="kitchen-page">
    <div className="kitchen-title-row">
      <div><p className="eyebrow">VÝDEJ</p><h2>{formatLongDate(today)}</h2></div>
      <button className="primary small kitchen-add" type="button" onClick={() => setAdding(true)} disabled={!meal}>+ Přidat oběd</button>
    </div>
    {status === 'loading' && <KitchenLoading />}
    {status === 'error' && <KitchenError message={message} onRetry={reload} />}
    {status === 'ready' && <>
      <div className="kitchen-service-totals">
        <b>Čeká {summary.waiting}</b><b>📦 Krabičky {summary.boxed}</b><b>✓ Vydáno {summary.issued}</b>
      </div>
      <label className="kitchen-search"><span className="sr-only">Hledat strávníka</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Hledat jméno…" /></label>
      <div className="kitchen-filter-row" aria-label="Filtr stavu výdeje">
        {([['all', 'Všichni'], ['waiting', 'Čeká'], ['boxed', 'Krabičky'], ['issued', 'Vydáno']] as const).map(([value, label]) => <button type="button" className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)} key={value}>{label}</button>)}
      </div>
      {variants.length > 1 && <label className="kitchen-variant-filter">Jídlo<select value={variantId} onChange={(event) => setVariantId(event.target.value)}><option value="">Všechny varianty</option>{variants.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>}
      {!orders.length && <KitchenEmpty text="Dnes není co vydávat." />}
      {!!orders.length && !visible.length && <KitchenEmpty text={filter === 'boxed' ? 'Žádné obědy nečekají v krabičce.' : 'Tomuto filtru nikdo neodpovídá.'} />}
      <div className="kitchen-service-list">{visible.map((order) => <article className={`panel kitchen-service-row status-${order.fulfillmentStatus}`} key={order.orderId}>
        <div><h3>{order.dinerName}</h3><p>{order.quantity > 1 ? `${order.quantity}× · ` : ''}{shortPortion(order.portionName)} · {order.variantName}</p><span className="kitchen-status">{order.fulfillmentStatus === 'boxed' ? '📦 ' : order.fulfillmentStatus === 'issued' ? '✓ ' : ''}{fulfillmentLabels[order.fulfillmentStatus]}</span></div>
        <div className="kitchen-row-actions">
          {order.fulfillmentStatus !== 'waiting' && <button type="button" disabled={savingId === order.orderId} onClick={() => void changeStatus(order, 'waiting')} aria-label={`Vrátit na čeká: ${order.dinerName}`}>Čeká</button>}
          {order.fulfillmentStatus !== 'boxed' && <button type="button" disabled={savingId === order.orderId} onClick={() => void changeStatus(order, 'boxed')} aria-label={`Připravit krabičku pro ${order.dinerName}`}>📦 Krabička</button>}
          {order.fulfillmentStatus !== 'issued' && <button className="primary" type="button" disabled={savingId === order.orderId} onClick={() => void changeStatus(order, 'issued')} aria-label={`Vydat oběd pro ${order.dinerName}`}>✓ Vydat</button>}
        </div>
      </article>)}</div>
    </>}
    {message && status === 'ready' && <p className={messageKind === 'error' ? 'error-banner' : 'success-banner'} role="status">{message}</p>}
    {adding && meal && <ManualOrderDialog meal={meal} onClose={() => setAdding(false)} onAdded={async () => { setAdding(false); await reload(); setMessage('Oběd byl přidán.') }} />}
  </section>
}

function KitchenRequests({ requests, error, onReload }: { requests: CafeteriaKitchenLateRequest[]; error: string; onReload: () => Promise<void> }) {
  const [savingId, setSavingId] = useState('')
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'success' | 'error'>('success')
  const decide = async (request: CafeteriaKitchenLateRequest, decision: 'approved' | 'denied', outcome: 'charged' | 'not_charged' | null = null) => {
    setSavingId(request.requestId)
    setMessage('')
    try {
      await cafeteriaRepository.decideKitchenLateRequest(request.requestId, decision, outcome)
      await onReload()
      setMessageKind('success')
      setMessage(decision === 'denied' ? 'Žádost byla zamítnuta.' : 'Žádost byla schválena.')
    } catch (caught) {
      setMessageKind('error')
      setMessage(cafeteriaErrorMessage(caught))
      await onReload()
    } finally {
      setSavingId('')
    }
  }

  return <section className="kitchen-page">
    <div className="kitchen-title-row"><div><p className="eyebrow">ŽÁDOSTI</p><h2>Čeká na vyřízení · {requests.length}</h2></div></div>
    {error && <KitchenError message={error} onRetry={onReload} />}
    {!error && !requests.length && <KitchenEmpty text="Žádné žádosti nečekají na vyřízení." />}
    <div className="kitchen-request-list">{requests.map((request) => <article className="panel kitchen-request-card" key={request.requestId}>
      <div className="kitchen-request-heading"><div><h3>{request.dinerName}</h3><p>{formatShortDate(request.mealDate)} · {shortPortion(request.portionName)}</p></div><span>{requestTypeLabel(request.requestType)}</span></div>
      {request.requestType === 'cancel' && <p>Aktuální jídlo: <b>{request.currentVariantName ?? 'Neuvedeno'}</b></p>}
      {request.requestType === 'add' && <p>Požadované jídlo: <b>{request.requestedVariantName ?? 'Neuvedeno'}</b></p>}
      {request.requestType === 'change_variant' && <p><span>{request.currentVariantName ?? 'Neuvedeno'}</span><b aria-label="změnit na"> → </b><span>{request.requestedVariantName ?? 'Neuvedeno'}</span></p>}
      <div className="kitchen-request-actions">
        {request.requestType === 'cancel' ? <>
          <button className="primary" type="button" disabled={savingId === request.requestId} onClick={() => void decide(request, 'approved', 'not_charged')}>Odhlásit bez účtování</button>
          <button type="button" disabled={savingId === request.requestId} onClick={() => void decide(request, 'approved', 'charged')}>Odhlásit, ale účtovat</button>
        </> : <button className="primary" type="button" disabled={savingId === request.requestId} onClick={() => void decide(request, 'approved')}>Schválit</button>}
        <button className="danger-text" type="button" disabled={savingId === request.requestId} onClick={() => void decide(request, 'denied')}>Zamítnout</button>
      </div>
    </article>)}</div>
    {message && <p className={messageKind === 'error' ? 'error-banner' : 'success-banner'} role="status">{message}</p>}
  </section>
}

function ManualOrderDialog({ meal, onClose, onAdded }: { meal: MealDay; onClose: () => void; onAdded: () => Promise<void> }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CafeteriaKitchenDiner[]>([])
  const [selected, setSelected] = useState<CafeteriaKitchenDiner | null>(null)
  const [variantId, setVariantId] = useState(meal.variants.length === 1 ? meal.variants[0].id : '')
  const [status, setStatus] = useState<'idle' | 'searching' | 'saving'>('idle')
  const [message, setMessage] = useState('')

  const search = async () => {
    if (!query.trim()) return
    setStatus('searching')
    setMessage('')
    try {
      setResults(await cafeteriaRepository.searchKitchenDiners(query, meal.mealDate))
    } catch (error) {
      setMessage(cafeteriaErrorMessage(error))
    } finally {
      setStatus('idle')
    }
  }
  const add = async () => {
    if (!selected || !variantId) return
    setStatus('saving')
    setMessage('')
    try {
      await cafeteriaRepository.addKitchenOrder(selected.dinerId, meal.id, variantId)
      await onAdded()
    } catch (error) {
      setMessage(cafeteriaErrorMessage(error))
      setStatus('idle')
    }
  }

  return <div className="cafeteria-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="cafeteria-dialog kitchen-manual-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-order-title">
      <div className="cafeteria-dialog-heading"><h2 id="manual-order-title">Přidat oběd</h2><button type="button" onClick={onClose} aria-label="Zavřít">×</button></div>
      <form className="kitchen-diner-search" onSubmit={(event) => { event.preventDefault(); void search() }}>
        <label>Strávník<input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat jméno…" /></label>
        <button type="submit" disabled={!query.trim() || status !== 'idle'}>{status === 'searching' ? 'Hledám…' : 'Hledat'}</button>
      </form>
      <div className="kitchen-search-results">{results.map((diner) => <button type="button" className={selected?.dinerId === diner.dinerId ? 'selected' : ''} aria-pressed={selected?.dinerId === diner.dinerId} onClick={() => setSelected(diner)} key={diner.dinerId}><b>{diner.dinerName}</b><small>{shortPortion(diner.portionName)}</small></button>)}</div>
      {!results.length && query && status === 'idle' && !message && <p className="hint">Žádný aktivní strávník nebyl nalezen.</p>}
      {meal.variants.length > 1 && <fieldset className="kitchen-variant-choice"><legend>Vyberte jídlo</legend>{meal.variants.map((variant) => <label key={variant.id}><input type="radio" name="manual-variant" value={variant.id} checked={variantId === variant.id} onChange={() => setVariantId(variant.id)} /><span>{variant.name}</span></label>)}</fieldset>}
      {meal.variants.length === 1 && <p className="kitchen-single-meal"><small>Jídlo</small><b>{meal.variants[0].name}</b></p>}
      {message && <p className="error-text" role="alert">{message}</p>}
      <button className="primary cafeteria-dialog-submit" type="button" disabled={!selected || !variantId || status !== 'idle'} onClick={() => void add()}>{status === 'saving' ? 'Přidávám…' : 'Přidat oběd'}</button>
    </section>
  </div>
}

function Metric({ label, value, strong = false, accent = false }: { label: string; value: number | string; strong?: boolean; accent?: boolean }) {
  return <article className={`panel kitchen-metric${strong ? ' strong' : ''}${accent ? ' accent' : ''}`}><small>{label}</small><b>{value}</b></article>
}
function KitchenLoading() { return <div className="kitchen-inline-state"><span className="loading-spinner" /><span>Načítám…</span></div> }
function KitchenEmpty({ text }: { text: string }) { return <div className="panel kitchen-empty"><p>{text}</p></div> }
function KitchenError({ message, onRetry }: { message: string; onRetry: () => void | Promise<void> }) { return <div className="panel kitchen-empty error-text"><p>{message}</p><button type="button" onClick={() => void onRetry()}>Zkusit znovu</button></div> }
const requestTypeLabel = (type: CafeteriaKitchenLateRequest['requestType']) => type === 'cancel' ? 'Odhlášení' : type === 'add' ? 'Přihlášení' : 'Změna jídla'
const shortPortion = (value: string) => value.replace(/ porce$/i, '').toLocaleLowerCase('cs')
const pragueDateKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date())
const formatLongDate = (date: string) => new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))
const formatShortDate = (date: string) => new Intl.DateTimeFormat('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))
