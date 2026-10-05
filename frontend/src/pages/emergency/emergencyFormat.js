import { distToPath } from '../roadmap/geo'
import { agoText, fmtDuration, fmtKm, minutesSince, parseUtc, reopeningText } from '../routes/routeFormat'

/** Wording, small formatters and geometry helpers of Emergency Route Mode. No React in here. */

export { fmtDuration, fmtKm, parseUtc, reopeningText }

export const KINDS = {
  hospital: { label: 'Hospital', emoji: '🏥', plural: 'hospitals', hint: 'Nearest emergency care' },
  fire_station: { label: 'Fire Station', emoji: '🚒', plural: 'fire stations', hint: 'Fire and rescue' },
  police: { label: 'Police Station', emoji: '🚓', plural: 'police stations', hint: 'Police help' },
  custom: { label: 'Custom Location', emoji: '📍', plural: 'places', hint: 'Search or pick on the map' },
}
export const KIND_ORDER = ['hospital', 'fire_station', 'police', 'custom']
export const NEARBY_KINDS = new Set(['hospital', 'fire_station', 'police'])

export const TEXT = {
  title: '🚨 Emergency Route',
  hero: 'Reach help faster with smarter routes.',
  subtitle: 'Find the fastest available route while avoiding verified road closures and high-risk road conditions.',
  gpsDenied: 'Location access is required to calculate an emergency route from your current position.',
  gpsFailed: 'Unable to access your current location.',
  routeFailed: 'Unable to calculate the route right now.',
  dataUnavailable: 'RoadMind road-condition data is temporarily unavailable.',
  monitorFailed: "Couldn't check for route changes - will try again.",
  advice: 'RoadMind recommends routes from currently available data; follow the instructions of the emergency services.',
  noTurns: 'Turn-by-turn directions need Google Maps.',
}

export const MIN_GAIN_MIN = 3 // a refreshed route is only offered as a switch when it is at least this many minutes quicker (or the current one is closed)
export const OFF_ROUTE_M = 80 // further than this from the planned route = "You are off the planned route"

// ---------------------------------------------------------------------------------------------- time and distance
/** "just now" / "42 s ago" / "3 min ago" for a millisecond timestamp. */
export function agoMs(t, now = Date.now()) {
  if (!t) return null
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.floor(m / 60)} h ago`
}

/** "just now" / "3 min ago" for a server ISO time (zone-less strings mean UTC). */
export function agoIso(iso, now = Date.now()) {
  const t = parseUtc(iso)
  return t == null ? null : agoMs(t, now)
}

/** "10:12 AM" - the device clock, as the person sees it. */
export const clockText = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** metres -> "350 m" / "1.2 km" (rounded the way a navigation voice would). */
export function fmtMeters(m) {
  if (m == null || !Number.isFinite(m)) return '—'
  if (m < 1000) return `${m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50} m`
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`
}

/** Short minutes for a map badge: "13 min", "1h05". */
export function shortMin(min) {
  if (min == null || !Number.isFinite(Number(min))) return '?'
  const n = Math.max(1, Math.round(Number(min)))
  return n < 100 ? `${n} min` : `${Math.floor(n / 60)}h${String(n % 60).padStart(2, '0')}`
}

const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±')
/** "+1.4 km, +3 min" - how `a` differs from `b`, from the two routes' own numbers. */
export function deltaText(a, b) {
  if (!a || !b || a.distance_km == null || b.distance_km == null || a.duration_min == null || b.duration_min == null) return null
  const km = Math.round((a.distance_km - b.distance_km) * 10) / 10
  const min = Math.round(a.duration_min - b.duration_min)
  return `${sign(km)}${Math.abs(km).toFixed(1)} km, ${sign(min)}${Math.abs(min)} min`
}

/** An "alternative route" offer: how `route` differs from `current` (numbers from the two routes themselves) and why. */
export function makeOffer(route, current, extra = {}) {
  const dKm = route && current && route.distance_km != null && current.distance_km != null ? Math.round((route.distance_km - current.distance_km) * 10) / 10 : null
  const dMin = route && current && route.duration_min != null && current.duration_min != null ? Math.round(route.duration_min - current.duration_min) : null
  return {
    route, dKm, dMin, deltaText: deltaText(route, current), reason: route?.reason, blocked: false,
    lowerRisk: route?.risk != null && current?.risk != null && route.risk < current.risk, ...extra,
  }
}

