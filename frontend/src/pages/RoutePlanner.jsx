import { ArrowDownUp, CheckCircle2, CircleHelp, Info, Navigation, Route as RouteIcon, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, useApi } from '../api'
import { ErrorBox, Notice, Spinner } from '../components'
import MapCanvas from '../maps/MapCanvas'
import EmergencyLink from './emergency/EmergencyLink'
import BlockedAlert from './routes/BlockedAlert'
import ComparisonTable from './routes/ComparisonTable'
import MapKey from './routes/MapKey'
import PlaceField from './routes/PlaceField'
import ResultStatus from './routes/ResultStatus'
import RouteCard from './routes/RouteCard'
import ScoreExplainer from './routes/ScoreExplainer'
import { fmtDuration, fmtKm, routeError, useNow } from './routes/routeFormat'
import { ROUTE_RED, boundsOf, buildOverlays, collectEvents, eventEmoji } from './routes/routeScene'
import './routeplanner.css'

const NoIcon = () => null // Notice always draws an icon; the server's message lines already start with an emoji
const MESSAGE_KINDS = { error: 'error', warn: 'warn', ok: 'ok', info: 'info' }
const stripEmoji = (s) => String(s || '').replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '').trim().toLowerCase()
// What the blocked-road card already says (so the message list does not repeat it).
const IN_ALERT = /road blocked ahead|lower-risk alternative found|avoids the reported blockage/i

