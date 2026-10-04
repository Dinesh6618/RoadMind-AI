import { ArrowDownUp, Check, CheckCircle2, Circle, LocateFixed, MapPin, Navigation, Route as RouteIcon, SlidersHorizontal, Star } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleMarker, Polyline, Tooltip } from 'react-leaflet'
import { useSearchParams } from 'react-router-dom'
import { api, useApi } from '../api'
import { ConditionLegend, ErrorBox, Notice, Spinner } from '../components'
import { ROUTE_INK, ROUTE_LINE, STATE_COLORS, STATE_INK } from '../format'
import NetworkMap, { ROUTE_PANE } from '../NetworkMap'

const DAMAGE_STATE = { Low: 'GOOD', Moderate: 'MODERATE', High: 'HIGH_RISK', Severe: 'CRITICAL', Unknown: 'UNKNOWN' }
const RISK_WORD = { Low: 'Low Risk', Moderate: 'Moderate Risk', High: 'High Risk', Severe: 'Severe Risk', Unknown: 'Risk unknown' }

/** Preferences become route-score weights (distance / time / road-damage risk). */
function weightsFor({ avoid, shorter }, base) {
  if (shorter) return avoid ? { distance: 0.45, time: 0.25, damage_risk: 0.3 } : { distance: 0.6, time: 0.3, damage_risk: 0.1 }
  return avoid ? base : { distance: 0.4, time: 0.4, damage_risk: 0.2 }
}

