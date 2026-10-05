import { useEffect, useState } from 'react'
import { STATE_COLORS, STATE_INK } from '../../format'

/** Small text helpers for the route planner (no React components here, so they are easy to reason about). */

/** Server timestamps are UTC. One that arrives without a zone ("2026-10-05T12:00:00") must not be read as local time. */
export function parseUtc(iso) {
  if (!iso) return null
  const s = String(iso)
  const t = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`).getTime()
  return Number.isNaN(t) ? null : t
}

/** Whole minutes between an ISO time and `now` (never negative). null when the time is missing / invalid. */
export function minutesSince(iso, now = Date.now()) {
  const t = parseUtc(iso)
  return t == null ? null : Math.max(0, Math.floor((now - t) / 60000))
}

/** 0 -> "just now", 5 -> "5 min ago", 130 -> "2 h ago", 3000 -> "2 days ago". */
export function agoText(minutes) {
  if (minutes == null) return null
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`
  const d = Math.floor(minutes / 1440)
  return `${d} ${d === 1 ? 'day' : 'days'} ago`
}

/** 8.7 -> "9 min", 75 -> "1 h 15 min". */
export function fmtDuration(min) {
  if (min == null || !Number.isFinite(Number(min))) return 'n/a'
  const n = Math.max(1, Math.round(Number(min)))
  if (n < 60) return `${n} min`
  const m = n % 60
  return `${Math.floor(n / 60)} h${m ? ` ${m} min` : ''}`
}

export const fmtKm = (km) => (km == null ? 'n/a' : `${Number(km).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })} km`)

/** "~5:40 PM" (today) or "~6 Oct, 5:40 PM" - or null when the server did not give a usable time. */
export function reopeningText(iso) {
  const t = parseUtc(iso)
  if (t == null) return null
  const d = new Date(t)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const today = new Date()
  const same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return `~${same ? '' : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, `}${time}`
}

/** The message the user sees for a failed calculation. 503 / 422 / network failure are worded exactly as the brief asks. */
export function routeError(err) {
  const msg = err?.message || 'Unable to calculate routes right now.'
  let message = msg
  if (err?.status === 503 && err?.code !== 'server_unreachable' && !/^Unable to calculate routes right now\./.test(msg)) {
    message = `Unable to calculate routes right now. ${msg}`.trim()
  }
  return { message, info: err?.info }
}

/** Re-renders every `ms` while `enabled` (keeps "updated 3 min ago" honest). Returns Date.now(). */
export function useNow(ms = 30000, enabled = true) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return undefined
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms, enabled])
  return now
}

// ---- colour / label vocabularies (shared by the cards, the table and the map) ----
export const TRAFFIC_LEVEL = {
  Normal: { color: STATE_COLORS.GOOD, ink: STATE_INK.GOOD, label: 'Normal' },
  Moderate: { color: STATE_COLORS.MODERATE, ink: STATE_INK.MODERATE, label: 'Moderate' },
  Heavy: { color: STATE_COLORS.HIGH_RISK, ink: STATE_INK.HIGH_RISK, label: 'Heavy' },
  'Traffic jam': { color: STATE_COLORS.CRITICAL, ink: STATE_INK.CRITICAL, label: 'Traffic jam' },
  Unknown: { color: STATE_COLORS.UNKNOWN, ink: STATE_INK.UNKNOWN, label: 'Traffic unavailable' },
}
export const trafficInfo = (level) => TRAFFIC_LEVEL[level] || TRAFFIC_LEVEL.Unknown

export const DAMAGE_LEVEL = {
  Low: { color: STATE_COLORS.GOOD, ink: STATE_INK.GOOD },
  Moderate: { color: STATE_COLORS.MODERATE, ink: STATE_INK.MODERATE },
  High: { color: STATE_COLORS.HIGH_RISK, ink: STATE_INK.HIGH_RISK },
  Severe: { color: STATE_COLORS.CRITICAL, ink: STATE_INK.CRITICAL },
  Unknown: { color: STATE_COLORS.UNKNOWN, ink: STATE_INK.UNKNOWN },
}
export const damageInfo = (level) => DAMAGE_LEVEL[level] || DAMAGE_LEVEL.Unknown

/** A 0-100 score on the app's severity bands (30 / 60 / 80). Lower is better. */
export function scoreColors(score) {
  if (score == null) return { color: STATE_COLORS.UNKNOWN, ink: STATE_INK.UNKNOWN }
  if (score < 30) return { color: STATE_COLORS.GOOD, ink: STATE_INK.GOOD }
  if (score < 60) return { color: STATE_COLORS.MODERATE, ink: STATE_INK.MODERATE }
  if (score < 80) return { color: STATE_COLORS.HIGH_RISK, ink: STATE_INK.HIGH_RISK }
  return { color: STATE_COLORS.CRITICAL, ink: STATE_INK.CRITICAL }
}

/** The four parts of the RoadMind Route Risk Score, in the order the server lists its weights. */
export const RISK_PARTS = [
  { key: 'traffic', field: 'traffic_risk', label: 'Traffic', about: 'How slow the route is right now compared with free-flowing traffic (live traffic from Google Maps).' },
  { key: 'road_damage', field: 'road_damage_risk', label: 'Road damage', about: 'Current road condition from user reports and AI detections.' },
  { key: 'predicted_damage', field: 'predicted_damage_risk', label: 'Predicted damage', about: "RoadMind's forecast of how the road condition will develop." },
  { key: 'blockage', field: 'blockage_risk', label: 'Blockage', about: 'Verified road blockages, closures and works on the route. An unverified community report only nudges the score.' },
]
