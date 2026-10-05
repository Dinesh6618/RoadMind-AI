import { CONDITION_LABELS, STATE_COLORS } from '../../format'
import { eventOverlays } from '../roadmap/overlays'
import { ROUTE_BLUE, ROUTE_GREY, ROUTE_RED, TRAFFIC_COLORS, eventEmoji } from '../routes/routeScene'
import { KINDS, fmtDuration, fmtMeters, isUnavailable } from './emergencyFormat'

/**
 * Emergency state -> the engine-independent overlays MapCanvas draws. Pure functions; the real-world map is always underneath.
 *
 *   routes          BLUE thick (selected / recommended) with a white casing, GREY (other open routes), RED DASHED (unavailable),
 *                   each with a small round time badge on its line; the selected route's traffic segments as a narrower inner line
 *   events          verified closure red, other verified orange, unverified amber dashed "?"  (from /emergency/events + the routes' own)
 *   conditions      RoadMind road-condition lines (green / yellow / orange / red), thinner and lower than the routes
 *   places          the nearby hospitals / stations as emoji markers
 *   you             a blue dot with the real GPS accuracy circle
 */

export const COLORS = { blue: ROUTE_BLUE, grey: ROUTE_GREY, red: ROUTE_RED, navy: '#0f1a3c', violet: '#5b3df5', you: '#2563eb' }

/** 'rec' | 'alt' | 'bad' - how a route is drawn and worded. `selected` wins over the server's status. */
export function drawKind(r, selected) {
  if (isUnavailable(r)) return 'bad'
  if (r.label === selected) return 'rec'
  return 'alt'
}

export const WORD = { rec: 'Recommended', alt: 'Alternative', bad: 'Blocked' }

export function routeLabelText(r, kind) {
  const word = kind === 'rec' && r.status !== 'RECOMMENDED' ? 'Selected' : WORD[kind]
  return `${word} - ${fmtDuration(r.duration_min)}`
}

function routeOverlays({ routes, selected, hideLabel, oldPath, picking, onSelect }) {
  const out = []
  routes.forEach((r) => {
    if (r.label === hideLabel) return
    if (!Array.isArray(r.geometry) || r.geometry.length < 2) return
    const kind = drawKind(r, selected)
    const bad = kind === 'bad'
    const on = kind === 'rec'
    const color = bad ? ROUTE_RED : on ? ROUTE_BLUE : ROUTE_GREY
    const weight = on ? 11 : 6
    const canPick = !bad && !picking
    const tip = picking ? undefined : routeLabelText(r, kind)
    out.push({ type: 'line', id: `route-${r.label}`, path: r.geometry, color, weight, opacity: 1, dashed: bad, outline: true, z: on ? 7 : 5, onClick: canPick ? () => onSelect(r.label) : undefined, tip })
    if (on) {
      ;(r.traffic_segments || []).forEach((s, j) => {
        const c = TRAFFIC_COLORS[s.speed]
        if (c && Array.isArray(s.path) && s.path.length > 1) out.push({ type: 'line', id: `traffic-${r.label}-${j}`, path: s.path, color: c, weight: 5, opacity: 1, outline: false, z: 8 })
      })
    }
  })
  if (oldPath && oldPath.length > 1) out.push({ type: 'line', id: 'route-old', path: oldPath, color: ROUTE_GREY, weight: 7, opacity: 1, dashed: true, outline: true, z: 6, tip: picking ? undefined : 'Current route' })
  return out
}

/** Events to draw: the live feed (wins on details) + the events found on the routes (so a closure is always drawn). */
export function mergeEvents(live, routes) {
  const byId = new Map()
  for (const ev of live || []) if (ev?.id != null && Number.isFinite(ev.lat) && Number.isFinite(ev.lng)) byId.set(ev.id, ev)
  const add = (ev, blocking, verified) => {
    if (!ev || ev.id == null || byId.has(ev.id) || !Number.isFinite(ev.lat) || !Number.isFinite(ev.lng)) return
    byId.set(ev.id, { ...ev, is_blocking: blocking, verified, emoji: eventEmoji(ev), event_type_label: ev.headline || 'Road event', radius_m: 0, geometry: null })
  }
  for (const r of routes || []) {
    for (const ev of r.blocked_by || []) add(ev, true, ev.verified !== false)
    for (const ev of r.events || []) add(ev, false, ev.verified !== false)
    for (const ev of r.unverified_events || []) add(ev, false, false)
  }
  return [...byId.values()]
}

function conditionLines(items, picking) {
  const out = []
  for (const it of items || []) {
    if (!Array.isArray(it.geometry) || it.geometry.length < 2) continue
    out.push({
      type: 'line', id: `road-${it.id}`, path: it.geometry, color: STATE_COLORS[it.state] || STATE_COLORS.UNKNOWN, weight: 5, opacity: 0.9, outline: true, z: 1,
      tip: picking ? undefined : `${it.name || 'Road'} - ${CONDITION_LABELS[it.state] || it.state_label || 'Condition'}`,
    })
  }
  return out
}

function placeMarkers(nearby, kind, highlight, onTap) {
  const meta = KINDS[kind]
  return (nearby || []).map((p, i) => ({
    type: 'marker', id: `place-${i}`, position: { lat: p.lat, lng: p.lng }, emoji: meta?.emoji || '📍', color: i === highlight ? ROUTE_BLUE : COLORS.navy, size: i === highlight ? 46 : 36, z: 8,
    onClick: () => onTap(i), tip: `${p.name}${p.distance_km != null ? ` · ${fmtMeters((p.route_distance_km ?? p.distance_km) * 1000)}` : ''}`,
  }))
}

export function buildScene({ routes, selected, hideLabel, oldPath, picking, onSelect, start, fix, dest, kind, places, highlight, onPlaceTap, events, conditions, onEventTap }) {
  const out = []
  out.push(...conditionLines(conditions, picking))
  const evs = mergeEvents(events, routes)
  out.push(...eventOverlays(evs, null, picking ? () => {} : (e) => onEventTap?.(e)).map((o) => (picking ? { ...o, onClick: undefined } : o)))
  out.push(...routeOverlays({ routes: routes || [], selected, hideLabel, oldPath, picking, onSelect }))
  if (places?.length && !dest) out.push(...placeMarkers(places, kind, highlight, onPlaceTap))

  const me = fix || start
  if (me) {
    if (me.accuracy > 0 && (fix || start.source === 'gps')) out.push({ type: 'circle', id: 'em-accuracy', center: { lat: me.lat, lng: me.lng }, radius_m: Math.min(me.accuracy, 1500), color: COLORS.you, fillOpacity: 0.1, z: 0 })
    out.push({ type: 'marker', id: 'em-you', position: { lat: me.lat, lng: me.lng }, color: COLORS.you, size: 24, z: 10, tip: picking ? undefined : fix ? 'Your position' : `Start: ${start.name || 'your start point'}` })
  }
  if (dest) out.push({ type: 'marker', id: 'em-dest', position: { lat: dest.lat, lng: dest.lng }, emoji: KINDS[dest.kind || kind]?.emoji || '📍', color: COLORS.violet, size: 44, z: 11, tip: picking ? undefined : `Destination: ${dest.name || 'your destination'}` })
  return out
}

