import type {
  CafeteriaFulfillmentStatus,
  CafeteriaKitchenCount,
  CafeteriaKitchenServiceOrder,
  CafeteriaKitchenTotals,
} from './types'

export type KitchenServiceFilter = 'all' | CafeteriaFulfillmentStatus

export const fulfillmentLabels: Record<CafeteriaFulfillmentStatus, string> = {
  waiting: 'Čeká',
  boxed: 'Krabička',
  issued: 'Vydáno',
}

export function summarizeKitchenCounts(rows: CafeteriaKitchenCount[]): CafeteriaKitchenTotals {
  return rows.reduce<CafeteriaKitchenTotals>((total, row) => ({
    cutoff: total.cutoff + row.cutoffCount,
    late: total.late + row.lateDelta,
    current: total.current + row.currentCount,
    small: total.small + (row.portionCode === 'small' ? row.currentCount : 0),
    large: total.large + (row.portionCode === 'large' ? row.currentCount : 0),
  }), { cutoff: 0, late: 0, current: 0, small: 0, large: 0 })
}

export function fulfillmentSummary(rows: CafeteriaKitchenServiceOrder[]) {
  return rows.reduce((total, row) => {
    total[row.fulfillmentStatus] += 1
    return total
  }, { waiting: 0, boxed: 0, issued: 0 })
}

const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('cs')

export function filterKitchenService(
  rows: CafeteriaKitchenServiceOrder[],
  filter: KitchenServiceFilter,
  search: string,
  variantId = '',
) {
  const needle = normalized(search.trim())
  return rows.filter((row) => (
    (filter === 'all' || row.fulfillmentStatus === filter)
    && (!needle || normalized(row.dinerName).includes(needle))
    && (!variantId || row.variantId === variantId)
  ))
}

export function sortKitchenService(rows: CafeteriaKitchenServiceOrder[]) {
  const priority: Record<CafeteriaFulfillmentStatus, number> = { waiting: 0, boxed: 1, issued: 2 }
  return [...rows].sort((a, b) => (
    priority[a.fulfillmentStatus] - priority[b.fulfillmentStatus]
    || a.dinerName.localeCompare(b.dinerName, 'cs')
  ))
}

export const signedCount = (value: number) => value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0'

