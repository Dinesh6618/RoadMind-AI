import { fmtDuration } from './routeFormat'

/**
 * Turns a /routes/calculate result (plus the live road events in view) into the engine-independent overlays MapCanvas draws.
 * Pure functions - nothing here touches React or a map engine.
 */

export const ROUTE_BLUE = '#2563eb'
export const ROUTE_BLUE_INK = '#1d4ed8'
export const ROUTE_GREY = '#8791b5'
export const ROUTE_GREY_INK = '#4a5580'
export const ROUTE_RED = '#d92d20'
export const ROUTE_RED_INK = '#a3191a'
export const TRAFFIC_COLORS = { NORMAL: '#17a673', SLOW: '#f5a524', TRAFFIC_JAM: '#d92d20' }
const EVENT_AMBER = '#f5a524'
const EVENT_ORANGE = '#f7762c'
const START_INK = '#0f1a3c'
const DEST_BRAND = '#5b3df5'

/** 'rec' | 'alt' | 'avoid'. The recommended route stays blue even in the (rare) case that every route is blocked. */
export function routeKind(r) {
  if (r.status === 'RECOMMENDED' || r.recommendation === 'Recommended') return 'rec'
  if (r.blocked || r.status === 'AVOID' || r.recommendation === 'Avoid') return 'avoid'
  return 'alt'
}

export const KIND = {
  rec: { color: ROUTE_BLUE, ink: ROUTE_BLUE_INK, weight: 10, dashed: false, word: 'Recommended', pill: 'RECOMMENDED' },
  alt: { color: ROUTE_GREY, ink: ROUTE_GREY_INK, weight: 6, dashed: false, word: 'Alternative', pill: 'ALTERNATIVE' },
  avoid: { color: ROUTE_RED, ink: ROUTE_RED_INK, weight: 6, dashed: true, word: 'Avoid', pill: 'AVOID' },
}

const EVENT_EMOJI = { ROAD_BLOCKED: '🚧', ROAD_CLOSED: '⛔', TEMPORARY_CLOSURE: '⛔', CONSTRUCTION: '🚧', ACCIDENT: '⚠️', FLOODED: '🌊', SEVERE_DAMAGE: '🕳️' }
const firstToken = (s) => String(s || '').split(' ')[0]

export function eventEmoji(ev) {
  return ev.emoji || EVENT_EMOJI[ev.event_type] || (firstToken(ev.headline).match(/^\p{Extended_Pictographic}/u) ? firstToken(ev.headline) : '⚠️')
}

/** "[lat,lng]" that lies `f` (0..1) of the way along the path (by length, so uneven Google polylines still get a central label). */
export function pointAlong(path, f = 0.5) {
  if (!path?.length) return null
  if (path.length === 1) return path[0]
  const k = Math.cos((path[0][0] * Math.PI) / 180)
  const seg = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], (path[i][1] - path[i - 1][1]) * k)
    seg.push(d)
    total += d
  }
  let want = total * f
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, want / seg[i]) : 0
      return [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t]
    }
    want -= seg[i]
  }
  return path[0]
}

/** [[south, west], [north, east]] of the given routes (+ the two end points), or null when there is nothing to fit. */
export function boundsOf(routes, ...extra) {
  const pts = []
  for (const r of routes) for (const p of r.geometry || []) pts.push(p)
  for (const e of extra) if (e && Number.isFinite(e.lat) && Number.isFinite(e.lng)) pts.push([e.lat, e.lng])
  if (!pts.length) return null
  let s = 90, w = 180, n = -90, e = -180
  for (const [la, ln] of pts) { if (la < s) s = la; if (la > n) n = la; if (ln < w) w = ln; if (ln > e) e = ln }
  return [[s, w], [n, e]]
}

const routeTip = (r) => {
  const kind = KIND[routeKind(r)]
  const risk = r.risk == null ? 'risk n/a' : `risk ${Math.round(r.risk)}/100`
  return `${r.label} · ${kind.word}${r.blocked ? ' · blocked' : ''} · ${fmtDuration(r.duration_min)} · ${risk}`
}

