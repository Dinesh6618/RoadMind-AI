import { ChevronDown, ChevronUp, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../../api'
import { ErrorBox, Notice } from '../../../components'
import { fmtWhen } from '../../report/eventTime'
import PointPicker, { validPoint } from '../../report/PointPicker'
import { BLOCKING_TYPES, DEFAULT_HOURS, DEFAULT_RADIUS_M, EVENT_TYPE_ORDER, HOURS_MAX, HOURS_MIN, RADIUS_MAX, RADIUS_MIN, explain, parseNumber } from './util'

// Used until the list answer brings the server's own labels.
const FALLBACK = {
  ROAD_BLOCKED: { label: 'Road blocked', emoji: '🚧' }, ROAD_CLOSED: { label: 'Road closed', emoji: '⛔' }, TEMPORARY_CLOSURE: { label: 'Temporary closure', emoji: '⛔' },
  CONSTRUCTION: { label: 'Construction', emoji: '🚧' }, ACCIDENT: { label: 'Accident', emoji: '⚠️' }, FLOODED: { label: 'Flooded road', emoji: '🌊' },
  SEVERE_DAMAGE: { label: 'Severe road damage', emoji: '🕳️' }, ROAD_REOPENED: { label: 'Road reopened', emoji: '✅' },
}

const TYPE_HELP = {
  ROAD_BLOCKED: 'Verified at once. Route suggestions will avoid routes through it until it expires or you mark the road reopened.',
  ROAD_CLOSED: 'Verified at once. Route suggestions will avoid routes through it until it expires or you mark the road reopened.',
  TEMPORARY_CLOSURE: 'Verified at once. Route suggestions will avoid routes through it until it expires or you mark the road reopened.',
  CONSTRUCTION: 'Raises the risk of routes through it. Use "Update / extend" later to record progress.',
  ACCIDENT: 'Raises the risk of routes through it.',
  FLOODED: 'Raises the risk of routes through it.',
  SEVERE_DAMAGE: 'Raises the risk of routes through it.',
  ROAD_REOPENED: 'A record that the road is open again. It also resolves any live blockage or closure within the radius.',
}

/** "Record an event": staff pick a point on the map and record a blockage, closure, construction... or that a road reopened. */
export default function CreateEventPanel({ types, refreshKey, onCreated, onUnauthorized, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const [type, setType] = useState('ROAD_BLOCKED')
  const [point, setPoint] = useState(null)
  const [roadName, setRoadName] = useState('')
  const [description, setDescription] = useState('')
  const [hours, setHours] = useState('')
  const [radius, setRadius] = useState(String(DEFAULT_RADIUS_M))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)
  const [pickerKey, setPickerKey] = useState(0)
  const [view, setView] = useState(null) // the map's viewport
  const [live, setLive] = useState([]) // what is already recorded around here

  const meta = (t) => ({ ...FALLBACK[t], ...(types?.[t] || {}) })
  const reopened = type === 'ROAD_REOPENED'

  // Existing live events inside the viewport, as small markers: so staff can see what is already recorded before adding more.
  useEffect(() => {
    if (!open || !view) return undefined
    let cancelled = false
    const qs = new URLSearchParams({ south: view.south, west: view.west, north: view.north, east: view.east })
    api(`/road-events/active?${qs}`).then((d) => !cancelled && setLive(d.items || [])).catch(() => !cancelled && setLive([]))
    return () => { cancelled = true }
  }, [open, view, refreshKey])

  const overlays = useMemo(() => live.map((e) => ({
    type: 'marker', id: `live-${e.id}`, position: { lat: e.lat, lng: e.lng }, emoji: e.emoji, size: 28, z: 10,
    color: e.is_blocking ? '#e0342f' : e.verification_status === 'PENDING' ? '#8b94b8' : '#d97706',
    tip: `${e.headline}${e.road_name ? ` - ${e.road_name}` : ''}${e.verification_status === 'PENDING' ? ' (unverified)' : ''}`,
  })), [live])

  async function submit(e) {
    e.preventDefault()
    setError(null); setDone(null)
    if (!validPoint(point)) return setError(new Error('Click the spot on the map (or use your location) first.'))
    const h = parseNumber(hours, { min: HOURS_MIN, max: HOURS_MAX, label: 'Duration', unit: 'hours' })
    const r = parseNumber(radius, { min: RADIUS_MIN, max: RADIUS_MAX, label: 'Radius', unit: 'metres' })
    if (!reopened && h.error) return setError(new Error(h.error))
    if (r.error) return setError(new Error(r.error))
    const body = { event_type: type, lat: point.lat, lng: point.lng, road_name: roadName.trim(), description: description.trim() }
    if (!reopened && h.value !== undefined) body.hours = h.value
    if (r.value !== undefined) body.radius_m = r.value
    setBusy(true)
    try {
      const ev = await api('/road-events', { method: 'POST', json: body })
      setDone(reopened
        ? `Recorded. Any live blockage or closure within ${Math.round(ev.radius_m)} m of this point was marked resolved.`
        : `Recorded and verified. It stops counting at ${fmtWhen(ev.expires_at)} unless you extend or resolve it.`)
      setPoint(null); setRoadName(''); setDescription(''); setHours(''); setRadius(String(DEFAULT_RADIUS_M)); setPickerKey((k) => k + 1)
      onCreated()
    } catch (err) {
      if (err.status === 401) onUnauthorized()
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card ev-create" aria-label="Record an event">
      <button type="button" className="ev-create-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="ev-create-title"><Plus size={18} aria-hidden="true" /> <b>Record an event</b> <span className="muted small">Mark a road blocked, closed, flooded or under construction - or record that it has reopened</span></span>
        {open ? <ChevronUp size={20} aria-hidden="true" /> : <ChevronDown size={20} aria-hidden="true" />}
      </button>
      {done && !open && <div style={{ marginTop: 12 }}><Notice kind="ok">{done}</Notice></div>}
      {open && (
        <form className="ev-create-body" onSubmit={submit} noValidate>
          <div className="ev-create-grid">
            <div className="ev-create-map">
              <PointPicker key={pickerKey} value={point} onChange={setPoint} emoji={meta(type).emoji} color={reopened ? '#17a673' : '#e0342f'} height={320} extraOverlays={overlays} onViewportChange={setView} idPrefix="ev-new" hint="or click the spot on the map. Small markers are events already recorded here." />
            </div>
            <div className="ev-create-form">
              <div className="field">
                <label htmlFor="ev-type">Type</label>
                <select id="ev-type" value={type} onChange={(e) => setType(e.target.value)}>
                  {EVENT_TYPE_ORDER.map((t) => <option key={t} value={t}>{meta(t).emoji} {meta(t).label}</option>)}
                </select>
                <div className="hint">{TYPE_HELP[type]}</div>
              </div>
              <div className="field">
                <label htmlFor="ev-road">Road name (optional)</label>
                <input id="ev-road" className="input" maxLength={160} value={roadName} onChange={(e) => setRoadName(e.target.value)} placeholder="e.g. Anna Salai near the flyover" />
              </div>
              <div className="field">
                <label htmlFor="ev-desc">Description (optional)</label>
                <textarea id="ev-desc" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is happening and what should drivers expect?" style={{ minHeight: 84 }} />
              </div>
              <div className="ev-fields">
                <div className="field">
                  <label htmlFor="ev-hours">Lasts (hours)</label>
                  <input id="ev-hours" className="input" type="number" min={HOURS_MIN} max={HOURS_MAX} step="1" inputMode="numeric" value={hours} disabled={reopened} onChange={(e) => setHours(e.target.value)} placeholder={reopened ? 'not needed' : `default ${DEFAULT_HOURS[type]}`} />
                  <div className="hint">{reopened ? 'A reopening is a record, not a problem.' : `Default for this type: ${DEFAULT_HOURS[type]} h. Nothing is blocked for ever.`}</div>
                </div>
                <div className="field">
                  <label htmlFor="ev-radius">Radius (m)</label>
                  <input id="ev-radius" className="input" type="number" min={RADIUS_MIN} max={RADIUS_MAX} step="5" inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value)} />
                  <div className="hint">{BLOCKING_TYPES.includes(type) ? 'A route must pass this close to the point to be affected.' : 'How far around the point it applies.'}</div>
                </div>
              </div>
              <ErrorBox error={error} />
              {done && open && <Notice kind="ok">{done}</Notice>}
              <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Recording…' : reopened ? 'Record road reopened' : 'Record event'}</button>
            </div>
          </div>
        </form>
      )}
    </section>
  )
}
