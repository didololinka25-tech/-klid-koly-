export const IMPORT_STATUSES = Object.freeze({
  CREATE: 'CREATE', SKIP_ALREADY_EXISTS: 'SKIP_ALREADY_EXISTS', UNMATCHED_DINER: 'UNMATCHED_DINER',
  AMBIGUOUS_VARIANT: 'AMBIGUOUS_VARIANT', INVALID_QUANTITY: 'INVALID_QUANTITY',
  MEAL_DAY_NOT_FOUND: 'MEAL_DAY_NOT_FOUND', PRICE_RULE_NOT_FOUND: 'PRICE_RULE_NOT_FOUND',
})

export const EXPLICIT_DINER_ALIASES = Object.freeze({
  'Kozlíková Rozárka': 'f03972d6-9e27-4986-9133-c4aa8e0eb4c5',
  'Matějka Ondra': 'e925d6a9-37b2-40da-9168-c4fbe3725fae',
  'Matějka Vítek': '8709d759-b542-4825-9d0b-7524963de1a6',
  'Mičánek Maty': '0da4e629-5d22-4ab6-a525-635bcf200907',
  'Mičánková Markétka': 'c7bd0ce8-9f81-4318-a05c-a74c40b6e5fa',
  'Opatová Adélka': '641e60fa-08b4-497e-a98b-490d18349f04',
  'Rechová Amálka': '44744078-bcf8-465f-8faf-c77244d52a97',
  'Richterová Izabelka': 'c63d10da-3fe8-45fd-8b4e-170cefc299b0',
  'Vyplašilová Mirka': '779ae838-44c0-4903-98f9-844a572435cb',
})

export const EXPLICIT_PER_DAY_COLOR_ALIASES = Object.freeze({
  '2026-09-01|00FF00': 1,
  '2026-09-01|93C47D': 1,
  '2026-09-08|EA4335': 1,
  '2026-09-09|EA4335': 1,
  '2026-09-10|000000': 2,
  '2026-09-10|EA4335': 1,
  '2026-09-11|000000': 1,
  '2026-09-11|FF0000': 2,
  '2026-09-11|EA4335': 2,
  '2026-09-14|A64D79': 1,
})

export function normalizePersonName(value) {
  return String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('cs-CZ')
}

function normalizeAuxiliaryLabel(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('cs-CZ')
}

/**
 * Conservative allow-list of known non-person rows in the legacy order sheet.
 * Unknown labels are deliberately kept so a real person can become
 * UNMATCHED_DINER instead of disappearing silently.
 */
