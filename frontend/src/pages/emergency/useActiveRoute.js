import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { MIN_GAIN_MIN, isUnavailable, makeOffer, matchRoute, offerFromAlert, parseUtc, routeEventIds, thinPath } from './emergencyFormat'
import { useVisibleLoop } from './useVisibleLoop'

/**
 * The active emergency route: what the person is following, the monitoring of it and everything that can happen to it.
 *
 *   start(route, result)    begin following `route` (a route of `result`)
 *   end()                   stop following (and stop every timer / request)
 *   switchToOffer()              switch to the offered alternative (the person pressed [Use Alternative] / [Switch Route])
 *   keepCurrent()           dismiss a route-update offer and stay on the current route
 *   recalcFrom(origin)      the person left the route: plan again from `origin` (their real position)
 *
 * Monitoring (only while a route is active, only while the tab is visible, never touching GPS):
 *   every recheck.status_interval_s    POST /emergency/route-status (database only)
 *   every recheck.reroute_interval_s   POST /emergency/route, ONLY when the answer had live traffic
 * BLOCKED  -> a red alert at once, then ONE recalculation with the current route -> an alternative is OFFERED (never switched silently).
 * CHANGED  -> a calm notice and ONE recalculation; offered only when a different route is now recommended.
 * Failed checks back off (see useVisibleLoop) and show one calm line until a check works again.
 */
