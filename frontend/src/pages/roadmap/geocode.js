/** Reverse geocoding of a clicked point with Google's Geocoder - only when Google Maps is actually loaded. Never throws. */

export const hasGeocoder = () => {
  try { return !!window.google?.maps?.Geocoder } catch { return false }
}

/**
 * The name of the road at (lat, lng) as Google knows it, or null (no Google, no result, error, or no answer within `timeoutMs`).
 * Takes the first result whose types contain 'route' and returns its 'route' address component's long name.
 */
export function reverseGeocodeRoad(lat, lng, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false
    let timer = null
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => finish(null), timeoutMs)
    try {
      const Geocoder = window.google?.maps?.Geocoder
      if (!Geocoder) { finish(null); return }
      new Geocoder().geocode({ location: { lat, lng } }, (results, status) => {
        try {
          if (status !== 'OK' || !Array.isArray(results)) { finish(null); return }
          const hit = results.find((r) => Array.isArray(r.types) && r.types.includes('route'))
          const part = hit?.address_components?.find((c) => Array.isArray(c.types) && c.types.includes('route'))
          finish(part?.long_name || null)
        } catch { finish(null) }
      })
    } catch { finish(null) }
  })
}

export const coordLabel = (at) => `Selected location (${at.lat.toFixed(5)}, ${at.lng.toFixed(5)})`
