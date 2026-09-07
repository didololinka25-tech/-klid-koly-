export const IMPORT_STATUSES = Object.freeze({
  CREATE: 'CREATE', SKIP_ALREADY_EXISTS: 'SKIP_ALREADY_EXISTS', UNMATCHED_DINER: 'UNMATCHED_DINER',
  AMBIGUOUS_VARIANT: 'AMBIGUOUS_VARIANT', INVALID_QUANTITY: 'INVALID_QUANTITY',
  MEAL_DAY_NOT_FOUND: 'MEAL_DAY_NOT_FOUND', PRICE_RULE_NOT_FOUND: 'PRICE_RULE_NOT_FOUND',
})

export function normalizePersonName(value) {
  return String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('cs-CZ')
}

export function normalizeFontColor(color) {
  const argb = String(color?.argb ?? '').replace(/^#/, '').toUpperCase()
  if (!/^(?:[0-9A-F]{6}|[0-9A-F]{8})$/.test(argb)) return null
  return argb.slice(-6)
}

export function parseLegacyQuantity(value, max = 10) {
  if (value == null || value === '' || value === 0 || value === '0') return { kind: 'none', quantity: 0 }
  const numeric = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > max) return { kind: 'invalid', quantity: numeric }
  return numeric === 0 ? { kind: 'none', quantity: 0 } : { kind: 'order', quantity: numeric }
}

export function excelDateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  const match = String(value ?? '').trim().match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?$/)
  if (!match) return null
  const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : 2026
  const month = Number(match[2]); const day = Number(match[1])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function cellText(cell) {
  if (cell.value == null) return ''
  if (typeof cell.value === 'object' && 'result' in cell.value) return String(cell.value.result ?? '')
  if (typeof cell.value === 'object' && 'richText' in cell.value) return cell.value.richText.map((part) => part.text).join('')
  return String(cell.text ?? cell.value).trim()
}

function cellFontColor(cell) {
  const direct = normalizeFontColor(cell.font?.color)
  if (direct) return direct
  const runs = typeof cell.value === 'object' && cell.value && 'richText' in cell.value ? cell.value.richText : []
  const colors = [...new Set(runs.map((part) => normalizeFontColor(part.font?.color)).filter(Boolean))]
  return colors.length === 1 ? colors[0] : null
}

function cleanVerticalVariantName(value) {
  return String(value ?? '').trim().replace(/^[,;]\s*/, '').replace(/^1\s*[-–—]\s*/, '').trim()
}

function verticalMenuVariants(cell) {
  const text = cellText(cell)
  if (!text) return []
  const richText = typeof cell.value === 'object' && cell.value && 'richText' in cell.value
    ? cell.value.richText.filter((part) => String(part.text ?? '').length > 0)
    : []
  if (richText.length < 2) return [{ name: cleanVerticalVariantName(text), color: cellFontColor(cell) }]

  const fallbackColor = normalizeFontColor(cell.font?.color) ?? '000000'
  const groups = []
  for (const part of richText) {
    const color = normalizeFontColor(part.font?.color) ?? fallbackColor
    const previous = groups.at(-1)
    if (previous?.color === color) previous.text += part.text
    else groups.push({ text: part.text, color })
  }

  // Rich text can be split for emphasis without denoting multiple meals. Only a
  // real color boundary is a safe signal that the cell contains variants.
  if (groups.length < 2) return [{ name: cleanVerticalVariantName(text), color: groups[0]?.color ?? fallbackColor }]
  return groups
    .map((group) => ({ name: cleanVerticalVariantName(group.text), color: group.color }))
    .filter((variant) => variant.name)
}

export function findDateHeader(sheet) {
  let best = { row: 0, dates: new Map() }
  sheet.eachRow((row, rowNumber) => {
    const dates = new Map()
    row.eachCell((cell, column) => { const key = excelDateKey(cell.value); if (key) dates.set(column, key) })
    if (dates.size > best.dates.size) best = { row: rowNumber, dates }
  })
  return best
}

export function extractMenuColors(sheet) {
  const header = findDateHeader(sheet); const byDate = new Map()
  const verticalRows = []
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    const date = excelDateKey(sheet.getCell(row, 2).value)
    if (date) verticalRows.push({ row, date, menuCell: sheet.getCell(row, 3) })
  }
  const verticalWithMenu = verticalRows.filter(({ menuCell }) => cellText(menuCell))
  const singleVertical = verticalRows.length === 1
    && verticalWithMenu.length === 1
    && header.row === verticalRows[0].row
    && header.dates.size === 1
    && !cellText(sheet.getCell(verticalRows[0].row + 1, 2))
  const isVertical = (verticalRows.length > 1 && verticalWithMenu.length > 0) || singleVertical
  if (isVertical) {
    for (const { date, menuCell } of verticalRows) byDate.set(date, verticalMenuVariants(menuCell))
    return byDate
  }

  for (const [column, date] of header.dates) {
    const variants = []
    for (let row = header.row + 1; row <= Math.min(sheet.rowCount, header.row + 12); row += 1) {
      const cell = sheet.getCell(row, column); const name = cellText(cell)
      if (!name) continue
      if (excelDateKey(cell.value)) break
      variants.push({ name, color: cellFontColor(cell) })
    }
    byDate.set(date, variants)
  }
  return byDate
}

