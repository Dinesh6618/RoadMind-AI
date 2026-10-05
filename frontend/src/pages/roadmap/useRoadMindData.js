import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { bboxParams, padViewport } from './geo'

/**
 * The two RoadMind overlays of the map page: road CONDITIONS (roads that have data) and road EVENTS (blockages, closures...).
 * They never gate the base map: a request that fails or returns nothing only changes `state` / `items` here.
 *
 *   load(viewport)   fetch both for that view (aborting the previous requests); also remembers the view for the timer
 *   state            'loading' (nothing answered yet) | 'ok' | 'error' - the previous items stay on screen while a refresh runs
 *
 * Refreshes itself every `refreshSeconds` while the tab is visible, and once more when the tab becomes visible again after
 * a long time. After 3 failed refreshes in a row the old items are dropped rather than shown as if they were current.
 */

const MAX_STALE_FAILS = 3
const CONDITION_LIMIT = 2000 // the most severe roads win when a very wide view holds more than this

const isAbort = (err) => err?.name === 'AbortError'

export function useRoadMindData(refreshSeconds = 60) {
  const [cond, setCond] = useState({ state: 'loading', items: [], counts: {}, simulated: false, updatedAt: null, message: null })
  const [ev, setEv] = useState({ state: 'loading', items: [], updatedAt: null, bounds: null })
  const view = useRef(null)
  const inflight = useRef({ cond: null, ev: null })
  const fails = useRef({ cond: 0, ev: 0 })
  const lastLoad = useRef(0)

  const load = useCallback((vp) => {
    const target = vp || view.current
    if (!target) return
    view.current = target
    lastLoad.current = Date.now()
    inflight.current.cond?.abort()
    inflight.current.ev?.abort()
    const c1 = new AbortController()
    const c2 = new AbortController()
    inflight.current = { cond: c1, ev: c2 }
    const bounds = padViewport(target)
    const q = bboxParams(bounds)

    api(`/road-conditions?${q}&limit=${CONDITION_LIMIT}`, { signal: c1.signal })
      .then((d) => {
        fails.current.cond = 0
        setCond({
          state: 'ok', items: Array.isArray(d?.items) ? d.items : [], counts: d?.counts || {}, simulated: !!d?.simulated_data,
          updatedAt: d?.updated_at || null, message: d?.message || null,
        })
      })
      .catch((err) => {
        if (isAbort(err)) return
        fails.current.cond += 1
        setCond((prev) => ({ ...prev, state: 'error', items: fails.current.cond >= MAX_STALE_FAILS ? [] : prev.items }))
      })

    api(`/road-events/active?${q}`, { signal: c2.signal })
      .then((d) => {
        fails.current.ev = 0
        setEv({ state: 'ok', items: Array.isArray(d?.items) ? d.items : [], updatedAt: d?.updated_at || null, bounds })
      })
      .catch((err) => {
        if (isAbort(err)) return
        fails.current.ev += 1
        setEv((prev) => ({ ...prev, state: 'error', items: fails.current.ev >= MAX_STALE_FAILS ? [] : prev.items }))
      })
  }, [])

  useEffect(() => {
    const ms = Math.max(3, Number(refreshSeconds) || 60) * 1000
    const id = setInterval(() => { if (!document.hidden) load() }, ms)
    const onVisible = () => { if (!document.hidden && Date.now() - lastLoad.current >= ms) load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
  }, [refreshSeconds, load])

  useEffect(() => () => { inflight.current.cond?.abort(); inflight.current.ev?.abort() }, [])

  return { cond, ev, load }
}
