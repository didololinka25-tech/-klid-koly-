import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cafeteriaErrorMessage, cafeteriaRepository } from './cafeteriaRepository'
import {
  chooseDraftVariant, dinerWeekHeaderPrice, dinerWeekOrderCount, draftAllForDiner, effectiveChoice,
  formatWeekLabel, isBeforeCutoff, isCurrentWeek, lateRequestMessage, orderDraftChanges, orderDraftKey,
  pragueDateKey, shiftWeek, toggleSingleVariant, weekForDate,
} from './orderingModel'
import type { CafeteriaDiner, CafeteriaFamilyMealWeek, CafeteriaLateRequestType, CafeteriaOrderDraft, MealWeekDay, WeekRange } from './types'

type CellDialog = { diner: CafeteriaDiner; day: MealWeekDay; mode: 'draft' | 'late' }

export function CafeteriaOrdering({ diners, onDirtyChange }: { diners: CafeteriaDiner[]; onDirtyChange?: (dirty: boolean) => void }) {
  const [week, setWeek] = useState<WeekRange>(() => weekForDate(pragueDateKey()))
  const [familyWeek, setFamilyWeek] = useState<CafeteriaFamilyMealWeek | null>(null)
  const [draft, setDraft] = useState<CafeteriaOrderDraft>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [cellMessages, setCellMessages] = useState<Record<string, string>>({})
  const [lateSaving, setLateSaving] = useState<Set<string>>(() => new Set())
  const [dialog, setDialog] = useState<CellDialog | null>(null)
  const requestId = useRef(0)
  const dirtyCount = Object.keys(draft).length

  const loadWeek = useCallback(async (background = false) => {
    const activeRequest = ++requestId.current
    if (!background) { setLoading(true); setError('') }
    try {
      const result = await cafeteriaRepository.loadFamilyMealWeek(diners, week)
      if (activeRequest === requestId.current) setFamilyWeek(result)
      return result
    } catch (loadError) {
      if (activeRequest === requestId.current) {
        if (background) throw loadError
        setError(cafeteriaErrorMessage(loadError))
      }
      return null
    } finally {
      if (!background && activeRequest === requestId.current) setLoading(false)
    }
  }, [diners, week])

  useEffect(() => { void loadWeek() }, [loadWeek])
  useEffect(() => { onDirtyChange?.(dirtyCount > 0) }, [dirtyCount, onDirtyChange])
  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyCount) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [dirtyCount])

  const moveWeek = (next: WeekRange) => {
    if (dirtyCount && !window.confirm('Máte neuložené změny. Zahodit je?')) return
    setDraft({}); setCellMessages({}); setSaveMessage(''); setDialog(null); setWeek(next)
  }

  const saveChanges = async () => {
    if (!familyWeek || !dirtyCount || saving) return
    const changes = orderDraftChanges(familyWeek, draft)
    setSaving(true); setSaveMessage(''); setCellMessages({})
    const result = await cafeteriaRepository.saveOrderDraft(changes)
    setDraft({})
    setCellMessages(Object.fromEntries(result.failed.map(({ change, message }) => [change.key, message])))
    try {
      await loadWeek(true)
      setSaveMessage(saveResultText(result.saved, result.failed.length))
    } catch (loadError) {
      setSaveMessage(`${saveResultText(result.saved, result.failed.length)} Aktuální stav se nepodařilo znovu načíst.`)
      setError(cafeteriaErrorMessage(loadError))
    } finally { setSaving(false) }
  }

  const requestLateChange = async (diner: CafeteriaDiner, day: MealWeekDay, requestType: CafeteriaLateRequestType, variantId: string | null = null) => {
    if (!day.meal || day.lateRequest?.status === 'pending') return
    const key = orderDraftKey(diner.id, day.meal.id)
    setLateSaving((current) => new Set(current).add(key)); setCellMessages((current) => ({ ...current, [key]: '' })); setDialog(null)
    try {
      const result = await cafeteriaRepository.createLateRequest({ dinerId: diner.id, mealDayId: day.meal.id, requestType, requestedVariantId: variantId })
      await loadWeek(true)
      setCellMessages((current) => ({ ...current, [key]: result.created ? 'Žádost byla odeslána.' : '⏳ Čeká na potvrzení' }))
    } catch (requestError) {
      setCellMessages((current) => ({ ...current, [key]: cafeteriaErrorMessage(requestError) }))
    } finally {
      setLateSaving((current) => { const next = new Set(current); next.delete(key); return next })
    }
  }

  const summaries = useMemo(() => familyWeek?.dinerWeeks.map((dinerWeek) => ({ diner: dinerWeek.diner, count: dinerWeekOrderCount(dinerWeek, draft) })) ?? [], [familyWeek, draft])

  if (!diners.length) return <section className="empty cafeteria-empty"><span>👤</span><p>Ke školnímu účtu zatím není propojen žádný strávník.</p></section>

  return <section className={`cafeteria-ordering family-ordering ${dirtyCount ? 'has-draft' : ''}`}>
    <div className="week-picker"><button type="button" aria-label="Předchozí týden" onClick={() => moveWeek(shiftWeek(week, -1))}>‹</button><strong>{formatWeekLabel(week)}</strong><button type="button" aria-label="Následující týden" onClick={() => moveWeek(shiftWeek(week, 1))}>›</button></div>
    {!isCurrentWeek(week) && <button type="button" className="this-week-button" onClick={() => moveWeek(weekForDate(pragueDateKey()))}>Tento týden</button>}
    {loading && <div className="ordering-loading"><span className="loading-spinner" /> Načítám rodinný týden…</div>}
    {!loading && error && <section className="panel cafeteria-state"><p>{error}</p><button type="button" onClick={() => void loadWeek()}>Zkusit znovu</button></section>}
    {!loading && !error && familyWeek && <>
      <FamilyGrid familyWeek={familyWeek} draft={draft} cellMessages={cellMessages} lateSaving={lateSaving} onToggle={(diner, day) => setDraft((current) => toggleSingleVariant(current, diner.id, day))} onOpenDialog={(diner, day, mode) => setDialog({ diner, day, mode })} onAll={(dinerId) => setDraft((current) => draftAllForDiner(familyWeek, dinerId, current))} />
      <div className="family-week-summary" aria-label="Souhrn objednávek v týdnu">{summaries.map(({ diner, count }) => <p key={diner.id}><b>{diner.fullName}:</b> {count} {lunchCountWord(count)}</p>)}</div>
      {saveMessage && <div className="save-result" aria-live="polite">{saveMessage}</div>}
    </>}
    {dirtyCount > 0 && <div className="draft-save-bar" role="region" aria-label="Neuložené změny"><span>Máte {dirtyCount} {changeCountWord(dirtyCount)}</span><div><button type="button" className="discard-draft" disabled={saving} onClick={() => { setDraft({}); setSaveMessage('') }}>Zahodit změny</button><button type="button" disabled={saving} onClick={() => void saveChanges()}>{saving ? 'Ukládám…' : 'Uložit změny'}</button></div></div>}
    {dialog && <CellChoiceDialog dialog={dialog} draft={draft} onClose={() => setDialog(null)} onDraftChoice={(variantId) => { setDraft((current) => chooseDraftVariant(current, dialog.diner.id, dialog.day, variantId)); setDialog(null) }} onLateRequest={(type, variantId) => void requestLateChange(dialog.diner, dialog.day, type, variantId)} />}
  </section>
}