/** The offer that comes with a blocked-road alert of an answer (the alert's own numbers), or null when there is no alternative. */
export function offerFromAlert(res) {
  const alert = res?.alert
  const alt = alert?.alternative
  if (!alt) return null
  const routes = res.routes || []
  const route = routes.find((r) => r.label === alt.label)
  if (!route) return null
  const closed = routes.find((r) => r.label === alert.blocked_route) || null
  return makeOffer(route, closed, {
    blocked: true, dKm: alt.extra_km ?? null, dMin: alt.extra_min ?? null, deltaText: alt.delta_text || null, reason: alt.reason || route.reason,
    lowerRisk: route.risk != null && closed?.risk != null ? route.risk < closed.risk : alt.risk != null && closed?.risk != null && alt.risk < closed.risk,
  })
}

/** "+1.4" / "−0.5" km and "+3" / "−2" min for the offer tiles. */
export const signedKm = (v) => (v == null ? '—' : `${sign(v)}${Math.abs(v).toFixed(1)} km`)
export const signedMin = (v) => (v == null ? '—' : `${sign(v)}${Math.abs(v)} min`)

// ---------------------------------------------------------------------------------------------------- errors
/** The message for a failed route calculation: always starts with the owner's sentence, except 422 (the server explains why). */
export function routeError(err) {
  const msg = String(err?.message || '').trim()
  if (err?.status === 422 && msg) return msg
  if (!msg) return TEXT.routeFailed
  if (msg.startsWith(TEXT.routeFailed)) return msg
  return `${TEXT.routeFailed} ${msg}`
}

// ----------------------------------------------------------------------------------------------- route helpers
/** The polyline thinned to every `every`-th point (and its last point), as route-status wants it (2..6000 points). */
export function thinPath(geometry, every = 5) {
  const g = Array.isArray(geometry) ? geometry : []
  if (g.length <= 2) return g
  const step = Math.max(every, Math.ceil(g.length / 5000))
  const out = []
  for (let i = 0; i < g.length; i += step) out.push(g[i])
  if (out[out.length - 1] !== g[g.length - 1]) out.push(g[g.length - 1])
  return out
}

/** Ids of every road event the route was found to meet (closures, other verified events, unverified reports). */
export function routeEventIds(route) {
  const ids = new Set()
  for (const list of [route?.blocked_by, route?.events, route?.unverified_events]) for (const e of list || []) if (e?.id != null) ids.add(e.id)
  return [...ids].slice(0, 200)
}

/** Which route of a fresh answer is the one the person is following? Compares sample points of the old line with each new line. */
export function matchRoute(path, routes) {
  if (!Array.isArray(path) || path.length < 2 || !routes?.length) return null
  const n = Math.min(15, path.length)
  const sample = Array.from({ length: n }, (_, i) => path[Math.round((i * (path.length - 1)) / Math.max(1, n - 1))])
  let best = null
  for (const r of routes) {
    if (!Array.isArray(r.geometry) || r.geometry.length < 2) continue
    let near = 0, sum = 0
    for (const p of sample) {
      const d = distToPath(p[0], p[1], r.geometry)
      sum += d
      if (d <= 40) near += 1
    }
    const score = near / n
    if (score >= 0.85 && (!best || score > best.score || (score === best.score && sum < best.sum))) best = { route: r, score, sum }
  }
  return best?.route || null
}

/** Google Maps directions link with up to 8 evenly spaced waypoints taken from the route's own line. */
export function googleMapsUrl(origin, destination, geometry, maxWaypoints = 8) {
  const g = Array.isArray(geometry) ? geometry : []
  const waypoints = []
  if (g.length > 2) {
    const k = Math.min(maxWaypoints, g.length - 2)
    for (let i = 1; i <= k; i++) {
      const p = g[Math.round((i * (g.length - 1)) / (k + 1))]
      waypoints.push(`${p[0].toFixed(6)},${p[1].toFixed(6)}`)
    }
  }
  const o = origin || (g.length ? { lat: g[0][0], lng: g[0][1] } : null)
  let url = `https://www.google.com/maps/dir/?api=1&origin=${o.lat.toFixed(6)},${o.lng.toFixed(6)}&destination=${destination.lat.toFixed(6)},${destination.lng.toFixed(6)}&travelmode=driving`
  if (waypoints.length) url += `&waypoints=${waypoints.join('|')}`
  return url
}

