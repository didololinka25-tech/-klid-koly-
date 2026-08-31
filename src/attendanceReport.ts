import type { Attendance } from './types'

const HOUR_MS = 60 * 60 * 1000

export type AttendanceReportRow = {
  id: string
  date: string
  day: string
  workplace: string
  start: string
  end: string
  durationMs: number
  contractType?: 'dpp' | 'dpc' | 'other'
  hourlyRate?: number
  grossEstimate?: number
}

export type AttendanceContract = {
  id?: string
  contractType: 'dpp' | 'dpc' | 'other'
  validFrom: string
  validTo?: string
  active: boolean
  hourlyRate?: number
}

export type AttendanceContractSegment = {
  key: string
  contractType: 'dpp' | 'dpc' | 'other'
  validFrom: string
  validTo?: string
  hourlyRate?: number
  durationMs: number
  grossEstimate?: number
}

export type AttendanceReport = {
  workerName: string
  month: string
  monthLabel: string
  workplaces: string[]
  rows: AttendanceReportRow[]
  workplaceTotals: { name: string; durationMs: number }[]
  monthMs: number
  yearMs: number
  dppYearMs: number
  dppMonthMs: number
  annualLimitHours: number
  contractLabel: string
  hourlyRateLabel: string
  contractSegments: AttendanceContractSegment[]
  grossEstimate?: number
  missingContractMs: number
  missingRateMs: number
  dpcMonthMs: number
  dpcGrossEstimate?: number
  dpcMonthlyThreshold: number
  dpcRemainingIncome?: number
  dpcRemainingMsAtCurrentRate?: number
  dpcRequiredMsAtCurrentRate?: number
  dpcThresholdReached: boolean
  generatedAt: Date
}

const duration = (record: Attendance, now: Date) =>
  Math.max(0, new Date(record.end ?? now).getTime() - new Date(record.start).getTime())