/** One list of road events to draw: those found on the routes + those the live feed reports in view (the feed wins on details). */
export function collectEvents(routes, live) {
  const byId = new Map()
  const put = (ev, extra) => {
    if (!ev || ev.id == null || !Number.isFinite(ev.lat) || !Number.isFinite(ev.lng)) return
    const old = byId.get(ev.id)
    byId.set(ev.id, { ...(old || {}), ...ev, ...extra, blocking: !!(extra.blocking || old?.blocking) })
  }
  for (const r of routes) {
    for (const ev of r.blocked_by || []) put(ev, { blocking: true, verified: ev.verified !== false })
    for (const ev of r.events || []) put(ev, { blocking: false, verified: ev.verified !== false })
    for (const ev of r.unverified_events || []) put(ev, { blocking: false, verified: false })
  }
  for (const ev of live || []) put(ev, { blocking: !!ev.is_blocking, verified: !!ev.verified })
  return [...byId.values()]
}

export function eventTip(ev) {
  const status = ev.verified ? 'Verified by authorised staff' : 'Unverified community report'
  const age = ev.age_minutes == null ? '' : ` · reported ${ev.age_minutes < 1 ? 'just now' : ev.age_minutes < 60 ? `${ev.age_minutes} min ago` : `${Math.floor(ev.age_minutes / 60)} h ago`}`
  return `${ev.headline || 'Road event'}${ev.road_name ? ` · ${ev.road_name}` : ''} · ${status}${age}`
}

/**
 * Everything MapCanvas should draw. `picking` strips the click handlers so a click on the map always lands on the map
 * (pick-on-the-map), never on a route.
 */
export function buildOverlays({ routes, active, origin, destination, events, avoid, picking, onSelect }) {
  const out = []
  const click = (label) => (picking ? undefined : () => onSelect(label))
  const FRACTIONS = [0.5, 0.33, 0.67, 0.2, 0.8] // so the labels of routes that share a road do not sit on top of each other

  routes.forEach((r, i) => {
    const kind = routeKind(r)
    const st = KIND[kind]
    const on = r.label === active
    const weight = st.weight + (on ? 3 : 0)
    if (Array.isArray(r.geometry) && r.geometry.length > 1) {
      out.push({ type: 'line', id: `route-${r.label}`, path: r.geometry, color: st.color, weight, opacity: 1, dashed: st.dashed, z: on ? 5 : kind === 'rec' ? 4 : 2, onClick: click(r.label), tip: routeTip(r) })
    }
    // Real traffic colours (from the provider) only for the highlighted route, as a narrower line on top of its base line.
    if (on && !st.dashed) {
      ;(r.traffic_segments || []).forEach((s, j) => {
        const color = TRAFFIC_COLORS[s.speed]
        if (color && Array.isArray(s.path) && s.path.length > 1) {
          out.push({ type: 'line', id: `traffic-${r.label}-${j}`, path: s.path, color, weight: Math.max(4, Math.round(weight * 0.5)), opacity: 1, outline: false, z: 6, onClick: click(r.label) })
        }
      })
    }
    const at = pointAlong(r.geometry, FRACTIONS[i % FRACTIONS.length])
    if (at) {
      out.push({ type: 'marker', id: `label-${r.label}`, position: { lat: at[0], lng: at[1] }, text: r.label.replace('Route ', ''), color: st.color, size: on ? 34 : 30, z: 7, onClick: click(r.label), tip: routeTip(r) })
    }
  })

  for (const ev of events) {
    const verified = !!ev.verified
    const color = !verified ? EVENT_AMBER : ev.blocking ? ROUTE_RED : EVENT_ORANGE
    out.push({
      type: 'marker', id: `event-${ev.id}`, position: { lat: ev.lat, lng: ev.lng }, color, size: verified && ev.blocking ? 38 : 32, z: 8,
      ...(verified ? { emoji: eventEmoji(ev) } : { text: '?' }), tip: eventTip(ev),
    })
  }

  // The place the user came from on the map page ("plan a route around this event"): a pin, nothing else changes.
  if (avoid) out.push({ type: 'marker', id: 'avoid-point', position: { lat: avoid.lat, lng: avoid.lng }, emoji: avoid.emoji || '🚧', color: ROUTE_RED, size: 40, z: 10, tip: `Planning around: ${avoid.name || 'the reported blockage'}` })

  if (origin) out.push({ type: 'marker', id: 'origin', position: { lat: origin.lat, lng: origin.lng }, text: '●', color: START_INK, size: 26, z: 9, tip: `Start: ${origin.name || 'your start point'}` })
  if (destination) out.push({ type: 'marker', id: 'destination', position: { lat: destination.lat, lng: destination.lng }, emoji: '🏁', color: DEST_BRAND, size: 38, z: 9, tip: `Destination: ${destination.name || 'your destination'}` })
  return out
}