// ------------------------------------------------------------------------------------------ what a route says
export const trafficText = (r) => (!r?.traffic_available || !r.traffic_level || r.traffic_level === 'Unknown' ? 'Traffic unavailable' : r.traffic_level)
export const trafficShort = (r) => (!r?.traffic_available || !r.traffic_level || r.traffic_level === 'Unknown' ? 'Unavailable' : r.traffic_level)
export const riskText = (r) => (r?.risk == null ? 'n/a' : `${Math.round(r.risk)}/100`)
export const isUnavailable = (r) => !!r && (r.status === 'UNAVAILABLE' || r.available === false)

/** The status chips of a route: [{ key, text, tone }]. Tones: good | warn | bad | amber | info | neutral. */
export function routeChips(r) {
  if (isUnavailable(r)) return [{ key: 'blocked', text: '🚧 BLOCKED', tone: 'bad' }, { key: 'unavail', text: '❌ UNAVAILABLE', tone: 'bad' }]
  const flags = new Set(r.flags || [])
  const out = [{ key: 'open', text: '🟢 OPEN', tone: 'good' }]
  if (r.status === 'RECOMMENDED') out.push({ key: 'rec', text: '✅ RECOMMENDED', tone: 'info' })
  else if (!flags.has('HIGH_ROAD_RISK')) out.push({ key: 'alt', text: 'Alternative', tone: 'neutral' })
  if (flags.has('HIGH_ROAD_RISK')) out.push({ key: 'risk', text: '⚠️ HIGH ROAD RISK', tone: 'warn' })
  if (flags.has('HEAVY_TRAFFIC')) out.push({ key: 'traffic', text: '⚠️ HEAVY TRAFFIC', tone: 'warn' })
  if (flags.has('FLOODING_REPORTED')) out.push({ key: 'flood', text: '🌊 FLOODING REPORTED', tone: 'warn' })
  if (flags.has('UNVERIFIED_REPORT')) out.push({ key: 'unv', text: '❓ UNVERIFIED REPORT', tone: 'amber' })
  return out
}

/** The "High-risk segments" of a route: distinct road names with the worst level, from `severe_roads`. [] when RoadMind reports none. */
export function highRiskSegments(r) {
  const seen = new Map()
  for (const s of r?.severe_roads || []) {
    const name = s.name || 'Unnamed road'
    const old = seen.get(name)
    if (!old || (s.severity ?? 0) > (old.severity ?? 0)) seen.set(name, { name, level: s.severity_level, severity: s.severity })
  }
  return [...seen.values()]
}

/** "reported 12 min ago" for an event of a route answer (age_minutes was measured when the answer was made). */
function reportedAgo(ev, generatedAt, now) {
  if (ev.age_minutes == null) return null
  return agoText(ev.age_minutes + (minutesSince(generatedAt, now) ?? 0))
}

/** One sentence per closure: "verified road closure on Anna Salai, reported 12 min ago, expected to reopen ~6:00 PM". */
export function closureSentences(r, generatedAt, now = Date.now()) {
  return (r?.blocked_by || []).map((ev) => {
    const parts = [`${ev.verified === false ? 'road blockage' : 'verified road closure'} on ${ev.road_name || 'a reported road'}`]
    const ago = reportedAgo(ev, generatedAt, now)
    if (ago) parts.push(`reported ${ago}`)
    const reopen = reopeningText(ev.expected_reopening_at)
    if (reopen) parts.push(`expected to reopen ${reopen}`)
    return parts.join(', ')
  })
}

/** Routes in display order: recommended first, then the open alternatives, then the unavailable ones (answer order inside a group). */
export function sortRoutes(routes) {
  const rank = (r) => (isUnavailable(r) ? 2 : r.status === 'RECOMMENDED' ? 0 : 1)
  return (routes || []).map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([r]) => r)
}

/** Bounds [[s, w], [n, e]] around routes' lines and a few extra points. */
export function boundsFor(routes, ...pts) {
  let s = 90, w = 180, n = -90, e = -180, any = false
  const add = (la, ln) => { if (Number.isFinite(la) && Number.isFinite(ln)) { any = true; if (la < s) s = la; if (la > n) n = la; if (ln < w) w = ln; if (ln > e) e = ln } }
  for (const r of routes || []) for (const p of r.geometry || []) add(p[0], p[1])
  for (const p of pts) if (p) add(p.lat, p.lng)
  return any ? [[s, w], [n, e]] : null
}
