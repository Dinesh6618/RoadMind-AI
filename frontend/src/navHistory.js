import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * Navigation history that behaves like a real app:
 *  - useNavTracker()   remembers which page each history entry of THIS tab shows, so a Back button can tell where "back" really is;
 *  - BackButton        (components.jsx) goes to that previous page with navigate(-1) when it is a content page, and to the page's logical
 *                      parent otherwise - never back into a login / welcome screen from inside the app;
 *  - useHistoryLevel() makes an in-page layer (a detail panel, a bottom sheet, a step of a flow) part of the browser history, so the
 *                      phone / browser Back button closes it instead of leaving the page.
 */
const KEY = 'roadmind_nav'
const KEEP = 400 // how many history entries are remembered

const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '{}') } catch { return {} } }
const write = (map) => { try { sessionStorage.setItem(KEY, JSON.stringify(map)) } catch { /* storage blocked: Back then uses the parent page */ } }

/** react-router numbers its own history entries (history.state.idx): 0 is the first page of this tab. */
export const historyIndex = () => window.history.state?.idx ?? 0

// Pages that are about signing in or choosing a role: Back from inside the app must never land on them.
const AUTH_ONLY = ['/', '/welcome', '/user/login', '/user/register', '/user/forgot-password', '/admin/login', '/admin/register', '/admin/portal', '/admin/forgot-password', '/setup', '/admin/setup', '/reset-password', '/verify-email', '/accept-invite']
export const isContentPath = (path) => !!path && !AUTH_ONLY.includes(path.split('?')[0])

/** The page that was shown one history entry ago in this tab, if known (null after a fresh start or a reload of the tab's first page). */
export function previousPath() {
  const idx = historyIndex()
  return idx > 0 ? read()[idx - 1] || null : null
}

export function useNavTracker() {
  const location = useLocation()
  useEffect(() => {
    const idx = historyIndex()
    const map = read()
    map[idx] = location.pathname + location.search
    for (const k of Object.keys(map)) if (Number(k) < idx - KEEP) delete map[k]
    write(map)
  }, [location])
}

/**
 * `level`: 0 = the page itself, 1 = a layer is open (a panel), 2 = a layer on top of it (a drawer)... Opening a layer pushes a history entry;
 * closing it in the page goes back one; pressing the Back button closes it and calls `onBack(newLevel)` so the page can follow.
 */
export function useHistoryLevel(level, onBack) {
  const location = useLocation()
  const navigate = useNavigate()
  const cur = location.state?.rmLevel || 0
  const prev = useRef({ level, cur })
  const follow = useRef(onBack)
  follow.current = onBack
  useEffect(() => {
    const was = prev.current
    prev.current = { level, cur }
    if (level !== was.level && cur === was.cur) { // the page opened or closed a layer
      if (level > cur) navigate({ pathname: location.pathname, search: location.search }, { state: { ...location.state, rmLevel: level } })
      else if (level < cur) navigate(-(cur - level))
    } else if (cur !== was.cur && level === was.level && cur < level) { // the Back button went below the open layers
      follow.current?.(cur)
    }
  }, [level, cur]) // eslint-disable-line react-hooks/exhaustive-deps
}