export default function RoutePlanner() {
  const places = useApi('/routes/places')
  const [params] = useSearchParams()
  const [from, setFrom] = useState(null)
  const [to, setTo] = useState(null)
  const [picking, setPicking] = useState(null)
  const [alts, setAlts] = useState(true)
  const [busy, setBusy] = useState(false)
  const [finding, setFinding] = useState('compare') // what the busy state says: 'compare' | 'alt' (recalculating after a blocked-road alert)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [active, setActive] = useState(null) // the route label highlighted on the map / in the list
  const [view, setView] = useState(null) // the map's current viewport (for the live road events in view)
  const [liveEvents, setLiveEvents] = useState([])
  const [pan, setPan] = useState(null)
  const [announce, setAnnounce] = useState('')
  const [avoidOpen, setAvoidOpen] = useState(true)
  const [engine, setEngine] = useState(null) // 'google' | 'leaflet' once the map reports it
  const started = useRef(false)
  const reqId = useRef(0)
  const ctl = useRef(null)
  const mapRef = useRef(null)
  const mapWrap = useRef(null)
  const routesRef = useRef(null)
  const statusRef = useRef(null)
  const scrollAfter = useRef(false)
  const cardRefs = useRef({})

  const now = useNow(30000, !!result)
  const suggestions = useMemo(() => (places.data?.places || []).map((p) => ({ ...p, source: 'network' })), [places.data])

  // ------------------------------------------------------------------ calculation
  const findRoutes = useCallback(async (o, d, { fromAlert = false, refit = true } = {}) => {
    setError(null)
    if (!o || !d) { setError({ message: 'Choose both a start and a destination.' }); return }
    ctl.current?.abort()
    const c = new AbortController()
    ctl.current = c
    const id = ++reqId.current
    setFinding(fromAlert ? 'alt' : 'compare')
    setBusy(true)
    try {
      const res = await api('/routes/calculate', {
        method: 'POST', signal: c.signal,
        json: { origin: { lat: o.lat, lng: o.lng, name: o.name }, destination: { lat: d.lat, lng: d.lng, name: d.name } },
      })
      if (id !== reqId.current) return
      setResult(res)
      setActive(res.recommended)
      if (refit) mapRef.current?.fitTo(boundsOf(res.routes || [], res.origin, res.destination))
    } catch (err) {
      if (err.name === 'AbortError' || id !== reqId.current) return
      setResult(null)
      setError(routeError(err))
    } finally {
      if (id === reqId.current) setBusy(false)
    }
  }, [])

  useEffect(() => () => ctl.current?.abort(), [])

  // The map page's "plan a route around this event" link (?avoidLat&avoidLng&avoidName&avoidEvent): NO destination is set from it.
  // The map just shows the place, a note explains, and the user picks start and destination (so no demo trip is started either).
  const avLat = parseFloat(params.get('avoidLat'))
  const avLng = parseFloat(params.get('avoidLng'))
  const avoidName = params.get('avoidName') || ''
  const avoidEvent = params.get('avoidEvent') || ''
  const hasAvoid = Number.isFinite(avLat) && Number.isFinite(avLng)
  useEffect(() => {
    if (!hasAvoid) return
    started.current = true
    setAvoidOpen(true)
    setPan({ lat: avLat, lng: avLng, zoom: 15 })
  }, [hasAvoid, avLat, avLng, avoidName, avoidEvent])

  // A destination handed over from another page (?toLat&toLng&toName) pre-fills "To". "From" is only ever set by the user.
  const toLat = parseFloat(params.get('toLat'))
  const toLng = parseFloat(params.get('toLng'))
  const toName = params.get('toName')
  const hasDeep = Number.isFinite(toLat) && Number.isFinite(toLng)
  useEffect(() => {
    if (!hasDeep) return
    started.current = true // a chosen destination replaces the demo trip
    setTo({ name: toName || 'Selected road', lat: toLat, lng: toLng })
    setPan({ lat: toLat, lng: toLng, zoom: 15 })
  }, [hasDeep, toLat, toLng, toName])

  // Otherwise open with the demo's featured trip (once).
  useEffect(() => {
    if (!places.data || started.current) return
    started.current = true
    const trip = places.data.suggested_trips?.[0]
    if (trip) { setFrom(trip.origin); setTo(trip.destination); findRoutes(trip.origin, trip.destination) }
  }, [places.data, findRoutes])

  // ------------------------------------------------------------- live road events in view
  useEffect(() => {
    if (!view) return undefined
    const c = new AbortController()
    const t = setTimeout(() => {
      const q = new URLSearchParams({ south: view.south, west: view.west, north: view.north, east: view.east })
      api(`/road-events/active?${q}`, { signal: c.signal }).then((d) => setLiveEvents(Array.isArray(d?.items) ? d.items : [])).catch(() => { /* an optional overlay: keep what is drawn */ })
    }, 250)
    return () => { clearTimeout(t); c.abort() }
  }, [view, result?.generated_at])


  // On a phone the map and the answer are below the form: after the user asks for routes, bring the answer into view
  // (a blocked-road alert first - it has the button that shows the alternative on the map - otherwise the map).
  useEffect(() => {
    if (!result || busy || !scrollAfter.current) return
    scrollAfter.current = false
    if (!window.matchMedia('(max-width: 1180px)').matches) return
    const target = result.alert ? statusRef.current : mapWrap.current
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [result, busy])

  // ---------------------------------------------------------------------- inputs
  function choose(which, place) {
    which === 'from' ? setFrom(place) : setTo(place)
    setPan({ lat: place.lat, lng: place.lng, zoom: 15 })
  }

  function locateMe() {
    if (!navigator.geolocation) return setError({ message: 'Your browser does not support location.' })
    navigator.geolocation.getCurrentPosition(
      (pos) => choose('from', { name: 'My location', lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setError({ message: 'Could not get your location. Search for a place or pick it on the map.' }),
      { timeout: 10000, enableHighAccuracy: true },
    )
  }

  function onMapPick(pt) {
    if (!picking) return
    const place = { name: `Pinned location (${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)})`, lat: pt.lat, lng: pt.lng }
    picking === 'from' ? setFrom(place) : setTo(place)
    setPicking(null)
  }

  // --------------------------------------------------------------------- derived
  const all = result?.routes || []
  const recommended = all.find((r) => r.label === result?.recommended) || all.find((r) => r.status === 'RECOMMENDED')
  const routes = useMemo(() => (alts ? all : all.filter((r) => r.label === recommended?.label)), [result, alts]) // eslint-disable-line react-hooks/exhaustive-deps
  const activeLabel = routes.find((r) => r.label === active)?.label || recommended?.label || null

  const events = useMemo(() => collectEvents(all, liveEvents), [result, liveEvents]) // eslint-disable-line react-hooks/exhaustive-deps
  const avoidPin = useMemo(() => {
    if (!hasAvoid) return null
    const ev = liveEvents.find((e) => String(e.id) === avoidEvent)
    return { lat: avLat, lng: avLng, name: avoidName, emoji: ev ? eventEmoji(ev) : '🚧' }
  }, [hasAvoid, avLat, avLng, avoidName, avoidEvent, liveEvents])
  const overlays = useMemo(
    () => buildOverlays({
      routes, active: activeLabel, origin: from, destination: to, avoid: avoidPin, picking: !!picking, onSelect: setActive,
      events: avoidPin && avoidEvent ? events.filter((e) => String(e.id) !== avoidEvent) : events, // the pin already marks that event
    }),
    [routes, activeLabel, from, to, events, avoidPin, avoidEvent, picking],
  )
  const fit = useMemo(() => {
    if (routes.length) return boundsOf(routes, from, to)
    return from && to ? boundsOf([], from, to) : null
  }, [routes, from, to])

  const alert = result?.alert || null
  const trafficOn = !!result?.traffic?.available
  const allBlocked = !!alert && !alert.alternative
  const messages = useMemo(() => {
    if (!result) return []
    const trafficLine = stripEmoji(result.traffic?.message)
    return (result.messages || []).filter((m) => !(alert && IN_ALERT.test(m.text)) && !(trafficLine && stripEmoji(m.text) === trafficLine))
  }, [result, alert])

  // ------------------------------------------------------------------- actions
  const run = () => { scrollAfter.current = true; findRoutes(from, to, { fromAlert: !!result?.alert }) }
  const recalculate = () => result && findRoutes(result.origin, result.destination, { fromAlert: !!result.alert, refit: false })

  function select(label) {
    setActive(label)
  }

  function showRecommended() {
    if (!recommended) return
    setActive(recommended.label)
    mapRef.current?.fitTo(boundsOf([recommended]))
    cardRefs.current[recommended.label]?.focus({ preventScroll: true })
    mapWrap.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    setAnnounce(`${recommended.label} selected. The map now shows the recommended route.`)
  }

  function viewOtherRoutes() {
    setAlts(true)
    routesRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    const other = all.find((r) => r.label !== recommended?.label) || all[0]
    setTimeout(() => cardRefs.current[other?.label]?.focus({ preventScroll: true }), 0)
  }

  const providerNote = result?.provider === 'google' ? 'Routes and traffic: Google Maps' : 'Routes: OpenStreetMap-based RoadMind routing (no live traffic)'
  const summaryTone = allBlocked ? 'is-warn' : recommended?.risk == null ? 'is-neutral' : ''

  return (
    <div className="container page rp-page">
      <div className="page-head">
        <h1>Plan a Safer Route</h1>
        <p>Compare routes by live traffic, road condition, predicted risk and verified road blockages.</p>
      </div>

      <div className="route-layout rp-layout">
        <div className="route-form stack">
          <div className="card">
            {hasAvoid && avoidOpen && (
              <div className="alert alert-info rp-avoid" role="status">
                <Info size={18} aria-hidden="true" />
                <span>Planning around <b>{avoidName || 'the reported blockage'}</b>: pick your start and destination - RoadMind checks every route against verified road events and avoids a verified blockage.</span>
                <button type="button" onClick={() => setAvoidOpen(false)} aria-label="Dismiss this message"><X size={16} aria-hidden="true" /></button>
              </div>
            )}
            <PlaceField label="From" tag="from" value={from} onChange={(p) => choose('from', p)} suggestions={suggestions} picking={picking === 'from'} onPickToggle={() => setPicking(picking === 'from' ? null : 'from')} locate={locateMe} />
            <div className="swap"><button type="button" onClick={() => { setFrom(to); setTo(from) }} aria-label="Swap start and destination"><ArrowDownUp size={18} /></button></div>
            <PlaceField label="To" tag="to" value={to} onChange={(p) => choose('to', p)} suggestions={suggestions} picking={picking === 'to'} onPickToggle={() => setPicking(picking === 'to' ? null : 'to')} />
            {picking && <Notice kind="info">Click a point on the map to set the {picking === 'from' ? 'start' : 'destination'}.</Notice>}

            <label className={`check rp-alts${alts ? ' on' : ''}`}>
              <input type="checkbox" checked={alts} onChange={(e) => setAlts(e.target.checked)} />
              <span>Show alternative routes<small>Compare more than just the recommended route</small></span>
            </label>

            <ScoreExplainer weights={result?.weights} />

            <button type="button" className="btn btn-primary btn-lg btn-block" onClick={run} disabled={busy}>
              <Navigation size={19} aria-hidden="true" /> {busy ? (finding === 'alt' ? 'Finding an alternative route…' : 'Comparing routes…') : 'Find Best Route'}
            </button>
            <EmergencyLink dest={to} className="em-cta-block" />
          </div>
          <ErrorBox error={error} />
        </div>

        <div className="route-map-col" ref={mapWrap}>
          <div className="rp-map">
            <MapCanvas
              ref={mapRef} height="100%" traffic overlays={overlays} fit={fit} pan={pan}
              onViewportChange={setView} onStatus={(st) => setEngine(st.ready ? st.engine : null)} onMapClick={picking ? onMapPick : undefined} showLocate showTrafficToggle
            >
              <MapKey variant="overlay" routes={routes} activeLabel={activeLabel} onSelect={select} trafficOn={trafficOn} />
            </MapCanvas>
          </div>
          <MapKey variant="below" routes={routes} activeLabel={activeLabel} onSelect={select} trafficOn={trafficOn} />
          <ul className="rp-key" aria-label="Map symbols">
            <li><span className="rp-key-pin" style={{ '--c': ROUTE_RED }}>🚧</span>Verified blockage or closure</li>
            <li><span className="rp-key-pin" style={{ '--c': '#f7762c' }}>⚠️</span>Other verified event</li>
            <li><span className="rp-key-pin" style={{ '--c': '#f5a524' }}>?</span>Unverified community report</li>
          </ul>
          <p className="small muted rp-key-note">{engine ? `The map and its roads come from ${engine === 'google' ? 'Google Maps' : 'OpenStreetMap'}` : 'The map and its roads come from a real-world map provider'}; RoadMind adds road events, condition and risk on top. RoadMind never invents traffic: where it is unavailable, it says so.</p>
        </div>

        {(busy || result) && (
          <div className="rp-status stack" ref={statusRef}>
            {busy && <div className="card"><Spinner label={finding === 'alt' ? 'Finding an alternative route…' : 'Scoring routes against traffic, road conditions and blockages…'} /></div>}
            {result && !busy && (
              <>
                <ResultStatus result={result} now={now} busy={busy} onRecalculate={recalculate} />
                <BlockedAlert alert={alert} generatedAt={result.generated_at} now={now} onUseRecommended={showRecommended} onViewRoutes={viewOtherRoutes} />
                {recommended && (
                  <div className={`banner rp-banner ${summaryTone}`}>
                    {allBlocked ? <TriangleAlert size={24} aria-hidden="true" /> : <CheckCircle2 size={24} aria-hidden="true" />}
                    <div>
                      <b>{result.summary}</b>
                      {recommended.label} · {fmtKm(recommended.distance_km)} · {fmtDuration(recommended.duration_min)} · RoadMind risk {recommended.risk == null ? 'n/a' : `${Math.round(recommended.risk)}/100`}
                    </div>
                  </div>
                )}
                {messages.length > 0 && (
                  <div className="rp-messages">
                    {messages.map((m, i) => <Notice key={`${i}-${m.text}`} kind={MESSAGE_KINDS[m.kind] || 'info'} icon={NoIcon}>{m.text}</Notice>)}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="route-results stack" ref={routesRef}>
          {result && !busy && (
            <>
              <div className="route-cards rp-cards">
                {routes.map((r) => (
                  <RouteCard key={r.label} route={r} selected={r.label === activeLabel} onSelect={select} cardRef={(el) => { if (el) cardRefs.current[r.label] = el; else delete cardRefs.current[r.label] }} />
                ))}
              </div>
              <ComparisonTable routes={routes} selected={activeLabel} onSelect={select} />
              <p className="note rp-note">{result.disclaimer}</p>
              <p className="note rp-note"><CircleHelp size={14} aria-hidden="true" /> {providerNote}</p>
            </>
          )}
          {!result && !busy && !error && (
            <div className="card empty"><RouteIcon size={40} aria-hidden="true" style={{ color: 'var(--brand)', opacity: 0.6 }} /><p style={{ marginTop: 10 }}>Choose a start and a destination to compare routes by traffic, road condition and verified road blockages.</p></div>
          )}
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
    </div>
  )
}
