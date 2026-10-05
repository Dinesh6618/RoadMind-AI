import { api } from '../../api'
import { bboxParams } from './geo'

/**
 * The full map record (the same shape as an item of /road-conditions) of one RoadMind road, when only its id is known
 * (a /network/match answer, or a deep link). Order: the items already on the map, a tiny /road-conditions query around
 * the point, then /roads/{id}. Resolves null when the road has no RoadMind data. Rejects with AbortError when aborted.
 */
export async function resolveRoadItem(id, near, known, signal) {
  const roadId = Number(id)
  const have = known.find((i) => i.id === roadId)
  if (have) return have

  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {
    const d = 0.0009 // ~100 m: the road passes through `near`, so its bounding box overlaps this one
    const box = { south: near.lat - d, north: near.lat + d, west: near.lng - d, east: near.lng + d }
    try {
      const r = await api(`/road-conditions?${bboxParams(box)}&limit=60`, { signal })
      const hit = (r?.items || []).find((i) => i.id === roadId)
      if (hit) return hit
    } catch (err) {
      if (err?.name === 'AbortError') throw err // anything else: fall through to the detail record
    }
  }

  const d = await api(`/roads/${roadId}`, { signal })
  if (!d || d.has_data === false || d.state === 'UNKNOWN') return null
  return {
    ...d, id: roadId, road_id: roadId, severity: d.current_severity, risk_percent: d.risk_percent,
    lat: near?.lat ?? null, lng: near?.lng ?? null, geometry: null, ai_confidence: null, pothole_count: null, crack_count: null,
  }
}
