import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { bboxParams, padViewport } from '../roadmap/geo'
import { NEARBY_KINDS, routeError } from './emergencyFormat'

/** Data hooks of Emergency Route Mode: nearby places, the route request, and the map's road events / road conditions. */

const isAbort = (err) => err?.name === 'AbortError'

// ------------------------------------------------------------------------------------------------ nearby places
/**
 * GET /emergency/nearby for the chosen kind around the start point. Nothing is requested without a start point (the page shows a
 * friendly prompt instead). `state`: 'idle' | 'loading' | 'ok' | 'error'.
 */
export function useNearby(kind, start) {
  const [st, setSt] = useState({ state: 'idle', data: null, error: null })
  const [nonce, setNonce] = useState(0)
  const lat = start ? Number(start.lat.toFixed(3)) : null // ~100 m: GPS jitter does not trigger a new search
  const lng = start ? Number(start.lng.toFixed(3)) : null

  useEffect(() => {
    if (!NEARBY_KINDS.has(kind) || lat == null) { setSt({ state: 'idle', data: null, error: null }); return undefined }
    const ctl = new AbortController()
    setSt((s) => ({ state: 'loading', data: s.data && s.data.kind === kind ? s.data : null, error: null }))
    api(`/emergency/nearby?kind=${kind}&lat=${lat}&lng=${lng}&limit=8`, { signal: ctl.signal })
      .then((data) => setSt({ state: 'ok', data, error: null }))
      .catch((err) => { if (!isAbort(err)) setSt({ state: 'error', data: null, error: err?.status === 0 ? 'The RoadMind server is not answering right now.' : err?.message || 'Unable to find nearby places right now.' }) })
    return () => ctl.abort()
  }, [kind, lat, lng, nonce])

  return { ...st, reload: useCallback(() => setNonce((n) => n + 1), []) }
}

// ----------------------------------------------------------------------------------------------- route request
/**
 * POST /emergency/route. `request()` resolves with the answer (or null on failure / when a newer request replaced it).
 *   keep: leave the previous answer on screen when this request fails (background refreshes while a route is active).
 * `busy` is 'route' (a first calculation) or 'alt' (a recalculation with a `current` route: "Finding an alternative route...").
 */
export function useEmergencyRoute() {
  const [st, setSt] = useState({ result: null, busy: null, error: null })
  const reqId = useRef(0)
  const ctl = useRef(null)

  const request = useCallback(async ({ origin, destination, kind, current = null, keep = false }) => {
    ctl.current?.abort()
    const c = new AbortController()
    ctl.current = c
    const id = ++reqId.current
    setSt((s) => ({ ...s, busy: current ? 'alt' : 'route', error: null }))
    const json = {
      origin: { lat: origin.lat, lng: origin.lng, name: origin.name || '' },
      destination: { lat: destination.lat, lng: destination.lng, name: destination.name || '' },
      ...(kind ? { destination_kind: kind } : {}),
      ...(current ? { current } : {}),
    }
    try {
      const res = await api('/emergency/route', { method: 'POST', json, signal: c.signal })
      if (id !== reqId.current) return null
      setSt({ result: res, busy: null, error: null })
      return res
    } catch (err) {
      if (isAbort(err) || id !== reqId.current) return null
      setSt((s) => ({ result: keep ? s.result : null, busy: null, error: routeError(err) }))
      return null
    }
  }, [])

  const clear = useCallback(() => { ctl.current?.abort(); reqId.current += 1; setSt({ result: null, busy: null, error: null }) }, [])
  useEffect(() => () => ctl.current?.abort(), [])

  return { ...st, request, clear }
}

// -------------------------------------------------------------------------------------- road events + conditions
/**
 * The two RoadMind overlays of the map for the visible area: live road events (GET /emergency/events) and road conditions
 * (GET /road-conditions). The base map never waits for them. `failed` is true while either request is failing.
 * `onViewport(vp)` is for MapCanvas.onViewportChange: it only fetches when the view left the area already loaded (or the data is
 * older than the refresh period); every `refresh_seconds` the current view is refreshed while the tab is visible.
 */
export function useMapData() {
  const [data, setData] = useState({ events: [], conditions: [], evFailed: false, condFailed: false, refreshSeconds: 60 })
  const view = useRef(null)
  const loaded = useRef(null) // { bounds, at }
  const inflight = useRef({ ev: null, cond: null })
  const refreshMs = useRef(60000)

  const load = useCallback((vp) => {
    if (!vp) return
    view.current = vp
    inflight.current.ev?.abort()
    inflight.current.cond?.abort()
    const bounds = padViewport(vp, 0.25)
    const q = bboxParams(bounds)
    const c1 = new AbortController()
    const c2 = new AbortController()
    inflight.current = { ev: c1, cond: c2 }
    loaded.current = { bounds, at: Date.now() }

    api(`/emergency/events?${q}`, { signal: c1.signal })
      .then((d) => {
        const secs = Math.min(300, Math.max(20, Number(d?.refresh_seconds) || 60))
        refreshMs.current = secs * 1000
        setData((s) => ({ ...s, events: Array.isArray(d?.items) ? d.items : [], refreshSeconds: secs, evFailed: false }))
      })
      .catch((err) => { if (!isAbort(err)) { loaded.current = null; setData((s) => ({ ...s, evFailed: true })) } })
    api(`/road-conditions?${q}&limit=2000`, { signal: c2.signal })
      .then((d) => setData((s) => ({ ...s, conditions: Array.isArray(d?.items) ? d.items : [], condFailed: false })))
      .catch((err) => { if (!isAbort(err)) { loaded.current = null; setData((s) => ({ ...s, condFailed: true })) } })
  }, [])

  const onViewport = useCallback((vp) => {
    view.current = vp
    const l = loaded.current
    const inside = l && vp.south >= l.bounds.south && vp.north <= l.bounds.north && vp.west >= l.bounds.west && vp.east <= l.bounds.east
    if (inside && Date.now() - l.at < refreshMs.current) return
    load(vp)
  }, [load])

  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden && view.current) load(view.current) }, data.refreshSeconds * 1000)
    return () => clearInterval(id)
  }, [data.refreshSeconds, load])

  useEffect(() => () => { inflight.current.ev?.abort(); inflight.current.cond?.abort() }, [])

  return { events: data.events, conditions: data.conditions, failed: data.evFailed || data.condFailed, onViewport }
}