function FamilyGrid({ familyWeek, draft, cellMessages, lateSaving, onToggle, onOpenDialog, onAll }: { familyWeek: CafeteriaFamilyMealWeek; draft: CafeteriaOrderDraft; cellMessages: Record<string, string>; lateSaving: Set<string>; onToggle: (diner: CafeteriaDiner, day: MealWeekDay) => void; onOpenDialog: (diner: CafeteriaDiner, day: MealWeekDay, mode: 'draft' | 'late') => void; onAll: (dinerId: string) => void }) {
  const rowCount = familyWeek.dinerWeeks[0]?.days.length ?? 0
  return <div className="family-grid-scroll" tabIndex={0} aria-label="Rodinná týdenní objednávková mřížka, vodorovně posuvná"><table className="family-order-grid"><thead><tr><th scope="col" className="meal-column">Den / jídlo</th>{familyWeek.dinerWeeks.map((dinerWeek) => { const price = dinerWeekHeaderPrice(dinerWeek); return <th scope="col" key={dinerWeek.diner.id}><b>{dinerWeek.diner.fullName}</b><small>{portionPriceLabel(dinerWeek.diner, price)}</small><button type="button" onClick={() => onAll(dinerWeek.diner.id)} aria-label={`Připravit všechny vhodné obědy pro ${dinerWeek.diner.fullName}`}>Vše</button></th> })}</tr></thead><tbody>{Array.from({ length: rowCount }, (_, dayIndex) => { const day = familyWeek.dinerWeeks[0].days[dayIndex]; return <tr key={day.mealDate}><th scope="row" className="meal-column"><MealDescription day={day} /></th>{familyWeek.dinerWeeks.map((dinerWeek) => { const dinerDay = dinerWeek.days[dayIndex]; return <td key={dinerWeek.diner.id}><OrderCell diner={dinerWeek.diner} day={dinerDay} draft={draft} message={dinerDay.meal ? cellMessages[orderDraftKey(dinerWeek.diner.id, dinerDay.meal.id)] ?? '' : ''} lateSaving={Boolean(dinerDay.meal && lateSaving.has(orderDraftKey(dinerWeek.diner.id, dinerDay.meal.id)))} onToggle={() => onToggle(dinerWeek.diner, dinerDay)} onOpenDialog={(mode) => onOpenDialog(dinerWeek.diner, dinerDay, mode)} /></td> })}</tr> })}</tbody></table></div>
}