function PlaceField({ label, tag, value, onChange, suggestions, picking, onPickToggle, locate }) {
  const [text, setText] = useState(value?.name || '')
  const [hits, setHits] = useState([])
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState(false)
  const box = useRef(null)
  useEffect(() => { setText(value?.name || ''); setTyped(false) }, [value?.name])
  useEffect(() => {
    if (!typed || text.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => api(`/routes/geocode?q=${encodeURIComponent(text.trim())}`).then(setHits).catch(() => setHits([])), 350)
    return () => clearTimeout(t)
  }, [text, typed])
  useEffect(() => {
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const options = typed && text.trim().length >= 2 ? hits : suggestions
  return (
    <div className="field place-input" ref={box}>
      <label htmlFor={`pf-${tag}`}>{label}</label>
      <div className="row nowrap-row" style={{ gap: 8 }}>
        <div className="input-icon" style={{ flex: 1 }}>
          <MapPin size={18} aria-hidden="true" style={{ color: tag === 'from' ? 'var(--ink)' : 'var(--brand)' }} />
          <input id={`pf-${tag}`} className="input" value={text} placeholder={tag === 'from' ? 'Where are you starting?' : 'Where are you going?'} autoComplete="off"
            onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setTyped(true); setOpen(true) }} />
        </div>
        {locate && <button type="button" className="btn btn-soft btn-icon" onClick={locate} aria-label="Use my current location" title="Use my current location"><LocateFixed size={18} /></button>}
        <button type="button" className={`btn btn-icon ${picking ? 'btn-primary' : ''}`} onClick={onPickToggle} aria-pressed={picking} aria-label={`Pick ${label.toLowerCase()} on the map`} title="Pick on the map"><MapPin size={18} /></button>
      </div>
      {open && options.length > 0 && (
        <div className="suggest" role="listbox">
          {options.map((p) => (
            <button type="button" key={`${p.name}${p.lat}`} onClick={() => { onChange({ name: p.name, lat: p.lat, lng: p.lng }); setOpen(false) }}>
              {p.name}<small>{p.source === 'osm' ? 'OpenStreetMap search' : p.kind}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Pref({ on, onChange, title, hint }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} className={`check ${on ? 'on' : ''}`} onClick={() => onChange(!on)} style={{ textAlign: 'left', font: 'inherit' }}>
      {on ? <CheckCircle2 size={22} style={{ color: 'var(--brand)', flex: 'none' }} aria-hidden="true" /> : <Circle size={22} style={{ color: '#b9b2dd', flex: 'none' }} aria-hidden="true" />}
      <span>{title}{hint && <small>{hint}</small>}</span>
    </button>
  )
}

const midpoint = (geom) => geom[Math.floor(geom.length / 2)]

export default function RoutePlanner() {
  const places = useApi('/routes/places')
  const [params] = useSearchParams()
  const [from, setFrom] = useState(null)
  const [to, setTo] = useState(null)
  const [picking, setPicking] = useState(null)
  const [prefs, setPrefs] = useState({ avoid: true, alts: true, shorter: false })
  const [custom, setCustom] = useState(null) // fine-tuned weights (percent), overrides the preset
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [selected, setSelected] = useState(null)
  const started = useRef(false)

  const suggestions = useMemo(() => (places.data?.places || []).map((p) => ({ ...p, source: 'network' })), [places.data])
  const base = places.data?.default_weights

  async function findRoutes(o = from, d = to, pf = prefs) {
    setError(null)
    if (!o || !d) return setError(new Error('Choose both a start and a destination.'))
    setBusy(true)
    try {
      const w = custom ? { distance: custom.distance / 100, time: custom.time / 100, damage_risk: custom.damage_risk / 100 } : weightsFor(pf, base)
      const res = await api('/routes/recommend', { method: 'POST', json: { origin: o, destination: d, weights: w } })
      setResult(res)
      setSelected(res.recommended)
    } catch (err) {
      setResult(null)
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  // Open with a meaningful trip: the one passed from a map card, else the demo's featured trip (run once).
  useEffect(() => {
    if (!places.data || started.current) return
    started.current = true
    const toLat = parseFloat(params.get('toLat')), toLng = parseFloat(params.get('toLng'))
    if (Number.isFinite(toLat) && Number.isFinite(toLng)) {
      setTo({ name: params.get('toName') || 'Selected road', lat: toLat, lng: toLng })
      return
    }
    const trip = places.data.suggested_trips?.[0]
    if (trip) { setFrom(trip.origin); setTo(trip.destination); findRoutes(trip.origin, trip.destination, prefs) }
  }, [places.data]) // eslint-disable-line react-hooks/exhaustive-deps

  function useMyLocation() {
    if (!navigator.geolocation) return setError(new Error('Your browser does not support location.'))
    navigator.geolocation.getCurrentPosition(
      (pos) => setFrom({ name: 'My location', lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setError(new Error('Could not get your location. Search for a place or pick it on the map.')),
      { timeout: 10000, enableHighAccuracy: true },
    )
  }

  function onMapPick(pt) {
    if (!picking) return
    const place = { name: `Pinned location (${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)})`, lat: pt.lat, lng: pt.lng }
    picking === 'from' ? setFrom(place) : setTo(place)
    setPicking(null)
  }

  const all = result?.routes || []
  const fastest = all.find((r) => r.is_fastest)
  const recommended = all.find((r) => r.recommendation === 'Recommended')
  const routes = prefs.alts ? all : all.filter((r) => r.recommendation === 'Recommended')
  const chosen = routes.find((r) => r.label === selected) || recommended

  const bounds = useMemo(() => {
    const pts = routes.flatMap((r) => r.geometry)
    if (!pts.length) return null
    const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1])
    return [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]]
  }, [result, prefs.alts]) // eslint-disable-line react-hooks/exhaustive-deps

  let verdict = null
  if (recommended) {
    if (recommended.is_fastest) verdict = result.summary
    else if (fastest) {
      const extra = recommended.distance_km - fastest.distance_km
      const rel = fastest.distance_km ? extra / fastest.distance_km : 0
      verdict = `${rel <= 0.25 ? 'Slightly longer' : 'Longer'} (${extra >= 0 ? '+' : ''}${extra.toFixed(1)} km) but safer, based on available road-condition data.`
    }
  }
  const drawOrder = [...routes].sort((a, b) => (a.label === selected) - (b.label === selected) || (a.recommendation === 'Recommended') - (b.recommendation === 'Recommended'))

  return (
    <div className="container page">
      <div className="page-head">
        <h1>Plan a Safer Route</h1>
        <p>Find the best route based on road condition, distance and travel time.</p>
      </div>

      <div className="route-layout">
        <div className="route-form stack">
          <div className="card">
            <PlaceField label="From" tag="from" value={from} onChange={setFrom} suggestions={suggestions} picking={picking === 'from'} onPickToggle={() => setPicking(picking === 'from' ? null : 'from')} locate={useMyLocation} />
            <div className="swap"><button type="button" onClick={() => { setFrom(to); setTo(from) }} aria-label="Swap start and destination"><ArrowDownUp size={18} /></button></div>
            <PlaceField label="To" tag="to" value={to} onChange={setTo} suggestions={suggestions} picking={picking === 'to'} onPickToggle={() => setPicking(picking === 'to' ? null : 'to')} />
            {picking && <Notice kind="info">Click a point on the map to set the {picking === 'from' ? 'start' : 'destination'}.</Notice>}

            <div className="prefs" role="group" aria-label="Preferences">
              <Pref on={prefs.avoid} onChange={(v) => { setCustom(null); setPrefs({ ...prefs, avoid: v }) }} title="Avoid high-risk roads" hint="Weigh road condition heavily when ranking routes" />
              <Pref on={prefs.alts} onChange={(v) => setPrefs({ ...prefs, alts: v })} title="Show alternative routes" hint="Compare more than just the best route" />
              <Pref on={prefs.shorter} onChange={(v) => { setCustom(null); setPrefs({ ...prefs, shorter: v }) }} title="Prefer shorter distance" hint="Give distance and travel time more weight" />
            </div>

            {base && (
              <details style={{ marginBottom: 18 }}>
                <summary style={{ cursor: 'pointer', fontWeight: 650, display: 'flex', alignItems: 'center', gap: 8 }}><SlidersHorizontal size={16} aria-hidden="true" /> Fine-tune the scoring</summary>
                <p className="small muted" style={{ margin: '10px 0' }}>How much each factor counts. Only the balance matters. Moving a slider replaces the preferences above.</p>
                {[['distance', 'Distance'], ['time', 'Travel time'], ['damage_risk', 'Road-damage risk']].map(([k, name]) => {
                  const w = custom || Object.fromEntries(Object.entries(weightsFor(prefs, base)).map(([a, v]) => [a, Math.round(v * 100)]))
                  return (
                    <div className="field" key={k} style={{ marginBottom: 8 }}>
                      <label htmlFor={`w-${k}`}>{name}: {w[k]}%</label>
                      <input id={`w-${k}`} type="range" min="0" max="100" value={w[k]} onChange={(e) => setCustom({ ...w, [k]: Number(e.target.value) })} />
                    </div>
                  )
                })}
                {custom && <button type="button" className="btn btn-small" onClick={() => setCustom(null)}>Back to preferences</button>}
              </details>
            )}

            <button className="btn btn-primary btn-lg btn-block" onClick={() => findRoutes()} disabled={busy}>
              <Navigation size={19} aria-hidden="true" /> {busy ? 'Comparing routes…' : 'Find Best Route'}
            </button>
          </div>
          <ErrorBox error={error} />
        </div>

        <div className="route-map-col">
          <NetworkMap height={620} dim={routes.length > 0} bounds={bounds} onPick={picking ? onMapPick : undefined}>
            {drawOrder.map((r) => {
              const rec = r.recommendation === 'Recommended'
              const on = r.label === selected
              const m = midpoint(r.geometry)
              return (
                <span key={r.label}>
                  <Polyline positions={r.geometry} pane={ROUTE_PANE} pathOptions={{ color: '#fff', weight: (rec ? 14 : 11) + (on ? 2 : 0), opacity: 0.95, lineCap: 'round', lineJoin: 'round' }} />
                  <Polyline positions={r.geometry} pane={ROUTE_PANE} pathOptions={{ color: ROUTE_LINE[r.recommendation], weight: (rec ? 9 : 6) + (on ? 2 : 0), opacity: 1, lineCap: 'round', lineJoin: 'round' }} eventHandlers={{ click: () => setSelected(r.label) }} />
                  <CircleMarker center={m} radius={1} pane={ROUTE_PANE} pathOptions={{ opacity: 0, fillOpacity: 0 }} interactive={false}>
                    <Tooltip permanent direction="top" offset={[0, -6]} className="route-tip">
                      <span className="route-label" style={{ background: ROUTE_LINE[r.recommendation] }}>{r.label.replace('Route ', '')} · {rec ? 'Recommended' : r.risk_percent != null ? `${r.risk_percent}% risk` : 'No data'}</span>
                    </Tooltip>
                  </CircleMarker>
                </span>
              )
            })}
            {from && <CircleMarker center={[from.lat, from.lng]} radius={9} pane={ROUTE_PANE} pathOptions={{ color: '#fff', weight: 3.5, fillColor: '#0f1a3c', fillOpacity: 1 }}><Tooltip permanent direction="left" offset={[-8, 0]} className="route-tip"><span className="route-label" style={{ background: '#0f1a3c' }}>Start</span></Tooltip></CircleMarker>}
            {to && <CircleMarker center={[to.lat, to.lng]} radius={9} pane={ROUTE_PANE} pathOptions={{ color: '#fff', weight: 3.5, fillColor: '#5b3df5', fillOpacity: 1 }}><Tooltip permanent direction="right" offset={[8, 0]} className="route-tip"><span className="route-label" style={{ background: '#5b3df5' }}>Destination</span></Tooltip></CircleMarker>}
          </NetworkMap>
          <div className="card stack-sm" style={{ marginTop: 16 }}>
            <ConditionLegend />
            <p className="small muted" style={{ margin: 0 }}>The whole network stays visible underneath. Grey roads have no RoadMind data: they are shown as No Data, and routes are neither rewarded nor penalised for them.</p>
          </div>
        </div>

        <div className="route-results stack">
          {busy && <div className="card"><Spinner label="Scoring routes against road conditions…" /></div>}
          {result && !busy && (
            <>
              <div className={`banner ${recommended?.risk_percent == null ? 'neutral' : ''}`}>
                <CheckCircle2 size={24} aria-hidden="true" />
                <div><b>{recommended ? `${recommended.label} is recommended` : 'No recommendation'}</b>{verdict}</div>
              </div>
              {result.warnings.map((w) => <Notice kind="warn" key={w}>{w}</Notice>)}

              <div className="route-cards">
              {routes.map((r) => {
                const rec = r.recommendation === 'Recommended'
                const st = DAMAGE_STATE[r.damage_level]
                return (
                  <article key={r.label} className={`route-card ${selected === r.label ? 'on' : ''} ${rec ? 'rec' : ''}`} style={{ '--c': ROUTE_LINE[r.recommendation], '--ink-c': ROUTE_INK[r.recommendation] }}
                    onClick={() => setSelected(r.label)} role="button" tabIndex={0} aria-pressed={selected === r.label}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setSelected(r.label)}>
                    <header>
                      <h3><span className="letter">{r.label.replace('Route ', '')}</span>{r.label}</h3>
                      <span className="route-pill">{rec && <Star size={14} aria-hidden="true" fill="currentColor" />}{rec ? 'Recommended' : r.recommendation === 'Avoid' ? 'High risk · avoid' : 'Alternative'}</span>
                    </header>
                    <div className="route-metrics">
                      <div><b>{r.distance_km} km</b><span>Distance</span></div>
                      <div><b>{Math.round(r.duration_min)} mins</b><span>Travel time</span></div>
                      <div><b style={{ color: STATE_INK[st] }}>{r.risk_percent != null ? `${r.risk_percent}%` : 'Unknown'}</b><span>{RISK_WORD[r.damage_level]}</span></div>
                    </div>
                    <div className="coverage" title="Share of this route (by length) that RoadMind has condition data for">
                      <div className="coverage-bar"><i style={{ width: `${Math.round(r.data_coverage * 100)}%`, background: STATE_COLORS[st] }} /></div>
                      <span className="small muted">Condition data on {Math.round(r.data_coverage * 100)}%{r.unknown_km > 0 ? ` · ${r.unknown_km} km no data` : ''}</span>
                    </div>
                    <p className="small" style={{ margin: '10px 0 0' }}>{r.reason}</p>
                  </article>
                )
              })}
              </div>

              <div className="card card-flush">
                <h3 style={{ padding: '20px 24px 0' }}>Route comparison</h3>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Route</th><th className="num">Distance</th><th className="num">Travel Time</th><th className="num">Road Risk</th><th>Recommendation</th></tr></thead>
                    <tbody>
                      {routes.map((r) => (
                        <tr key={r.label} className={`clickable ${selected === r.label ? 'selected' : ''}`} onClick={() => setSelected(r.label)}>
                          <td><b>{r.label}</b></td>
                          <td className="num">{r.distance_km} km</td>
                          <td className="num">{Math.round(r.duration_min)} mins</td>
                          <td className="num">{r.risk_percent != null ? `${r.risk_percent}%` : 'Unknown'}</td>
                          <td><span className="route-pill" style={{ '--c': ROUTE_LINE[r.recommendation], '--ink-c': ROUTE_INK[r.recommendation] }}>{r.recommendation}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="note" style={{ margin: 0 }}>{result.disclaimer} Routes come from {result.provider === 'network' ? "RoadMind's graph of the complete OpenStreetMap road network" : 'OpenStreetMap routing (OSRM)'}.</p>
            </>
          )}
          {!result && !busy && !error && (
            <div className="card empty"><RouteIcon size={40} aria-hidden="true" style={{ color: 'var(--brand)', opacity: 0.6 }} /><p style={{ marginTop: 10 }}>Choose a start and a destination to compare routes by distance, travel time and road condition.</p></div>
          )}
        </div>
      </div>
    </div>
  )
}
