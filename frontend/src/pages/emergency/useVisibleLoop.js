import { useEffect, useRef } from 'react'

/**
 * Calls `fn` every `intervalMs` while `enabled` - but only while the tab is visible - and backs off after failures.
 *   - `fn` returns (a promise of) true when it worked and false when it failed; after a failure the wait doubles (up to 8x).
 *   - while the tab is hidden nothing runs; when it becomes visible again the call is made at once if it is due.
 *   - `resetKey` restarts the loop (a new route to watch): the first call comes after one full interval.
 * It stops for good when `enabled` turns false or the component unmounts.
 */
export function useVisibleLoop(fn, intervalMs, enabled, resetKey = 0) {
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled || !(intervalMs > 0)) return undefined
    let stopped = false
    let timer = null
    let fails = 0
    let lastRun = Date.now()

    const delay = () => (fails ? Math.min(intervalMs * 2 ** fails, intervalMs * 8) : intervalMs)
    const clear = () => { clearTimeout(timer); timer = null }
    const schedule = (ms) => { clear(); timer = setTimeout(tick, ms) }

    async function tick() {
      timer = null
      if (stopped || document.hidden) return // resumed by visibilitychange
      lastRun = Date.now()
      let ok = true
      try { ok = (await fnRef.current()) !== false } catch { ok = false }
      if (stopped) return
      fails = ok ? 0 : fails + 1
      if (!document.hidden) schedule(delay())
    }

    const onVisibility = () => {
      if (stopped) return
      if (document.hidden) { clear(); return }
      const wait = delay() - (Date.now() - lastRun)
      if (wait <= 0) { clear(); tick() } else if (timer == null) schedule(wait)
    }

    schedule(intervalMs)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stopped = true; clear(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [enabled, intervalMs, resetKey])
}