function MealDescription({ day }: { day: MealWeekDay }) {
  if (!day.meal) return <div className="grid-meal"><b>{shortDate(day.mealDate)}</b><span>Jídelníček není zveřejněn</span></div>
  if (day.meal.status === 'cancelled') return <div className="grid-meal"><b>{shortDate(day.mealDate)}</b><span className="no-cooking">Nevaří se</span>{day.meal.note && <small>{day.meal.note}</small>}</div>
  return <div className="grid-meal"><b>{shortDate(day.mealDate)}</b>{day.meal.variants.map((variant) => <MealName name={variant.name} key={variant.id} />)}{!day.meal.variants.length && <span>Jídlo není doplněno</span>}</div>
}

function MealName({ name }: { name: string }) {
  if (name.length <= 42) return <span>{name}</span>
  return <details><summary>{`${name.slice(0, 39)}…`}</summary><span>{name}</span></details>
}

function OrderCell({ diner, day, draft, message, lateSaving, onToggle, onOpenDialog }: { diner: CafeteriaDiner; day: MealWeekDay; draft: CafeteriaOrderDraft; message: string; lateSaving: boolean; onToggle: () => void; onOpenDialog: (mode: 'draft' | 'late') => void }) {
  if (!day.meal || day.meal.status !== 'published' || !day.meal.variants.length) return <span className="inactive-cell" aria-label={`${fullDay(day.mealDate)} pro ${diner.fullName}: objednávka není dostupná`}>—</span>
  const key = orderDraftKey(diner.id, day.meal.id)
  const choice = effectiveChoice(day, diner.id, draft)
  const changed = Boolean(draft[key])
  const open = isBeforeCutoff(day)
  const pending = day.lateRequest?.status === 'pending'
  const variant = day.meal.variants.find((item) => item.id === choice.variantId)
  const label = `${choice.ordered ? 'Změnit nebo odhlásit' : 'Objednat'} ${fullDay(day.mealDate)} pro ${diner.fullName}`
  if (!open) return <div className="grid-order-cell closed-cell"><span className="cell-state">{choice.ordered ? shortVariant(variant?.name ?? 'Objednáno') : '🔒'}</span>{pending ? <span className="pending-cell">⏳ Čeká</span> : <button type="button" disabled={lateSaving} onClick={() => onOpenDialog('late')} aria-label={`Pozdní změna ${fullDay(day.mealDate)} pro ${diner.fullName}`}>{lateSaving ? 'Odesílám…' : 'Požádat'}</button>}{day.lateRequest && !pending && <small>{lateRequestMessage(day.lateRequest)}</small>}{message && <small className="cell-message">{message}</small>}</div>
  const canTurnOn = choice.ordered || day.price != null
  if (day.meal.variants.length === 1) return <div className={`grid-order-cell ${changed ? 'draft-changed' : ''}`}><button type="button" className="single-choice" disabled={!canTurnOn} aria-pressed={choice.ordered} aria-label={label} onClick={onToggle}><span aria-hidden="true">{choice.ordered ? '✓' : '☐'}</span><small>{choice.ordered ? 'Objednáno' : day.price == null ? 'Bez ceny' : 'Objednat'}</small></button>{changed && <span className="draft-mark">● změna</span>}{message && <small className="cell-message">{message}</small>}</div>
  return <div className={`grid-order-cell ${changed ? 'draft-changed' : ''}`}><button type="button" className="variant-choice" disabled={!canTurnOn} aria-label={label} onClick={() => onOpenDialog('draft')}><span>{choice.ordered ? shortVariant(variant?.name ?? 'Vybráno') : 'Vybrat'}</span><small>{choice.ordered ? '✓ vybráno' : day.price == null ? 'Cena chybí' : `${day.meal.variants.length} varianty`}</small></button>{changed && <span className="draft-mark">● změna</span>}{message && <small className="cell-message">{message}</small>}</div>
}

