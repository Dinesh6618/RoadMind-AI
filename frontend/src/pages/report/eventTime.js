// Time helpers for road events. The API sends ISO timestamps in UTC; one without a zone suffix is treated as UTC too, so
// "5 min ago" is right in every time zone. (format.js only counts days, which is too coarse for an event that lasts hours.)

export function parseIso(iso) {
  if (!iso) return null
  const s = String(iso)
  const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`

/** "just now", "12 min ago", "3 h ago", "2 days ago", then the date. */
export function ago(iso, now = Date.now()) {
  const d = parseIso(iso)
  if (!d) return null
  const s = Math.max(0, (now - d.getTime()) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 7 * 86400) return `${plural(Math.round(s / 86400), 'day')} ago`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "in 20 min", "in 5 h 10 min", "in 2 days" - or "now" when it is already past. */
export function inFuture(iso, now = Date.now()) {
  const d = parseIso(iso)
  if (!d) return null
  const mins = Math.round((d.getTime() - now) / 60000)
  if (mins <= 0) return 'now'
  if (mins < 60) return `in ${mins} min`
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60), m = mins % 60
    return m ? `in ${h} h ${m} min` : `in ${h} h`
  }
  const days = Math.floor(mins / 1440), h = Math.round((mins % 1440) / 60)
  return h ? `in ${plural(days, 'day')} ${h} h` : `in ${plural(days, 'day')}`
}

/** "5 Oct, 9:40 pm" */
export function fmtWhen(iso) {
  const d = parseIso(iso)
  return d ? d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '-'
}

export const isPast = (iso, now = Date.now()) => { const d = parseIso(iso); return !!d && d.getTime() <= now }
