import { LocateFixed, MousePointerClick } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import MapCanvas from '../../maps/MapCanvas'

export const validPoint = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180
const round6 = (n) => Math.round(n * 1e6) / 1e6

/**
 * Pick one point on a map: click it, use the current location, or type the coordinates.
 * value = { lat, lng } | null, onChange({ lat, lng }). `extraOverlays` are drawn under the chosen point's marker.
 * Used by the report flow and by the staff "record an event" panel.
 */
export default function PointPicker({ value, onChange, emoji = '📍', color = '#5b3df5', height = 340, extraOverlays, onViewportChange, idPrefix = 'pp', hint }) {
  const mapRef = useRef(null)
  const [locating, setLocating] = useState(false)
  const [msg, setMsg] = useState(null)
  const [text, setText] = useState({ lat: '', lng: '' })
  const [initial] = useState(() => (validPoint(value) ? { center: { lat: value.lat, lng: value.lng }, zoom: 17 } : null)) // a restored draft opens on its point

  // Keep the two text fields in step with the point - but leave them alone while what is typed already means the same point.
  useEffect(() => {
    if (!validPoint(value)) return
    setText((t) => (Math.abs(parseFloat(t.lat) - value.lat) < 1e-6 && Math.abs(parseFloat(t.lng) - value.lng) < 1e-6 ? t : { lat: value.lat.toFixed(6), lng: value.lng.toFixed(6) }))
  }, [value?.lat, value?.lng]) // eslint-disable-line react-hooks/exhaustive-deps

  const overlays = useMemo(() => {
    const own = validPoint(value) ? [{ type: 'marker', id: 'picked-point', position: { lat: value.lat, lng: value.lng }, emoji, color, size: 40, z: 30 }] : []
    return [...(extraOverlays || []), ...own]
  }, [value?.lat, value?.lng, emoji, color, extraOverlays]) // eslint-disable-line react-hooks/exhaustive-deps

  function locate() {
    setMsg(null)
    if (!navigator.geolocation) return setMsg('Your browser does not support location. Click the spot on the map instead.')
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        const p = { lat: round6(pos.coords.latitude), lng: round6(pos.coords.longitude) }
        onChange(p)
        mapRef.current?.panTo({ ...p, zoom: 17 })
      },
      () => { setLocating(false); setMsg('Could not get your location. Allow location access in the browser, or click the spot on the map instead.') },
      { timeout: 10000, enableHighAccuracy: true },
    )
  }

  function typed(field, v) {
    const next = { ...text, [field]: v }
    setText(next)
    const p = { lat: parseFloat(next.lat), lng: parseFloat(next.lng) }
    if (validPoint(p) && next.lat.trim() !== '' && next.lng.trim() !== '') { onChange(p); setMsg(null) }
  }
  const panToTyped = () => { if (validPoint(value)) mapRef.current?.panTo({ lat: value.lat, lng: value.lng, zoom: 17 }) }
  const badText = (text.lat !== '' || text.lng !== '') && !(validPoint({ lat: parseFloat(text.lat), lng: parseFloat(text.lng) }))

  return (
    <div className="ev-picker">
      <div className="ev-picker-actions">
        <button type="button" className="btn btn-primary" onClick={locate} disabled={locating}><LocateFixed size={18} aria-hidden="true" /> {locating ? 'Finding you…' : 'Use my current location'}</button>
        <span className="ev-picker-tip"><MousePointerClick size={16} aria-hidden="true" /> {hint || 'or click the spot on the map'}</span>
      </div>
      {msg && <div className="ev-hint ev-hint-warn" role="status">{msg}</div>}
      <div className="ev-map" style={{ height }}>
        <MapCanvas
          ref={mapRef} height={height} initialCenter={initial?.center} initialZoom={initial?.zoom} overlays={overlays} traffic={false}
          showLocate={false} showTrafficToggle={false} onMapClick={({ lat, lng }) => { setMsg(null); onChange({ lat: round6(lat), lng: round6(lng) }) }}
          onViewportChange={onViewportChange}
        />
      </div>
      <div className="ev-coords">
        <div className="field">
          <label htmlFor={`${idPrefix}-lat`}>Latitude</label>
          <input id={`${idPrefix}-lat`} className="input" inputMode="decimal" value={text.lat} placeholder="e.g. 13.0735" onChange={(e) => typed('lat', e.target.value)} onBlur={panToTyped} aria-invalid={badText || undefined} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-lng`}>Longitude</label>
          <input id={`${idPrefix}-lng`} className="input" inputMode="decimal" value={text.lng} placeholder="e.g. 80.2645" onChange={(e) => typed('lng', e.target.value)} onBlur={panToTyped} aria-invalid={badText || undefined} />
        </div>
      </div>
      {badText && <div className="form-error">Enter a latitude between -90 and 90 and a longitude between -180 and 180.</div>}
      {!validPoint(value) && !badText && <div className="ev-hint">No location chosen yet.</div>}
    </div>
  )
}
