import { useEffect, useState } from 'react'
import { api } from '../api'

/**
 * Map settings from GET /api/map/config, fetched once per page load and cached at module level.
 * If the request fails the map still works: safe defaults (Chennai, standard OpenStreetMap tiles, no Google key).
 */

export const DEFAULT_CONFIG = {
  google: { js_api_key: null, routes_enabled: false },
  default_center: { lat: 13.0735, lng: 80.2645 },
  default_zoom: 14,
  tiles: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    max_zoom: 19,
  },
  simulated_data: false,
  refresh_seconds: 60,
}

const TIMEOUT_MS = 6000 // a hanging config request must never hold the map back
const RETRY_AFTER_MS = 15000 // after a failure, the next mount may try again (a restart of the API should heal the page)

let cached = null // the merged config once the request has succeeded
let inflight = null
let failed = null // { at, message } of the last failure

/** Fill gaps in a (possibly partial) server answer with the defaults. */
function merge(raw) {
  const d = DEFAULT_CONFIG
  const r = raw && typeof raw === 'object' ? raw : {}
  const center = r.default_center && Number.isFinite(r.default_center.lat) && Number.isFinite(r.default_center.lng) ? r.default_center : d.default_center
  return {
    google: { ...d.google, ...(r.google || {}) },
    default_center: center,
    default_zoom: Number(r.default_zoom) || d.default_zoom,
    tiles: { ...d.tiles, ...(r.tiles || {}), url: r.tiles?.url || d.tiles.url },
    simulated_data: !!r.simulated_data,
    refresh_seconds: Number(r.refresh_seconds) || d.refresh_seconds,
  }
}

function fetchConfig() {
  if (cached) return Promise.resolve({ config: cached, error: null })
  if (failed && Date.now() - failed.at < RETRY_AFTER_MS) return Promise.resolve({ config: DEFAULT_CONFIG, error: failed.message })
  if (!inflight) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    inflight = api('/map/config', { signal: ctl.signal })
      .then((raw) => { cached = merge(raw); failed = null; return { config: cached, error: null } })
      .catch((err) => {
        const message = err?.name === 'AbortError' ? 'The map settings request timed out.' : err?.message || 'Could not load the map settings.'
        failed = { at: Date.now(), message }
        return { config: DEFAULT_CONFIG, error: message }
      })
      .finally(() => { clearTimeout(timer); inflight = null })
  }
  return inflight
}

/**
 * The Google Maps browser key: the build-time VITE_GOOGLE_MAPS_API_KEY first, else the one the server hands out.
 * Never hard-code a key and never log it. Returns null when there is none.
 */
export function resolveGoogleKey(config) {
  const key = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || config?.google?.js_api_key || '').trim()
  return key || null
}

/** `{ config, loading, error }` - `config` is always usable (the defaults while loading or after a failure). */
export function useMapConfig() {
  const [state, setState] = useState(() => (cached ? { config: cached, loading: false, error: null } : { config: DEFAULT_CONFIG, loading: true, error: null }))
  useEffect(() => {
    if (cached) { setState((s) => (s.config === cached && !s.loading ? s : { config: cached, loading: false, error: null })); return }
    let alive = true
    fetchConfig().then(({ config, error }) => { if (alive) setState({ config, loading: false, error }) })
    return () => { alive = false }
  }, [])
  return state
}