export function useActiveRoute({ request, setSelected }) {
  const [active, setActive] = useState(null) // { id, route, origin, destination, startedAt }
  const [blocked, setBlocked] = useState(null) // { events, message, title }
  const [offer, setOffer] = useState(null) // { route, deltaText, reason, lowerRisk, blocked }
  const [notice, setNotice] = useState(null) // { title, text }
  const [finding, setFinding] = useState(false)
  const [lastChecked, setLastChecked] = useState(null)
  const [refreshedAt, setRefreshedAt] = useState(null)
  const [routeStatus, setRouteStatus] = useState(null) // { status, message } from the last route-status answer
  const [checkFailed, setCheckFailed] = useState(false)
  const [intervals, setIntervals] = useState({ status: 60, reroute: 180, traffic: false })

  const activeRef = useRef(null)
  activeRef.current = active
  const known = useRef([]) // event ids on the route as of the last planning / status answer
  const handled = useRef(new Set()) // closure ids already alerted about
  const seq = useRef(0)
  const statusCtl = useRef(null)

  const resetFlags = useCallback(() => {
    setBlocked(null); setOffer(null); setNotice(null); setFinding(false); setCheckFailed(false)
    handled.current = new Set()
  }, [])

  const begin = useCallback((route, res, origin, destination) => {
    known.current = routeEventIds(route)
    resetFlags()
    setActive({ id: `${Date.now()}-${route.label}`, route, origin, destination, startedAt: Date.now() })
    setLastChecked(Date.now())
    setRefreshedAt(parseUtc(res?.generated_at) || Date.now())
    setRouteStatus(null)
    setSelected(route.label)
  }, [resetFlags, setSelected])

  const start = useCallback((route, res) => {
    setIntervals({ status: Number(res.recheck?.status_interval_s) || 60, reroute: Number(res.recheck?.reroute_interval_s) || 180, traffic: !!res.traffic?.available })
    begin(route, res, res.origin, res.destination)
  }, [begin])

  const end = useCallback(() => {
    seq.current += 1
    statusCtl.current?.abort()
    setActive(null); setRouteStatus(null); setLastChecked(null)
    resetFlags()
  }, [resetFlags])

  useEffect(() => () => { statusCtl.current?.abort() }, [])

  // -------------------------------------------------------------------------------------- a fresh answer arrives
  const apply = useCallback((res, reason, snap) => {
    const routes = res.routes || []
    const matched = matchRoute(snap.route.geometry, routes)
    const rec = routes.find((r) => r.label === res.recommended) || null
    const alert = res.alert || null
    const matchedOpen = matched && !isUnavailable(matched)
    setRefreshedAt(parseUtc(res.generated_at) || Date.now())

    if (alert || (matched && !matchedOpen)) { // the route being followed is closed
      const closedRoute = routes.find((r) => r.label === alert?.blocked_route) || matched || snap.route
      let next = offerFromAlert(res)
      if (!next && !alert && rec) next = makeOffer(rec, closedRoute, { blocked: true })
      const alt = next?.route || null
      setBlocked({ events: alert?.blocked_by || matched?.blocked_by || [], message: alert?.message || 'A verified road closure was detected on your current route.', title: alert?.title, headline: alert?.headline, detail: alert?.detail })
      setOffer(next)
      setNotice(null)
      setSelected(alt ? alt.label : null)
      return
    }
    setBlocked(null)
    if (matchedOpen) {
      setActive((a) => (a && a.id === snap.id ? { ...a, route: matched, origin: res.origin || a.origin, destination: res.destination || a.destination } : a))
      const better = rec && rec.label !== matched.label && (reason === 'changed' || matched.duration_min - rec.duration_min >= MIN_GAIN_MIN)
      if (better) { setOffer(makeOffer(rec, matched)); setSelected(rec.label) } else { setOffer(null); setSelected(matched.label) }
    } else if (rec) { // the old line is no longer one of the answer's routes
      setOffer(makeOffer(rec, snap.route)); setSelected(rec.label)
    } else { setOffer(null); setSelected(null) }
  }, [setSelected])

  /** One recalculation of the route being followed. Resolves true when an answer arrived. */
  const recalc = useCallback(async (reason) => {
    const snap = activeRef.current
    if (!snap) return false
    const mine = ++seq.current
    if (reason !== 'refresh') setFinding(true)
    const current = { distance_km: snap.route.distance_km, duration_min: snap.route.duration_min, label: String(snap.route.label || '').slice(0, 32) }
    let res = null
    try { res = await request({ origin: snap.origin, destination: snap.destination, kind: snap.destination.kind, current, keep: true }) } finally {
      if (seq.current === mine) setFinding(false)
    }
    if (!res || activeRef.current?.id !== snap.id || seq.current !== mine) return !!res
    apply(res, reason, snap)
    return true
  }, [request, apply])

  // ------------------------------------------------------------------------------------------- route-status check
  const handleStatus = useCallback(async (res) => {
    setRouteStatus({ status: res.status, message: res.message })
    if (res.status === 'BLOCKED') {
      const events = res.blocking_events || []
      known.current = res.event_ids || known.current
      if (!events.some((e) => !handled.current.has(e.id))) return
      events.forEach((e) => handled.current.add(e.id))
      setBlocked({ events, message: res.message })
      setOffer(null); setNotice(null)
      await recalc('blocked')
    } else if (res.status === 'CHANGED') {
      known.current = res.event_ids || known.current
      setNotice({ title: '⚠️ Route Update', text: res.message })
      await recalc('changed')
    }
  }, [recalc])

  const check = useCallback(async () => {
    const snap = activeRef.current
    if (!snap) return true
    statusCtl.current?.abort()
    const c = new AbortController()
    statusCtl.current = c
    try {
      const res = await api('/emergency/route-status', { method: 'POST', signal: c.signal, json: { geometry: thinPath(snap.route.geometry), known_event_ids: known.current.slice(0, 200) } })
      if (activeRef.current?.id !== snap.id) return true
      setLastChecked(Date.now()); setCheckFailed(false)
      await handleStatus(res)
      return true
    } catch (err) {
      if (err?.name === 'AbortError') return true
      setCheckFailed(true)
      return false
    }
  }, [handleStatus])

  const refresh = useCallback(() => recalc('refresh'), [recalc])

  const monitoring = !!active
  const resetKey = active?.id
  useVisibleLoop(check, intervals.status * 1000, monitoring, resetKey)
  useVisibleLoop(refresh, intervals.reroute * 1000, monitoring && intervals.traffic, resetKey)

  // ----------------------------------------------------------------------------------------------- the person decides
  const switchToOffer = useCallback(() => {
    const o = offer
    const snap = activeRef.current
    if (!o || !snap) return
    begin(o.route, null, snap.origin, snap.destination)
    setRefreshedAt(Date.now())
  }, [offer, begin])

  const keepCurrent = useCallback(() => {
    setOffer(null)
    if (activeRef.current) setSelected(activeRef.current.route.label)
  }, [setSelected])

  const recalcFrom = useCallback(async (origin) => {
    const snap = activeRef.current
    if (!snap) return false
    const mine = ++seq.current
    setFinding(true)
    let res = null
    try { res = await request({ origin: { lat: origin.lat, lng: origin.lng, name: 'My location' }, destination: snap.destination, kind: snap.destination.kind, keep: true }) } finally {
      if (seq.current === mine) setFinding(false)
    }
    if (!res || activeRef.current?.id !== snap.id || seq.current !== mine) return !!res
    const rec = (res.routes || []).find((r) => r.label === res.recommended)
    if (rec) {
      begin(rec, res, res.origin, res.destination)
      setNotice({ title: '🧭 Route recalculated', text: 'RoadMind planned a new route from your current position.' })
    } else {
      setBlocked({ events: res.alert?.blocked_by || [], message: res.alert?.message || 'No unblocked route was found from your position.', title: res.alert?.title, headline: res.alert?.headline, detail: res.alert?.detail })
      setOffer(null); setSelected(null)
    }
    return true
  }, [request, begin, setSelected])

  return {
    active, blocked, offer, notice, finding, lastChecked, refreshedAt, routeStatus, checkFailed, intervals,
    start, end, switchToOffer, keepCurrent, recalcFrom, retry: () => recalc(blocked ? 'blocked' : 'changed'), dismissNotice: () => setNotice(null),
  }
}