export function isAuxiliaryOrderRow(sourceParts) {
  const label = normalizeAuxiliaryLabel(sourceParts.join(' '))
  return /^\d+(?:[.,]\d+)?\s*kc\b/.test(label)
    || /^cena\b(?:.*\bkc\b|\s*[:\-–—])/.test(label)
    || /^(?:\d+\s+)?navstevy\b/.test(label)
    || /^(?:souhrn|celkem)\b/.test(label)
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

const CZECH_MONTHS = new Map([
  ['LEDEN', 1], ['UNOR', 2], ['BREZEN', 3], ['DUBEN', 4],
  ['KVETEN', 5], ['CERVEN', 6], ['CERVENEC', 7], ['SRPEN', 8],
  ['ZARI', 9], ['RIJEN', 10], ['LISTOPAD', 11], ['PROSINEC', 12],
])

function sheetMonthYear(sheetName) {
  const tokens = String(sheetName ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('cs-CZ')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  const months = tokens.filter((token) => CZECH_MONTHS.has(token))
  const years = tokens.filter((token) => /^20\d{2}$/.test(token))
  if (months.length !== 1 || years.length !== 1) return null
  return { month: CZECH_MONTHS.get(months[0]), year: Number(years[0]) }
}

function numericDay(cell) {
  const value = typeof cell.value === 'object' && cell.value && 'result' in cell.value
    ? cell.value.result
    : cell.value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31) return value
  if (typeof value === 'string' && /^(?:[1-9]|[12]\d|3[01])$/.test(value.trim())) return Number(value.trim())
  return null
}

function numericMonthHeader(sheet) {
  const candidates = []
  sheet.eachRow((row, rowNumber) => {
    const days = []
    row.eachCell((cell, column) => {
      const day = numericDay(cell)
      if (day !== null) days.push({ column, day, address: cell.address })
    })
    if (days.length < 3) return
    if (!days.every((item, index) => index === 0 || item.day > days[index - 1].day)) return
    const span = days.at(-1).column - days[0].column + 1
    if (days.length / span < 0.5) return
    candidates.push({ row: rowNumber, days })
  })
  if (!candidates.length) return null
  candidates.sort((a, b) => b.days.length - a.days.length)
  if (candidates[1]?.days.length === candidates[0].days.length) {
    throw new Error('V měsíčním listu nebyla jednoznačně určena řádka s hlavičkou objednávkových dnů.')
  }
  return candidates[0]
}

function findOrderDateHeader(sheet) {
  const fullDateHeader = findDateHeader(sheet)
  if (fullDateHeader.row && fullDateHeader.dates.size) return fullDateHeader

  const monthYear = sheetMonthYear(sheet.name)
  if (!monthYear) {
    throw new Error(`Měsíc a rok nelze bezpečně určit z názvu listu „${sheet.name}“.`)
  }
  const header = numericMonthHeader(sheet)
  if (!header) return { row: 0, dates: new Map() }

  const dates = new Map()
  for (const item of header.days) {
    const date = new Date(Date.UTC(monthYear.year, monthYear.month - 1, item.day))
    if (date.getUTCFullYear() !== monthYear.year || date.getUTCMonth() + 1 !== monthYear.month || date.getUTCDate() !== item.day) {
      throw new Error(`Neplatný den ${item.day} pro měsíc a rok z názvu listu „${sheet.name}“ (${item.address}).`)
    }
    dates.set(item.column, `${monthYear.year}-${String(monthYear.month).padStart(2, '0')}-${String(item.day).padStart(2, '0')}`)
  }
  return { row: header.row, dates }
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
  const exactSourceName = sourceParts.join(' ')
  if (Object.prototype.hasOwnProperty.call(EXPLICIT_DINER_ALIASES, exactSourceName)) {
    const dinerId = EXPLICIT_DINER_ALIASES[exactSourceName]
    const matches = diners.filter((diner) => diner.id === dinerId)
    return matches.length === 1 ? matches[0] : null
  }

  const parts = sourceParts.map(normalizePersonName).filter(Boolean)
  const sourceKeys = new Set([parts.join(' '), [...parts].reverse().join(' ')])
  const matches = diners.filter((diner) => [...dinerKeys(diner.full_name)].some((key) => sourceKeys.has(key)))
  return matches.length === 1 ? matches[0] : null
}

export function matchVariant(dbVariants, menuVariants, orderColor, mealDate = null) {
  const activeDatabaseVariants = dbVariants.filter((variant) => variant.active !== false)
  if (activeDatabaseVariants.length === 1) return activeDatabaseVariants[0]
  if (activeDatabaseVariants.length < 2 || !orderColor) return null
  const color = normalizeFontColor({ argb: orderColor })
  if (!color) return null

  const aliasKey = `${mealDate}|${color}`
  if (mealDate && Object.prototype.hasOwnProperty.call(EXPLICIT_PER_DAY_COLOR_ALIASES, aliasKey)) {
    const sortOrder = EXPLICIT_PER_DAY_COLOR_ALIASES[aliasKey]
    const matches = activeDatabaseVariants.filter((variant) => Number(variant.sort_order) === sortOrder)
    return matches.length === 1 ? matches[0] : null
  }

  if (activeDatabaseVariants.length !== menuVariants.length) return null
  const menuColors = menuVariants.map((variant) => normalizeFontColor({ argb: variant.color }))
  if (menuColors.some((item) => !item) || new Set(menuColors).size !== menuColors.length) return null
  const menuIndex = menuColors.findIndex((item) => item === color)
  if (menuIndex < 0) return null

  const sortOrders = activeDatabaseVariants.map((variant) => Number(variant.sort_order))
  if (sortOrders.some((item) => !Number.isInteger(item)) || new Set(sortOrders).size !== sortOrders.length) return null
  const orderedDatabaseVariants = [...activeDatabaseVariants].sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
  return orderedDatabaseVariants[menuIndex] ?? null
}

export function extractOrderCells(sheet) {
  const header = findOrderDateHeader(sheet)
  if (!header.row || !header.dates.size) throw new Error('V měsíčním listu nebyla nalezena hlavička se skutečnými daty.')
  const firstDateColumn = Math.min(...header.dates.keys()); const rows = []
  for (let rowNumber = header.row + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber); const sourceParts = []
    for (let column = 1; column < firstDateColumn; column += 1) { const text = cellText(row.getCell(column)); if (text) sourceParts.push(text) }
    if (sourceParts.length < 2) continue
    if (isAuxiliaryOrderRow(sourceParts)) continue
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
    const variant = matchVariant(variants, menuColors.get(source.mealDate) ?? [], source.color, source.mealDate)
    if (!variant) return { ...base, diner, mealDay, status: IMPORT_STATUSES.AMBIGUOUS_VARIANT, reason: 'Variantu nelze jednoznačně určit podle barvy pro tento den.' }
    const prices = database.priceRules.filter((rule) => rule.portion_category_id === diner.portion_category_id && rule.active && rule.valid_from <= source.mealDate && (!rule.valid_to || rule.valid_to >= source.mealDate)).sort((a, b) => b.valid_from.localeCompare(a.valid_from))
    if (!prices[0]) return { ...base, diner, mealDay, variant, status: IMPORT_STATUSES.PRICE_RULE_NOT_FOUND, reason: 'Chybí platné cenové pravidlo.' }
    return { ...base, diner, mealDay, variant, unitPrice: Number(prices[0].price), status: IMPORT_STATUSES.CREATE, reason: '' }
  })
}
