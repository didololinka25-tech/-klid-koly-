function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole
    const hexadecimal = entity[1]?.toLowerCase() === 'x'
    const point = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
    return Number.isFinite(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
  })
}

export function sanitizeCalendarText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = decodeHtmlEntities(value)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!cleaned) return undefined
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}
