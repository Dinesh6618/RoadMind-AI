// The five states of a road segment. UNKNOWN = RoadMind has no recent data (not "good", not "damaged").
// Colours mirror the CSS tokens (--good, --moderate, --high, --critical, --nodata) - see docs/DESIGN_SYSTEM.md.
export const STATE_COLORS = { GOOD: '#17a673', MODERATE: '#f2b01e', HIGH_RISK: '#f7762c', CRITICAL: '#e0342f', UNKNOWN: '#94a3b8' }
// Darker shades of the same hues, used for TEXT on tinted backgrounds so contrast stays accessible.
export const STATE_INK = { GOOD: '#0b6e4b', MODERATE: '#8a5a00', HIGH_RISK: '#a8470b', CRITICAL: '#a3191a', UNKNOWN: '#475569' }
export const CONDITION_LABELS = { GOOD: 'Good', MODERATE: 'Moderate', HIGH_RISK: 'High Risk', CRITICAL: 'Critical', UNKNOWN: 'No Data' }
export const STATE_ORDER = ['CRITICAL', 'HIGH_RISK', 'MODERATE', 'GOOD', 'UNKNOWN']
export const STATE_MEANING = {
  GOOD: 'Recent RoadMind data indicates low damage',
  MODERATE: 'Some damage detected',
  HIGH_RISK: 'Significant damage or deterioration risk',
  CRITICAL: 'Severe damage requiring attention',
  UNKNOWN: 'No RoadMind condition data - not good, not damaged',
}
export const HIGHWAY_LABELS = {
  motorway: 'Motorway', trunk: 'Trunk road', primary: 'Primary road', secondary: 'Secondary road', tertiary: 'Tertiary road',
  unclassified: 'Minor road', residential: 'Residential street', living_street: 'Living street', service: 'Service road', road: 'Road',
}
export const highwayLabel = (h = '') => HIGHWAY_LABELS[h.replace('_link', '')] || 'Road'
export const MAJOR_ROADS = ['motorway', 'trunk', 'primary', 'secondary']

// Severity levels (0-100 score bands) share the state palette.
export const LEVEL_COLORS = { Critical: STATE_COLORS.CRITICAL, High: STATE_COLORS.HIGH_RISK, Moderate: STATE_COLORS.MODERATE, Low: STATE_COLORS.GOOD }
export const LEVEL_INK = { Critical: STATE_INK.CRITICAL, High: STATE_INK.HIGH_RISK, Moderate: STATE_INK.MODERATE, Low: STATE_INK.GOOD }
export const LEVEL_ORDER = ['Critical', 'High', 'Moderate', 'Low']
export const LEVEL_TO_STATE = { Critical: 'CRITICAL', High: 'HIGH_RISK', Moderate: 'MODERATE', Low: 'GOOD' }
export const RISK_COLORS = { HIGH: STATE_COLORS.CRITICAL, MEDIUM: STATE_COLORS.MODERATE, LOW: STATE_COLORS.GOOD }
export const RISK_INK = { HIGH: STATE_INK.CRITICAL, MEDIUM: STATE_INK.MODERATE, LOW: STATE_INK.GOOD }

// Maintenance priority: the API says "High Priority"; the interface says "High".
export const PRIORITY_COLORS = { Immediate: STATE_COLORS.CRITICAL, 'High Priority': STATE_COLORS.HIGH_RISK, 'Medium Priority': STATE_COLORS.MODERATE, Monitor: '#6d78a8' }
export const PRIORITY_INK = { Immediate: STATE_INK.CRITICAL, 'High Priority': STATE_INK.HIGH_RISK, 'Medium Priority': STATE_INK.MODERATE, Monitor: '#4a5580' }
export const PRIORITY_SHORT = { Immediate: 'Immediate', 'High Priority': 'High', 'Medium Priority': 'Medium', Monitor: 'Monitor' }

// Route lines on the map: red = avoid (high risk), green = recommended, orange = alternative. They are drawn thick with a
// white casing and a label chip, and the condition layer under them is dimmed, so a route is never mistaken for a road state.
export const ROUTE_LINE = { Recommended: '#0fa968', Alternative: '#f7762c', Avoid: '#e0342f' }
export const ROUTE_INK = { Recommended: '#0b6e4b', Alternative: '#a8470b', Avoid: '#a3191a' }
export const ROUTE_COLORS = ROUTE_LINE
export const STATUS_LABELS = { pending: 'Pending', inspected: 'Inspected', repair_planned: 'Repair planned', repair_completed: 'Repair completed' }

export function fmtDate(iso, withTime = false) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return withTime
    ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
}

export function timeAgo(iso) {
  if (!iso) return 'no reports yet'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days} days ago`
  return `${Math.round(days / 30)} months ago`
}

export const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
export const num = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }))
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?'

export function sortRows(rows, key, dir) {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key]
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    if (typeof x === 'string') return sign * x.localeCompare(y)
    return sign * (x - y)
  })
}