function dinerKeys(fullName) {
  const parts = normalizePersonName(fullName).split(' ').filter(Boolean)
  return new Set([parts.join(' '), [...parts].reverse().join(' ')])
}

export function matchDiner(sourceParts, diners) {
  const parts = sourceParts.map(normalizePersonName).filter(Boolean)
  const sourceKeys = new Set([parts.join(' '), [...parts].reverse().join(' ')])
  const matches = diners.filter((diner) => [...dinerKeys(diner.full_name)].some((key) => sourceKeys.has(key)))
  return matches.length === 1 ? matches[0] : null
}

export function matchVariant(dbVariants, menuVariants, orderColor) {
  if (dbVariants.length === 1) return dbVariants[0]
  if (dbVariants.length < 2 || !orderColor) return null
  const color = normalizeFontColor({ argb: orderColor })
  const matches = menuVariants.flatMap((menu) => menu.color === color
    ? dbVariants.filter((variant) => normalizePersonName(variant.name) === normalizePersonName(menu.name)) : [])
  const unique = [...new Map(matches.map((variant) => [variant.id, variant])).values()]
  return unique.length === 1 ? unique[0] : null
}

export function extractOrderCells(sheet) {
  const header = findDateHeader(sheet)
  if (!header.row || !header.dates.size) throw new Error('V měsíčním listu nebyla nalezena hlavička se skutečnými daty.')
  const firstDateColumn = Math.min(...header.dates.keys()); const rows = []
  for (let rowNumber = header.row + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber); const sourceParts = []
    for (let column = 1; column < firstDateColumn; column += 1) { const text = cellText(row.getCell(column)); if (text) sourceParts.push(text) }
    if (sourceParts.length < 2) continue
    for (const [column, mealDate] of header.dates) {
      const cell = row.getCell(column); const parsed = parseLegacyQuantity(cell.value)
      if (parsed.kind === 'none') continue
      rows.push({ mealDate, sourceParts: sourceParts.slice(-2), sourceName: sourceParts.slice(-2).join(' '), value: cell.value, quantity: parsed.quantity, quantityKind: parsed.kind, color: cellFontColor(cell) })
    }
  }
  return rows
}

export function planImport(sourceRows, database, menuColors) {
  return sourceRows.map((source) => {
    const base = { ...source, diner: null, mealDay: null, variant: null, unitPrice: null }
    if (source.quantityKind === 'invalid') return { ...base, status: IMPORT_STATUSES.INVALID_QUANTITY, reason: 'Neplatný počet porcí.' }
    const diner = matchDiner(source.sourceParts, database.diners)
    if (!diner) return { ...base, status: IMPORT_STATUSES.UNMATCHED_DINER, reason: 'Strávník nebyl nalezen jednoznačně.' }
    const mealDay = database.mealDays.find((day) => day.meal_date === source.mealDate)
    if (!mealDay) return { ...base, diner, status: IMPORT_STATUSES.MEAL_DAY_NOT_FOUND, reason: 'Jídelní den v databázi neexistuje.' }
    if (database.orders.some((order) => order.diner_id === diner.id && order.meal_day_id === mealDay.id)) return { ...base, diner, mealDay, status: IMPORT_STATUSES.SKIP_ALREADY_EXISTS, reason: 'Objednávka již existuje.' }
    const variants = database.variants.filter((variant) => variant.meal_day_id === mealDay.id && variant.active)
    const variant = matchVariant(variants, menuColors.get(source.mealDate) ?? [], source.color)
    if (!variant) return { ...base, diner, mealDay, status: IMPORT_STATUSES.AMBIGUOUS_VARIANT, reason: 'Variantu nelze jednoznačně určit podle barvy pro tento den.' }
    const prices = database.priceRules.filter((rule) => rule.portion_category_id === diner.portion_category_id && rule.active && rule.valid_from <= source.mealDate && (!rule.valid_to || rule.valid_to >= source.mealDate)).sort((a, b) => b.valid_from.localeCompare(a.valid_from))
    if (!prices[0]) return { ...base, diner, mealDay, variant, status: IMPORT_STATUSES.PRICE_RULE_NOT_FOUND, reason: 'Chybí platné cenové pravidlo.' }
    return { ...base, diner, mealDay, variant, unitPrice: Number(prices[0].price), status: IMPORT_STATUSES.CREATE, reason: '' }
  })
}
