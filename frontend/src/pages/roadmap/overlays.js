import { CONDITION_LABELS, STATE_COLORS, fmtDate } from '../../format'
import { ago } from '../../maps/MapStatusBar'

/**
 * RoadMind data -> MapCanvas overlays. Everything RoadMind draws is an overlay on the real-world base map:
 *   road condition   thick, white-cased line in the state colour (z 2) - deliberately unlike Google's thin traffic colours
 *   road event       red = blocking (verified), orange = verified non-blocking, amber + dashed + "?" = unverified report
 */

export const BLOCKED_RED = '#d92d20'
export const EVENT_ORANGE = '#f7762c'
export const PENDING_AMBER = '#f2b01e'
export const BRAND = '#5b3df5'

/** 'blocking' | 'verified' | 'pending' - how an event is shown and worded. */
export const eventKind = (ev) => (ev.is_blocking ? 'blocking' : ev.verified ? 'verified' : 'pending')
export const eventColor = (ev) => ({ blocking: BLOCKED_RED, verified: EVENT_ORANGE, pending: PENDING_AMBER })[eventKind(ev)]

/** "Verified: YES - authorised staff" / "NO - unverified community report". */
export const verifiedText = (ev) => (ev.verified ? 'YES - authorised staff' : 'NO - unverified community report')

/** Reported "12 min ago" / "3 h ago" / "2 days ago" (minutes matter for an event, days do not). */
export const reportedAgo = (ev) => ago(ev.created_at) || 'just now'

/** "until about 5 Oct 2026, 6:30 pm" - the expected reopening is an estimate, never a promise. */
export function reopeningText(ev) {
  const when = ev.expected_reopening_at || ev.expires_at
  if (!when) return null
  return `until about ${fmtDate(when, true)}`
}

export const eventStatusText = (ev) => (ev.verified || ev.is_blocking ? ev.headline : `Unverified report - ${ev.event_type_label || ev.headline}`)

export function conditionOverlays(items, focus, onClick) {
  const out = []
  for (const it of items) {
    if (focus && it.state !== focus) continue
    if (!Array.isArray(it.geometry) || it.geometry.length < 2) continue
    out.push({
      type: 'line', id: `road-${it.id}`, path: it.geometry, color: STATE_COLORS[it.state] || '#94a3b8', weight: 7, opacity: 0.95, outline: true, z: 2,
      tip: `${it.name || 'Road'} - ${CONDITION_LABELS[it.state] || it.state_label || 'Condition'}`,
      onClick: (at) => onClick(it, at),
    })
  }
  return out
}

/** A soft halo under the selected road's own line. Not clickable: clicks fall through to the road line above it. */
export function highlightOverlay(item) {
  if (!item || !Array.isArray(item.geometry) || item.geometry.length < 2) return null
  return { type: 'line', id: 'selected-road', path: item.geometry, color: BRAND, weight: 15, opacity: 0.42, outline: false, z: 1 }
}

export function eventOverlays(events, selectedId, onClick) {
  const out = []
  for (const e of events) {
    const kind = eventKind(e)
    const color = eventColor(e)
    const pending = kind === 'pending'
    const tip = kind === 'blocking'
      ? `${e.headline} - ${e.road_name || 'Reported location'}`
      : pending ? `Unverified report: ${e.event_type_label}${e.road_name ? ` - ${e.road_name}` : ''}` : `${e.emoji} ${e.event_type_label} (verified)${e.road_name ? ` - ${e.road_name}` : ''}`
    const click = (at) => onClick(e, at)
    if (Array.isArray(e.geometry) && e.geometry.length >= 2) {
      out.push({ type: 'line', id: `event-${e.id}`, path: e.geometry, color, weight: 8, opacity: 0.95, dashed: pending, outline: true, z: 4, tip, onClick: click })
    } else if (e.radius_m > 0) {
      out.push({ type: 'circle', id: `event-${e.id}`, center: { lat: e.lat, lng: e.lng }, radius_m: e.radius_m, color, fillOpacity: pending ? 0.1 : 0.2, z: 0, tip, onClick: click })
    }
    out.push({
      type: 'marker', id: `event-${e.id}`, position: { lat: e.lat, lng: e.lng }, color, size: e.id === selectedId ? 44 : kind === 'blocking' ? 38 : 34, z: 6,
      ...(pending ? { text: '?' } : { emoji: e.emoji }), tip, onClick: click,
    })
  }
  return out
}

/** The small dot that marks the spot the person clicked (or searched for). Not clickable. */
export const pinOverlay = (id, at, emoji) => ({ type: 'marker', id, position: { lat: at.lat, lng: at.lng }, color: BRAND, size: emoji ? 30 : 18, z: 5, ...(emoji ? { emoji } : {}) })