function CellChoiceDialog({ dialog, draft, onClose, onDraftChoice, onLateRequest }: { dialog: CellDialog; draft: CafeteriaOrderDraft; onClose: () => void; onDraftChoice: (variantId: string | null) => void; onLateRequest: (type: CafeteriaLateRequestType, variantId: string | null) => void }) {
  const { diner, day, mode } = dialog
  const choice = effectiveChoice(day, diner.id, draft)
  const variants = day.meal?.variants ?? []
  useEffect(() => { const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', closeOnEscape); return () => window.removeEventListener('keydown', closeOnEscape) }, [onClose])
  return <div className="cell-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="cell-dialog" role="dialog" aria-modal="true" aria-labelledby="cell-dialog-title"><div className="cell-dialog-head"><div><small>{diner.fullName}</small><h2 id="cell-dialog-title">{fullDay(day.mealDate)}</h2></div><button type="button" aria-label="Zavřít výběr" onClick={onClose}>×</button></div>{mode === 'draft' ? <><p>Vyberte jídlo:</p><div className="full-variant-list">{variants.map((variant, index) => <button type="button" autoFocus={index === 0} className={choice.variantId === variant.id ? 'selected' : ''} key={variant.id} onClick={() => onDraftChoice(variant.id)}><span>{choice.variantId === variant.id ? '✓' : '○'}</span><span><b>{variant.name}</b>{variant.note && <small>{variant.note}</small>}</span></button>)}</div>{choice.ordered && <button type="button" className="dialog-cancel-order" onClick={() => onDraftChoice(null)}>Odhlásit oběd</button>}</> : <LateActions day={day} onRequest={onLateRequest} />}</section></div>
}

function LateActions({ day, onRequest }: { day: MealWeekDay; onRequest: (type: CafeteriaLateRequestType, variantId: string | null) => void }) {
  const ordered = day.order?.status === 'ordered'; const variants = day.meal?.variants ?? []
  if (!ordered) return <><p>Požádat o dodatečné přihlášení:</p><div className="full-variant-list">{variants.map((variant, index) => <button type="button" autoFocus={index === 0} key={variant.id} onClick={() => onRequest('add', variant.id)}><span>＋</span><span><b>{variant.name}</b>{variant.note && <small>{variant.note}</small>}</span></button>)}</div></>
  return <><button type="button" autoFocus className="dialog-cancel-order" onClick={() => onRequest('cancel', null)}>Požádat o odhlášení</button>{variants.length > 1 && <><p>Požádat o změnu jídla:</p><div className="full-variant-list">{variants.filter((variant) => variant.id !== day.order?.mealVariantId).map((variant) => <button type="button" key={variant.id} onClick={() => onRequest('change_variant', variant.id)}><span>↔</span><span><b>{variant.name}</b>{variant.note && <small>{variant.note}</small>}</span></button>)}</div></>}</>
}

const shortDate = (value: string) => new Intl.DateTimeFormat('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`)).toUpperCase()
const fullDay = (value: string) => new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`))
const shortVariant = (value: string) => value.length > 18 ? `${value.slice(0, 17)}…` : value
const formatPrice = (price: number) => new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: price % 1 === 0 ? 0 : 2 }).format(price)
const portionPriceLabel = (diner: CafeteriaDiner, price: number | null) => `${(diner.portionName ?? 'Porce neurčena').replace(/ porce$/i, '').toLocaleLowerCase('cs-CZ')}${price == null ? '' : ` · ${formatPrice(price)}`}`
const lunchCountWord = (count: number) => count === 1 ? 'oběd' : count >= 2 && count <= 4 ? 'obědy' : 'obědů'
const changeCountWord = (count: number) => count === 1 ? 'neuloženou změnu' : count >= 2 && count <= 4 ? 'neuložené změny' : 'neuložených změn'
const saveResultText = (saved: number, failed: number) => failed ? `${saved} ${saved === 1 ? 'změna uložena' : 'změn uloženo'}. ${failed} ${failed === 1 ? 'změnu se nepodařilo uložit' : 'změn se nepodařilo uložit'}.` : `Uloženo ${saved} ${saved === 1 ? 'změna' : 'změn'}.`
