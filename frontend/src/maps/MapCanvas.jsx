import { Info, LoaderCircle, LocateFixed, TriangleAlert, X } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import GoogleEngine from './GoogleEngine'
import LeafletEngine from './LeafletEngine'
import { loadGoogleMaps, onGoogleAuthFailure } from './googleLoader'
import './maps.css'
import { resolveGoogleKey, useMapConfig } from './useMapConfig'

/**
 * The map every page uses. The real-world road network ALWAYS comes from a real map provider:
 *   - Google Maps (JavaScript API) when a key is configured and Google loads,
 *   - otherwise OpenStreetMap raster tiles in Leaflet (no key, or Google failed / rejected the key).
 * RoadMind data (damage, closures, risk) is only an overlay drawn on top, passed in `overlays`. The base map never waits
 * for any RoadMind API: with zero RoadMind records, or a failing RoadMind API, every real street is still on the map.
 *
 * Props (see the contract in the task / docs): height, className, initialCenter, initialZoom, fit, pan, overlays, traffic,
 * onViewportChange, onMapClick, onStatus, showLocate, showTrafficToggle, children. Ref: { fitTo, panTo, getViewport }.
 */

export const GOOGLE_FAILED = 'Unable to load Google Maps. Please check your Google Maps API key and enabled APIs.'
export const GOOGLE_MISSING = 'Google Maps is not set up yet - showing the OpenStreetMap base map. Live traffic is unavailable.'
const LOCATE_FAILED = 'Could not get your location. Allow location access in the browser, or search for a place instead.'
const INFO_DISMISSED_KEY = 'roadmind_map_info_dismissed'

const readDismissed = () => { try { return sessionStorage.getItem(INFO_DISMISSED_KEY) === '1' } catch { return false } }
const writeDismissed = () => { try { sessionStorage.setItem(INFO_DISMISSED_KEY, '1') } catch { /* storage blocked: the notice just comes back next time */ } }

