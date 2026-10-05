import { useEffect, useRef, useState } from 'react'

/**
 * The only two places Emergency Route Mode ever asks the browser for the person's position:
 *   getPosition()      ONE fix, when the person taps "Use My Location" / "Update my location".
 *   useLiveWatch()     a continuous watch, only while `enabled` (set after the person taps "Start Emergency Route"), stopped when
 *                      navigation ends, when the page unmounts and when the tab has been hidden for more than 2 minutes.
 * Nothing here ever invents or guesses a position.
 */

/** Resolves { lat, lng, accuracy }; rejects { kind: 'denied' | 'failed' }. */
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { reject({ kind: 'failed' }); return }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject({ kind: e?.code === 1 ? 'denied' : 'failed' }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  })
}

const THROTTLE_MS = 3000
const HIDDEN_STOP_MS = 120000

/**
 * { fix, error, watching }. `fix` = { lat, lng, accuracy, speed (m/s or null), heading, at } - at most one new value every ~3 s.
 * `error` is 'denied' | 'unavailable' | null ('unavailable' = no signal right now; the watch keeps trying).
 */
export function useLiveWatch(enabled) {
  const [state, setState] = useState({ fix: null, error: null, watching: false })
  const lastAt = useRef(0)

  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined' || !navigator.geolocation) return undefined
    let id = null
    let hiddenTimer = null
    let alive = true

    const onFix = (p) => {
      const now = Date.now()
      if (now - lastAt.current < THROTTLE_MS) return
      lastAt.current = now
      const c = p.coords
      setState({
        fix: { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, speed: Number.isFinite(c.speed) ? c.speed : null, heading: Number.isFinite(c.heading) ? c.heading : null, at: now },
        error: null, watching: true,
      })
    }
    const onError = (e) => {
      if (!alive) return
      if (e?.code === 1) { stop(); setState((s) => ({ ...s, error: 'denied', watching: false })) } else setState((s) => ({ ...s, error: 'unavailable' }))
    }
    const begin = () => {
      if (id != null) return
      id = navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 })
      setState((s) => ({ ...s, watching: true }))
    }
    function stop() {
      if (id != null) { navigator.geolocation.clearWatch(id); id = null }
      setState((s) => (s.watching ? { ...s, watching: false } : s))
    }
    const onVisibility = () => {
      clearTimeout(hiddenTimer)
      if (document.hidden) hiddenTimer = setTimeout(stop, HIDDEN_STOP_MS)
      else if (alive) begin()
    }

    begin()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      clearTimeout(hiddenTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      if (id != null) navigator.geolocation.clearWatch(id)
      setState({ fix: null, error: null, watching: false })
    }
  }, [enabled])

  return state
}
