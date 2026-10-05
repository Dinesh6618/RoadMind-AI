/** Small geometry helpers for the map page (no map engine involved). Distances are metres on a local flat projection. */

const M_PER_DEG_LAT = 110540
const M_PER_DEG_LNG = 111320

/** Distance in metres from the point (lat, lng) to the polyline `path` ([[lat, lng], ...]). Infinity for an empty path. */
export function distToPath(lat, lng, path) {
  if (!Array.isArray(path) || path.length === 0) return Infinity
  const kx = M_PER_DEG_LNG * Math.cos((lat * Math.PI) / 180)
  const toXY = (p) => [(p[1] - lng) * kx, (p[0] - lat) * M_PER_DEG_LAT]
  let best = Infinity
  let prev = toXY(path[0])
  best = Math.min(best, Math.hypot(prev[0], prev[1]))
  for (let i = 1; i < path.length; i++) {
    const cur = toXY(path[i])
    const dx = cur[0] - prev[0], dy = cur[1] - prev[1]
    const len2 = dx * dx + dy * dy
    // projection of the origin (the point) on the segment prev->cur, clamped to the segment
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(prev[0] * dx + prev[1] * dy) / len2))
    best = Math.min(best, Math.hypot(prev[0] + t * dx, prev[1] + t * dy))
    prev = cur
  }
  return best
}

/** Distance in metres between two { lat, lng } points. */
export function distM(a, b) {
  const kx = M_PER_DEG_LNG * Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot((b.lng - a.lng) * kx, (b.lat - a.lat) * M_PER_DEG_LAT)
}

const hasLine = (ev) => Array.isArray(ev.geometry) && ev.geometry.length >= 2

/** Active events a click at `at` falls on: within radius_m + `extra` metres of the event's point, or within `extra` of its line. */
export function eventsNear(events, at, extra = 30) {
  const hits = events.filter((ev) => {
    if (hasLine(ev) && distToPath(at.lat, at.lng, ev.geometry) <= extra) return true
    return distM(at, { lat: ev.lat, lng: ev.lng }) <= (ev.radius_m || 0) + extra
  })
  return sortEvents(hits)
}

/** Does this event concern this road? Same road id, or the event lies on / next to the road's line. */
export function eventAppliesToRoad(ev, road, extra = 30) {
  if (ev.road_id != null && road.id != null && ev.road_id === road.id) return true
  const path = road.geometry
  if (!Array.isArray(path) || path.length < 2) return false
  if (distToPath(ev.lat, ev.lng, path) <= (ev.radius_m || 0) + extra) return true
  return hasLine(ev) && ev.geometry.some((p) => distToPath(p[0], p[1], path) <= extra)
}

/** Blocking events first, then verified ones, then unverified; newest first inside each group. */
export function sortEvents(list) {
  const rank = (e) => (e.is_blocking ? 0 : e.verified ? 1 : 2)
  return [...list].sort((a, b) => rank(a) - rank(b) || String(b.created_at).localeCompare(String(a.created_at)))
}

/** The viewport grown by `frac` on every side (so panning a little never shows an unfilled edge), clamped to the globe. */
export function padViewport(vp, frac = 0.2) {
  const dLat = (vp.north - vp.south) * frac
  const dLng = (vp.east - vp.west) * frac
  return {
    south: Math.max(-90, vp.south - dLat), north: Math.min(90, vp.north + dLat),
    west: Math.max(-180, vp.west - dLng), east: Math.min(180, vp.east + dLng),
  }
}

export const inBounds = (p, b) => !!b && p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east

export const bboxParams = (b) => `south=${b.south.toFixed(6)}&west=${b.west.toFixed(6)}&north=${b.north.toFixed(6)}&east=${b.east.toFixed(6)}`