const MapCanvas = forwardRef(function MapCanvas({
  height = '100%', className = '', initialCenter, initialZoom, fit = null, pan = null, overlays, traffic = true,
  onViewportChange, onMapClick, onStatus, showLocate = true, showTrafficToggle = true, children,
}, ref) {
  const { config, loading } = useMapConfig()
  const key = resolveGoogleKey(config)

  const [engine, setEngine] = useState(null) // null while the config / Google load, then 'google' | 'leaflet'
  const [gmaps, setGmaps] = useState(null)
  const [googleError, setGoogleError] = useState(null)
  const [readyEngine, setReadyEngine] = useState(null)
  const [trafficOn, setTrafficOn] = useState(!!traffic)
  const [location, setLocation] = useState(null)
  const [locating, setLocating] = useState(false)
  const [notice, setNotice] = useState(null)
  const [infoDismissed, setInfoDismissed] = useState(readDismissed)

  const engineRef = useRef(null)
  const lastViewport = useRef(null)
  const pending = useRef({}) // fitTo/panTo calls made before the map exists
  const live = useRef({})
  live.current = { onViewportChange, onMapClick, onStatus }

  const failGoogle = useCallback((err) => { setGoogleError(err?.message || 'Google Maps failed to load.'); setEngine('leaflet') }, [])

  // Engine choice. No key -> OpenStreetMap right away. Key -> Google, and OpenStreetMap if it fails to load or rejects the key.
  useEffect(() => {
    if (loading) return undefined
    if (!key) { setEngine('leaflet'); return undefined }
    let alive = true
    const fail = (err) => { if (alive) failGoogle(err) }
    const off = onGoogleAuthFailure(() => fail(new Error('Google rejected the Maps API key.'))) // fires after the map was created, too
    loadGoogleMaps(key).then((g) => { if (alive) { setGmaps(g); setEngine('google') } }, fail)
    return () => { alive = false; off() }
  }, [loading, key, failGoogle])

  useEffect(() => setTrafficOn(!!traffic), [traffic])

  const ready = engine !== null && readyEngine === engine
  const status = useMemo(() => ({
    engine: engine || (key ? 'google' : 'leaflet'), ready, googleConfigured: !!key, googleError, trafficLayer: engine === 'google' && ready && trafficOn,
  }), [engine, key, ready, googleError, trafficOn])
  useEffect(() => { live.current.onStatus?.(status) }, [status])

  const handleViewport = useCallback((vp) => { lastViewport.current = vp; live.current.onViewportChange?.(vp) }, [])
  const handleClick = useCallback((at) => { if (at) live.current.onMapClick?.(at) }, [])
  const handleReady = useCallback((which) => {
    setReadyEngine(which)
    const p = pending.current
    pending.current = {}
    if (p.fit) engineRef.current?.fitTo(p.fit)
    if (p.pan) engineRef.current?.panTo(p.pan)
  }, [])

  useImperativeHandle(ref, () => ({
    fitTo(bounds) { if (!engineRef.current?.fitTo(bounds)) pending.current.fit = bounds },
    panTo(point) { if (!engineRef.current?.panTo(point)) pending.current.pan = point },
    getViewport: () => engineRef.current?.getViewport() || lastViewport.current,
  }), [])

  const locate = useCallback(() => {
    if (!navigator.geolocation) { setNotice(LOCATE_FAILED); return }
    setLocating(true)
    setNotice(null)
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setLocating(false)
        setLocation({ lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy })
        engineRef.current?.panTo({ lat: coords.latitude, lng: coords.longitude, zoom: coords.accuracy > 1000 ? 14 : 16 })
      },
      () => { setLocating(false); setNotice(LOCATE_FAILED) }, // denied / unavailable / timed out: nothing fatal
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    )
  }, [])

  const center = initialCenter || config.default_center
  const zoom = initialZoom || config.default_zoom || 14
  const restore = lastViewport.current ? { center: lastViewport.current.center, zoom: lastViewport.current.zoom } : null // an engine switch keeps the user's view
  const shared = { center, zoom, restore, fit, pan, overlays, location, onViewport: handleViewport, onMapClick: handleClick }
  const showError = engine === 'leaflet' && !!googleError
  const showInfo = engine === 'leaflet' && !key && !infoDismissed

  return (
    <div className={`rm-map ${className}`.trim()} style={{ height }}>
      {engine === 'google' && <GoogleEngine key="google" ref={engineRef} gmaps={gmaps} trafficOn={trafficOn} onReady={() => handleReady('google')} onFail={failGoogle} {...shared} />}
      {engine === 'leaflet' && <LeafletEngine key="leaflet" ref={engineRef} tiles={config.tiles} onReady={() => handleReady('leaflet')} {...shared} />}
      {engine === null && (
        <div className="rm-map-loading" role="status">
          <LoaderCircle size={20} className="rm-map-spin" aria-hidden="true" />
          <span>Loading map…</span>
        </div>
      )}

      {/* DOM controls from the page. Siblings of the map (not inside it), so their clicks/touches/scrolls can never reach it. */}
      <div className="rm-map-children">{children}</div>

      <div className={`rm-map-controls${engine === 'google' ? '' : ' is-leaflet'}`}>
        {showLocate && engine !== null && (
          <button type="button" className="rm-map-fab glass" onClick={locate} disabled={locating} aria-label="Show my location" title="Show my location">
            {locating ? <LoaderCircle size={20} className="rm-map-spin" aria-hidden="true" /> : <LocateFixed size={20} aria-hidden="true" />}
          </button>
        )}
        {showTrafficToggle && engine === 'google' && (
          <button type="button" className={`rm-map-chip glass${trafficOn ? ' is-on' : ''}`} onClick={() => setTrafficOn((on) => !on)} aria-pressed={trafficOn} aria-label="Toggle live traffic">
            <i aria-hidden="true" />Traffic
          </button>
        )}
      </div>

      <div className={`rm-map-notices${engine === 'google' ? ' is-google' : ''}`}>
        {showError && (
          <div className="rm-map-banner is-error" role="alert">
            <TriangleAlert size={18} aria-hidden="true" />
            <span>{GOOGLE_FAILED}</span>
          </div>
        )}
        {showInfo && (
          <div className="rm-map-banner is-info" role="status">
            <Info size={18} aria-hidden="true" />
            <span>{GOOGLE_MISSING}</span>
            <button type="button" aria-label="Dismiss this message" onClick={() => { setInfoDismissed(true); writeDismissed() }}><X size={16} aria-hidden="true" /></button>
          </div>
        )}
        {notice && (
          <div className="rm-map-banner is-warn" role="status">
            <Info size={18} aria-hidden="true" />
            <span>{notice}</span>
            <button type="button" aria-label="Dismiss this message" onClick={() => setNotice(null)}><X size={16} aria-hidden="true" /></button>
          </div>
        )}
      </div>
    </div>
  )
})

export default MapCanvas
