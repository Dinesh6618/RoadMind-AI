import { useCallback, useEffect, useRef, useState } from 'react'

const TOKEN_KEY = 'roadmind_token'

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}
export function setToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY) } catch { /* storage blocked */ }
}

export class ApiError extends Error {
  /** `info` carries the machine-readable parts of a structured error: { code, portal, login_path, email }. */
  constructor(message, status, info = {}) {
    super(message)
    this.status = status
    this.code = info.code
    this.info = info
  }
}

function describe(detail, fallback) {
  if (!detail) return fallback
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map((d) => `${(d.loc || []).slice(1).join('.')}: ${d.msg}`).join('; ')
  if (typeof detail === 'object' && typeof detail.message === 'string') return detail.message
  return fallback
}

// Where the API lives. Empty = the same address as this page (the normal case: RoadMind serves the site, and the Vite
// dev server proxies /api). Set VITE_API_URL (see frontend/.env.example) to call a backend on another address.
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')

const SERVER_DOWN = "The RoadMind server isn't answering. Make sure it is running (python scripts/start.py) and try again."

/** Fetch JSON from the RoadMind API. `json` sends a JSON body, `form` a FormData body. */
export async function api(path, { method = 'GET', json, form, signal } = {}) {
  const headers = { Accept: 'application/json' }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  let body
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(json)
  } else if (form) {
    body = form
  }
  let res
  try {
    res = await fetch(`${API_BASE}/api${path}`, { method, headers, body, signal })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError(SERVER_DOWN, 0, { code: 'server_unreachable' })
  }
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  if (!res.ok) {
    const detail = data?.detail
    // A 5xx with no JSON body did not come from RoadMind: it is a proxy / gateway saying the backend is not there
    // (for example the Vite dev server while the API is stopped). Say that instead of a bare "Request failed (500)".
    if (res.status >= 500 && !detail) throw new ApiError(`${SERVER_DOWN} (HTTP ${res.status})`, res.status, { code: 'server_unreachable' })
    throw new ApiError(describe(detail, `Request failed (${res.status})`), res.status, detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {})
  }
  return data
}

/** Load data on mount / when `path` changes. Pass path=null to skip. */
export function useApi(path, { onUnauthorized } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: !!path })
  const [tick, setTick] = useState(0)
  const cb = useRef(onUnauthorized)
  cb.current = onUnauthorized
  useEffect(() => {
    if (!path) { setState({ data: null, error: null, loading: false }); return }
    const ctl = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    api(path, { signal: ctl.signal })
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => {
        if (error.name === 'AbortError') return
        if (error.status === 401 && cb.current) cb.current()
        setState({ data: null, error, loading: false })
      })
    return () => ctl.abort()
  }, [path, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}