export function reportDuration(value: number) {
  const minutes = Math.round(value / 60000)
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

export function reportMoney(value: number) {
  return new Intl.NumberFormat('cs-CZ', {
    style: 'currency',
    currency: 'CZK',
    maximumFractionDigits: 2,
  }).format(value)
}

export function reportDurationCeil(value: number) {
  const minutes = Math.ceil(Math.max(0, value) / 60000)
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

const contractForDate = (contracts: AttendanceContract[], date: string) =>
  contracts.find((contract) =>
    contract.active && contract.validFrom <= date && (!contract.validTo || contract.validTo >= date),
  )

const contractOverlapsMonth = (contract: AttendanceContract, month: string) => {
  const monthStart = `${month}-01`
  const monthEnd = new Date(`${monthStart}T12:00:00`)
  monthEnd.setMonth(monthEnd.getMonth() + 1)
  monthEnd.setDate(0)
  const endKey = `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`
  return contract.active && contract.validFrom <= endKey && (!contract.validTo || contract.validTo >= monthStart)
}

export function buildAttendanceReport(
  records: Attendance[],
  workerName: string,
  month: string,
  annualLimitHours: number,
  now = new Date(),
  contracts: AttendanceContract[] = [],
  dpcMonthlyThreshold = 4500,
): AttendanceReport {
  const year = month.slice(0, 4)
  const monthRecords = records
    .filter((record) => record.date.startsWith(month))
    .sort((a, b) => a.start.localeCompare(b.start))
  const rows = monthRecords.map((record) => {
    const contract = contractForDate(contracts, record.date)
    const durationMs = duration(record, now)
    const hourlyRate = contract?.hourlyRate
    return {
      id: record.id,
      date: record.date,
      day: new Intl.DateTimeFormat('cs-CZ', { weekday: 'short' })
        .format(new Date(`${record.date}T12:00:00`))
        .replace('.', ''),
      workplace: record.buildingName || 'Škola',
      start: new Intl.DateTimeFormat('cs-CZ', { hour: '2-digit', minute: '2-digit' }).format(new Date(record.start)),
      end: record.end
        ? new Intl.DateTimeFormat('cs-CZ', { hour: '2-digit', minute: '2-digit' }).format(new Date(record.end))
        : 'probíhá',
      durationMs,
      contractType: contract?.contractType,
      hourlyRate,
      grossEstimate: hourlyRate ? durationMs / HOUR_MS * hourlyRate : undefined,
    }
  })
  const totals = new Map<string, number>()
  const monthContracts = contracts.filter((contract) => contractOverlapsMonth(contract, month))
  const contractTypes = new Set([
    ...monthContracts.map((contract) => contract.contractType),
    ...rows.map((row) => row.contractType).filter(Boolean),
  ])
  const contractLabel = contractTypes.size > 1 ? 'Více pracovních vztahů' : contractTypes.has('dpc') ? 'DPČ' : contractTypes.has('other') ? 'Jiný pracovní vztah' : contractTypes.has('dpp') ? 'DPP' : 'Neuvedeno'
  rows.forEach((row) => totals.set(row.workplace, (totals.get(row.workplace) ?? 0) + row.durationMs))
  const segmentMap = new Map<string, AttendanceContractSegment>()
  rows.forEach((row) => {
    const contract = contractForDate(contracts, row.date)
    if (!contract) return
    const key = contract.id ?? `${contract.contractType}|${contract.validFrom}|${contract.validTo ?? ''}|${contract.hourlyRate ?? ''}`
    const existing = segmentMap.get(key) ?? {
      key,
      contractType: contract.contractType,
      validFrom: contract.validFrom,
      validTo: contract.validTo,
      hourlyRate: contract.hourlyRate,
      durationMs: 0,
      grossEstimate: contract.hourlyRate ? 0 : undefined,
    }
    existing.durationMs += row.durationMs
    if (existing.grossEstimate !== undefined && row.grossEstimate !== undefined) existing.grossEstimate += row.grossEstimate
    segmentMap.set(key, existing)
  })
  const contractSegments = [...segmentMap.values()].sort((a, b) => a.validFrom.localeCompare(b.validFrom))
  const missingContractMs = rows.filter((row) => !row.contractType).reduce((sum, row) => sum + row.durationMs, 0)
  const missingRateMs = rows.filter((row) => row.contractType && !row.hourlyRate).reduce((sum, row) => sum + row.durationMs, 0)
  const grossEstimate = missingContractMs || missingRateMs
    ? undefined
    : rows.reduce((sum, row) => sum + (row.grossEstimate ?? 0), 0)
  const dpcRows = rows.filter((row) => row.contractType === 'dpc')
  const dpcMonthMs = dpcRows.reduce((sum, row) => sum + row.durationMs, 0)
  const dpcGrossEstimate = dpcRows.some((row) => !row.hourlyRate)
    ? undefined
    : dpcRows.reduce((sum, row) => sum + (row.grossEstimate ?? 0), 0)
  const latestDpcRate = monthContracts
    .filter((contract) => contract.contractType === 'dpc' && contract.hourlyRate)
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0]?.hourlyRate
  const dpcThresholdReached = dpcGrossEstimate !== undefined && dpcGrossEstimate >= dpcMonthlyThreshold
  const dpcRemainingIncome = dpcGrossEstimate === undefined
    ? undefined
    : Math.max(0, dpcMonthlyThreshold - dpcGrossEstimate)
  const dpcRemainingMsAtCurrentRate = latestDpcRate && dpcRemainingIncome !== undefined
    ? dpcRemainingIncome / latestDpcRate * HOUR_MS
    : undefined
  const dpcRequiredMsAtCurrentRate = latestDpcRate
    ? dpcMonthlyThreshold / latestDpcRate * HOUR_MS
    : undefined
  const rates = [...new Set(monthContracts.map((contract) => contract.hourlyRate).filter((rate): rate is number => Boolean(rate)))]
  const hourlyRateLabel = rates.length === 1 ? `${reportMoney(rates[0])}/h` : rates.length > 1 ? 'Více historických sazeb' : 'Nenastavena'
  return {
    workerName,
    month,
    monthLabel: new Intl.DateTimeFormat('cs-CZ', { month: 'long', year: 'numeric' })
      .format(new Date(`${month}-01T12:00:00`)),
    workplaces: [...totals.keys()].sort((a, b) => a.localeCompare(b, 'cs')),
    rows,
    workplaceTotals: [...totals.entries()]
      .map(([name, durationMs]) => ({ name, durationMs }))
      .sort((a, b) => a.name.localeCompare(b.name, 'cs')),
    monthMs: rows.reduce((sum, row) => sum + row.durationMs, 0),
    yearMs: records
      .filter((record) => record.date.startsWith(year))
      .reduce((sum, record) => sum + duration(record, now), 0),
    dppYearMs: records
      .filter((record) => record.date.startsWith(year) && contractForDate(contracts, record.date)?.contractType === 'dpp')
      .reduce((sum, record) => sum + duration(record, now), 0),
    dppMonthMs: rows
      .filter((row) => row.contractType === 'dpp')
      .reduce((sum, row) => sum + row.durationMs, 0),
    annualLimitHours,
    contractLabel,
    hourlyRateLabel,
    contractSegments,
    grossEstimate,
    missingContractMs,
    missingRateMs,
    dpcMonthMs,
    dpcGrossEstimate,
    dpcMonthlyThreshold,
    dpcRemainingIncome,
    dpcRemainingMsAtCurrentRate,
    dpcRequiredMsAtCurrentRate,
    dpcThresholdReached,
    generatedAt: now,
  }
}

function drawPage(report: AttendanceReport, rows: AttendanceReportRow[], page: number, pages: number) {
  const canvas = document.createElement('canvas')
  canvas.width = 1240
  canvas.height = 1754
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Prohlížeč neumí vytvořit PDF.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#173d38'
  context.font = '700 28px Arial, sans-serif'
  context.fillText('KLID KOLY', 74, 78)
  context.font = '700 44px Arial, sans-serif'
  context.fillText('VÝKAZ DOCHÁZKY', 74, 137)
  context.font = '24px Arial, sans-serif'
  const workplaces = report.workplaces.length ? report.workplaces.join(', ') : '—'
  context.fillText(`Měsíc: ${report.monthLabel}`, 74, 195)
  context.fillText(`Pracovník: ${report.workerName}`, 74, 233)
  context.fillText(`Pracoviště: ${workplaces}`, 74, 271)
  context.fillText(`Typ: ${report.contractLabel}`, 74, 309)
  context.fillText(`Hodinová sazba: ${report.hourlyRateLabel}`, 620, 309)

  const columns = [74, 235, 325, 650, 805, 960]
  let y = 372
  context.fillStyle = '#eaf5f1'
  context.fillRect(64, y - 35, 1112, 52)
  context.fillStyle = '#173d38'
  context.font = '700 20px Arial, sans-serif'
  ;['Datum', 'Den', 'Pracoviště', 'Příchod', 'Odchod', 'Odpracováno'].forEach((label, index) =>
    context.fillText(label, columns[index], y),
  )
  context.font = '20px Arial, sans-serif'
  rows.forEach((row) => {
    y += 42
    context.strokeStyle = '#dbe8e4'
    context.beginPath()
    context.moveTo(64, y + 12)
    context.lineTo(1176, y + 12)
    context.stroke()
    const date = new Intl.DateTimeFormat('cs-CZ').format(new Date(`${row.date}T12:00:00`))
    ;[date, row.day, row.workplace, row.start, row.end, reportDuration(row.durationMs)].forEach((value, index) =>
      context.fillText(value, columns[index], y),
    )
  })

  if (page === pages - 1) {
    y += 74
    context.font = '700 24px Arial, sans-serif'
    context.fillText(`Celkem za měsíc: ${reportDuration(report.monthMs)}`, 74, y)
    context.font = '20px Arial, sans-serif'
    report.workplaceTotals.forEach((total) => {
      y += 34
      context.fillText(`${total.name}: ${reportDuration(total.durationMs)}`, 94, y)
    })
    y += 46
    context.font = '700 24px Arial, sans-serif'
    context.fillText(`Celkem za rok: ${reportDuration(report.yearMs)}`, 74, y)
    y += 38
    if (report.grossEstimate !== undefined) {
      context.fillText(`Odhad hrubé odměny: ${reportMoney(report.grossEstimate)}`, 74, y)
      y += 38
    } else if (report.rows.length) {
      context.fillText('Odměnu nelze dopočítat: chybí pracovní vztah nebo sazba.', 74, y)
      y += 38
    }
    if (report.contractLabel === 'DPP') {
      context.fillText(`DPP: ${reportDuration(report.dppYearMs)} / ${report.annualLimitHours} h`, 74, y)
    }
    if (report.contractLabel === 'DPČ') {
      context.fillText(`Rozhodný příjem podle nastavení: ${reportMoney(report.dpcMonthlyThreshold)}`, 74, y)
      y += 38
      if (report.dpcThresholdReached) context.fillText('Nastavená hranice dosažena podle evidované docházky.', 74, y)
      else if (report.dpcRemainingIncome !== undefined) context.fillText(`Do nastavené hranice zbývá: ${reportMoney(report.dpcRemainingIncome)}`, 74, y)
    }
  }
  context.fillStyle = '#617772'
  context.font = '18px Arial, sans-serif'
  context.fillText(
    `Vygenerováno z evidence docházky Klid Koly · ${new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' }).format(report.generatedAt)}`,
    74,
    1685,
  )
  if (pages > 1) context.fillText(`Strana ${page + 1} / ${pages}`, 1040, 1685)
  return canvas
}

function base64Bytes(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function pdfFromJpegs(images: { bytes: Uint8Array; width: number; height: number }[]) {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = [0]
  let length = 0
  const append = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    chunks.push(bytes)
    length += bytes.length
  }
  append('%PDF-1.4\n%KlidKoly\n')
  const addObject = (number: number, body: (appendChunk: typeof append) => void) => {
    offsets[number] = length
    append(`${number} 0 obj\n`)
    body(append)
    append('\nendobj\n')
  }
  const pageObjects = images.map((_, index) => 3 + index * 3)
  addObject(1, (write) => write('<< /Type /Catalog /Pages 2 0 R >>'))
  addObject(2, (write) => write(`<< /Type /Pages /Count ${images.length} /Kids [${pageObjects.map((id) => `${id} 0 R`).join(' ')}] >>`))
  images.forEach((image, index) => {
    const pageId = pageObjects[index]
    const contentId = pageId + 1
    const imageId = pageId + 2
    const imageName = `Im${index + 1}`
    addObject(pageId, (write) => write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /${imageName} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`))
    const content = `q 595 0 0 842 0 0 cm /${imageName} Do Q`
    addObject(contentId, (write) => write(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`))
    addObject(imageId, (write) => {
      write(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`)
      write(image.bytes)
      write('\nendstream')
    })
  })
  const xrefOffset = length
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`)
  for (let index = 1; index < offsets.length; index += 1) {
    append(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`)
  }
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`)
  const result = new Uint8Array(length)
  let position = 0
  chunks.forEach((chunk) => {
    result.set(chunk, position)
    position += chunk.length
  })
  return result
}

export function downloadAttendanceReportPdf(report: AttendanceReport) {
  const rowsPerPage = 22
  const pages = Math.max(1, Math.ceil(report.rows.length / rowsPerPage))
  const images = Array.from({ length: pages }, (_, page) => {
    const rows = report.rows.slice(page * rowsPerPage, (page + 1) * rowsPerPage)
    const canvas = drawPage(report, rows, page, pages)
    const data = canvas.toDataURL('image/jpeg', 0.92).split(',')[1]
    return { bytes: base64Bytes(data), width: canvas.width, height: canvas.height }
  })
  const blob = new Blob([pdfFromJpegs(images)], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `vykaz-dochazky-${report.month}-${report.workerName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const annualHours = (report: AttendanceReport) => report.yearMs / HOUR_MS
