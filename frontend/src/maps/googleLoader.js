/**
 * Loads the Google Maps JavaScript API with a plain <script> tag (no @googlemaps/* packages).
 *
 * Classic callback loading, so google.maps.Map / Polyline / Marker / Circle / TrafficLayer exist directly (no importLibrary).
 * Exactly one script tag is ever injected; the promise is cached. It rejects when the script cannot be fetched, when it
 * does not answer in time, or when Google reports a bad / restricted key (window.gm_authFailure: key invalid, API not
 * enabled, referrer not allowed, billing off...). gm_authFailure usually fires AFTER the script loaded and the first map
 * was created, so components also subscribe with onGoogleAuthFailure().
 *
 * The key is only put in the script URL - it is never logged here.
 */

const CALLBACK = '__rmGoogleMapsReady'
const TIMEOUT_MS = 20000

export class GoogleMapsError extends Error {
  /** kind: 'auth' | 'network' | 'timeout' | 'no_key' */
  constructor(kind, message) {
    super(message)
    this.kind = kind
  }
}

const listeners = new Set()
let authFailed = false
let hooked = false
let loading = null

/** Install window.gm_authFailure once; it notifies every subscriber. Safe to call repeatedly. */
function hookAuthFailure() {
  if (hooked || typeof window === 'undefined') return
  hooked = true
  const previous = window.gm_authFailure
  window.gm_authFailure = () => {
    authFailed = true
    try { previous?.() } catch { /* someone else's hook must not break ours */ }
    listeners.forEach((fn) => { try { fn() } catch { /* a subscriber's bug stays its own */ } })
  }
}

/** Call `fn` when Google rejects the key. Returns an unsubscribe function. */
export function onGoogleAuthFailure(fn) {
  hookAuthFailure()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** True once Google has reported an authorisation problem in this page session (a reload is needed to retry). */
export const googleAuthFailed = () => authFailed

const AUTH_MESSAGE = 'Google rejected the Maps API key (invalid, restricted, API not enabled or billing off).'

/** Resolves with window.google.maps. Only one key can be used per page: later calls share the first load. */
export function loadGoogleMaps(apiKey) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.reject(new GoogleMapsError('network', 'No browser.'))
  hookAuthFailure()
  if (authFailed) return Promise.reject(new GoogleMapsError('auth', AUTH_MESSAGE))
  if (loading) return loading
  if (!apiKey) return Promise.reject(new GoogleMapsError('no_key', 'No Google Maps API key.'))
  if (window.google?.maps?.Map) return (loading = Promise.resolve(window.google.maps)) // already on the page

  loading = new Promise((resolve, reject) => {
    let script = null
    let timer = null
    const done = () => { clearTimeout(timer); window[CALLBACK] = () => {} } // a late callback (after a timeout) must not throw
    const unsubscribe = onGoogleAuthFailure(() => { unsubscribe(); done(); reject(new GoogleMapsError('auth', AUTH_MESSAGE)) })

    window[CALLBACK] = () => {
      done()
      unsubscribe()
      if (authFailed) reject(new GoogleMapsError('auth', AUTH_MESSAGE))
      else if (window.google?.maps?.Map) resolve(window.google.maps)
      else reject(new GoogleMapsError('network', 'Google Maps loaded but did not start.'))
    }
    timer = setTimeout(() => { // stays cached as failed: a second script tag would only confuse Google
      unsubscribe(); done()
      reject(new GoogleMapsError('timeout', 'Google Maps did not answer in time.'))
    }, TIMEOUT_MS)

    script = document.createElement('script')
    script.async = true
    script.defer = true
    script.dataset.rmGoogleMaps = '1'
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=${CALLBACK}&v=weekly&libraries=geometry`
    script.onerror = () => {
      unsubscribe(); done()
      script.remove()
      loading = null // a network blip should not block a later retry (the next mount)
      reject(new GoogleMapsError('network', 'The Google Maps script could not be loaded.'))
    }
    document.head.appendChild(script)
  })
  return loading
}
