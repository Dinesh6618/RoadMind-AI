import { useEffect, useState } from 'react'
import { timeAgo } from '../format'
import './maps.css'

/**
 * A small floating status panel for a map page, honest about what is loaded:
 *   Base map / Live traffic  come from MapCanvas's onStatus,
 *   RoadMind data / Blocked roads / Last update  come from the page's own RoadMind request.
 * An empty RoadMind result is a normal state ("No data for this area"), never an error and never "0 roads loaded".
 *
 * Props: status = { engine, ready, googleConfigured, googleError, trafficLayer } (or null before the first onStatus),
 *        roadmind = { state: 'loading'|'ok'|'error', count, blocked, updatedAt: ISO|null } (omit it to hide the RoadMind lines),
 *        className (extra classes, e.g. to place it elsewhere).
 */

/** "just now", "2 min ago", "3 h ago", then the day-based wording of format.js. */
export function ago(iso, now = Date.now()) {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const s = Math.max(0, (now - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return timeAgo(iso)
}

function baseMap(status) {
  if (!status || !status.ready) return { text: 'loading…' }
  if (status.engine === 'google') return { text: 'Google road network', ok: '✓ Loaded' }
  return { text: status.googleConfigured || status.googleError ? 'OpenStreetMap (Google Maps failed to load)' : 'OpenStreetMap (Google Maps not configured)' }
}

function liveTraffic(status) {
  // Only claim traffic when Google is really showing it.
  if (status && status.engine === 'google' && status.ready && status.trafficLayer) return { ok: '✓ Google traffic layer on' }
  if (status && status.engine === 'google' && status.ready) return { text: 'off' }
  return { text: 'unavailable' }
}

function roadmindData(rm) {
  if (rm.state === 'error') return 'temporarily unavailable'
  if (rm.state !== 'ok') return 'loading…'
  const n = Number(rm.count) || 0
  return n > 0 ? `${n.toLocaleString()} ${n === 1 ? 'road' : 'roads'}` : 'No data for this area'
}

function Line({ label, children }) {
  return <div className="rm-map-status__line"><span className="rm-map-status__k">{label}</span> {children}</div>
}

export default function MapStatusBar({ status, roadmind, className = '' }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { // keeps "2 min ago" correct while the page sits open
    if (!roadmind?.updatedAt) return undefined
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [roadmind?.updatedAt])

  const base = baseMap(status)
  const traffic = liveTraffic(status)
  const updated = roadmind?.updatedAt ? ago(roadmind.updatedAt, now) : null

  return (
    <div className={`rm-map-status glass ${className}`.trim()} role="status" aria-live="polite">
      <Line label="Base map:">
        {base.text}{base.text && base.ok ? ' ' : ''}{base.ok && <b className="rm-map-status__ok">{base.ok}</b>}
      </Line>
      <Line label="Live traffic:">
        {traffic.ok ? <b className="rm-map-status__ok">{traffic.ok}</b> : traffic.text}
      </Line>
      {roadmind && <Line label="RoadMind data:">{roadmindData(roadmind)}</Line>}
      {roadmind?.state === 'ok' && <Line label="Blocked roads:">{Number(roadmind.blocked) || 0}</Line>}
      {updated && <Line label="Last RoadMind update:">{updated}</Line>}
    </div>
  )
}
