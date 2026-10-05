import { OFF_ROUTE_M } from './emergencyFormat'

/**
 * Where is a position on a route? Pure geometry for live navigation: no map, no React, no network.
 * Distances are metres on a local flat projection (fine for the few kilometres of an emergency trip).
 */

const M_LAT = 110540
const M_LNG = 111320
const R = 6371000

function haversine(a, b) {
  const rad = Math.PI / 180
  const dLat = (b[0] - a[0]) * rad
  const dLng = (b[1] - a[1]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** { pts, cum, total }: the polyline with the distance along it (m) at every vertex. null when there is no usable line. */
export function buildIndex(geometry) {
  const pts = (geometry || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
  if (pts.length < 2) return null
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]))
  return { pts, cum, total: cum[cum.length - 1] }
}

/** Nearest point of the line to (lat, lng), looking only at the stretch between `from` and `to` metres along it. */
export function snapToRoute(idx, lat, lng, from = 0, to = Infinity) {
  const { pts, cum } = idx
  const kx = M_LNG * Math.cos((lat * Math.PI) / 180)
  let best = null
  for (let i = 0; i < pts.length - 1; i++) {
    if (cum[i + 1] < from || cum[i] > to) continue
    const ax = (pts[i][1] - lng) * kx, ay = (pts[i][0] - lat) * M_LAT
    const bx = (pts[i + 1][1] - lng) * kx, by = (pts[i + 1][0] - lat) * M_LAT
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
    const d = Math.hypot(ax + t * dx, ay + t * dy)
    if (!best || d < best.dist) best = { dist: d, offset: cum[i] + t * (cum[i + 1] - cum[i]) }
  }
  return best
}

/** Metres along the route at which each step starts (kept in order, so a step never starts before the one before it). */
export function stepOffsets(idx, steps) {
  let last = 0
  return (steps || []).map((s) => {
    const at = s?.start && Number.isFinite(s.start.lat) && Number.isFinite(s.start.lng) ? snapToRoute(idx, s.start.lat, s.start.lng) : null
    last = Math.max(last, at ? at.offset : last)
    return last
  })
}

/**
 * Progress of a GPS fix on the route. `prev` is the offset of the previous fix (a fix is first looked for just around it, so a
 * route that doubles back on itself is not mistaken for progress). Returns
 * { offset, dist, off, remaining_m, fraction, stepIndex, next, next_m }.
 */
export function progressAt(idx, offs, steps, fix, prev = 0) {
  const near = snapToRoute(idx, fix.lat, fix.lng, Math.max(0, prev - 200), prev + 3000)
  const any = near && near.dist <= OFF_ROUTE_M ? near : snapToRoute(idx, fix.lat, fix.lng)
  const snap = any && (!near || any.dist < near.dist - 30) ? any : near || any
  const offset = snap.offset
  const remaining = Math.max(0, idx.total - offset)
  let stepIndex = 0
  for (let i = 0; i < offs.length; i++) if (offs[i] <= offset + 15) stepIndex = i
  const next = steps && stepIndex + 1 < steps.length ? steps[stepIndex + 1] : null
  return {
    offset, dist: snap.dist, off: snap.dist > OFF_ROUTE_M, remaining_m: remaining, fraction: idx.total ? Math.min(1, offset / idx.total) : 0,
    stepIndex, next, next_m: next ? Math.max(0, offs[stepIndex + 1] - offset) : remaining,
  }
}
