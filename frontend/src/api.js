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
    res = await fetch(`/api${path}`, { method, headers, body, signal })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError('Cannot reach the RoadMind server. Is it running?', 0)
  }
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  if (!res.ok) {
    const detail = data?.detail
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
