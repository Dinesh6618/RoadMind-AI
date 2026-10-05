import { Navigation, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApi } from '../api'
import MapCanvas from '../maps/MapCanvas'
import { useHistoryLevel } from '../navHistory'
import { AlternativeCard, BlockedCard, Notice } from './emergency/Cards'
import { CompareTop, RouteLegend, RouteList, WhyBox } from './emergency/CompareScreen'
import CustomScreen from './emergency/CustomScreen'
import LiveNav from './emergency/LiveNav'
import MapKey from './emergency/MapKey'
import { NearbyList, NearbyTop, arrangePlaces } from './emergency/NearbyScreen'
import RouteDetails from './emergency/RouteDetails'
import RouteLabels from './emergency/RouteLabels'
import StartPanel from './emergency/StartPanel'
import StartScreen from './emergency/StartScreen'
import { KINDS, NEARBY_KINDS, TEXT, boundsFor, isUnavailable, matchRoute, offerFromAlert } from './emergency/emergencyFormat'
import { buildScene } from './emergency/scene'
import { ScreenHead } from './emergency/ui'
import { useActiveRoute } from './emergency/useActiveRoute'
import { useMapData, useNearby, useEmergencyRoute } from './emergency/useEmergencyData'
import { getPosition, useLiveWatch } from './emergency/useGeolocation'
import { useNow } from './routes/routeFormat'
import './emergency.css'
import './emergency/live.css'

const IN_ALERT = /road blocked ahead|alternative route found|lower-risk alternative found|avoids the reported blockage/i
const fmtAcc = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)
const originFor = (s) => ({ lat: s.lat, lng: s.lng, name: s.source === 'gps' ? 'My location' : s.name })

function useWide() {
  const q = '(min-width: 821px)'
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return wide
}

/**
 * /user/emergency-route - Emergency Route Mode. One page, several screens (levels of the browser history):
 *   0 options (hero + destination type + Use My Location)   1 nearby list / custom search   2 route comparison
 *   3 route details   4 live navigation (full screen).
 * GPS is requested only when the person taps (once per tap) and, for live navigation, after they tap Start. Nothing is invented:
 * places, routes, closures, traffic and times all come from the API; a missing piece is said to be missing.
 */
export default function EmergencyRoute() {
  const [params] = useSearchParams()
  const places = useApi('/routes/places')
  const suggestions = useMemo(() => (places.data?.places || []).map((p) => ({ ...p, source: 'network' })), [places.data])
  const wide = useWide()

  // ---- where / what
  const [start, setStart] = useState(null) // { lat, lng, name, source: 'gps' | 'search' | 'pin', accuracy? }
  const [locating, setLocating] = useState(false)
  const [gpsError, setGpsError] = useState(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [picking, setPicking] = useState(null) // 'from' | 'to' | null
  const [kind, setKind] = useState(null)
  const [dest, setDest] = useState(null) // { lat, lng, name, kind, address? }
  const [openNow, setOpenNow] = useState(false)
  const [nearest, setNearest] = useState(false)
  const [showMap, setShowMap] = useState(true)
  const [highlight, setHighlight] = useState(null)
  const [editingStart, setEditingStart] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [selected, setSelected] = useState(null)
  const [chip, setChip] = useState('rec')
  const [tracking, setTracking] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [eventInfo, setEventInfo] = useState(null)
  const [announce, setAnnounce] = useState('')
  const [nonce, setNonce] = useState(0)

  const mapRef = useRef(null)
  const mapWrapRef = useRef(null)
  const mapElRef = useRef(null)
  const bottomRef = useRef(null)
  const lastKey = useRef(null)

  const nearby = useNearby(kind, start)
  const route = useEmergencyRoute()
  const mapData = useMapData()
  const { result } = route
  const routes = useMemo(() => result?.routes || [], [result])

  const act = useActiveRoute({ request: route.request, setSelected })
  const { active } = act
  const live = useLiveWatch(!!active && tracking)
  const now = useNow(10000, true)

  // ---- which screen
  const view = active ? 'live' : showDetails && result ? 'details' : dest ? 'compare' : kind === 'custom' ? 'custom' : kind ? 'nearby' : 'options'
  const level = active ? (confirmEnd ? 3 : 4) : view === 'details' ? 3 : dest ? 2 : kind ? 1 : 0
  const goTo = (lvl) => {
    if (active) { setConfirmEnd(true); return } // Back never ends a route silently
    if (lvl < 3) setShowDetails(false)
    if (lvl < 2) { setDest(null); route.clear(); setPicking(null); setEditingStart(false); lastKey.current = null }
    if (lvl < 1) setKind(null)
  }
  useHistoryLevel(level, goTo)
  useEffect(() => { window.scrollTo({ top: 0 }) }, [view])

  // full-screen mode: the page's own header goes away (CSS), the bottom navigation stays, compact
  useEffect(() => {
    if (view !== 'live') return undefined
    document.body.classList.add('em-nav-mode')
    return () => document.body.classList.remove('em-nav-mode')
  }, [view])

  // ---- a destination handed over from the Route Planner (?toLat&toLng&toName): Custom Location, still waiting for a start
  useEffect(() => {
    const lat = parseFloat(params.get('toLat'))
    const lng = parseFloat(params.get('toLng'))
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    setKind('custom')
    setDest({ lat, lng, name: params.get('toName') || 'Selected place', kind: 'custom' })
    mapRef.current?.panTo({ lat, lng, zoom: 15 })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- GPS: one request per tap
  const locate = useCallback(async () => {
    setLocating(true)
    setGpsError(null)
    try {
      const p = await getPosition()
      setStart({ lat: p.lat, lng: p.lng, accuracy: p.accuracy, source: 'gps', name: `My location (±${fmtAcc(p.accuracy)})` })
      setManualOpen(false)
      mapRef.current?.panTo({ lat: p.lat, lng: p.lng, zoom: 14 })
    } catch (e) {
      setGpsError(e?.kind === 'denied' ? 'denied' : 'failed')
      setManualOpen(true)
    } finally { setLocating(false) }
  }, [])

  const chooseStart = useCallback((p) => {
    setStart({ lat: p.lat, lng: p.lng, name: p.name, source: 'search' })
    setGpsError(null)
    setEditingStart(false)
    setManualOpen(false)
    mapRef.current?.panTo({ lat: p.lat, lng: p.lng, zoom: 14 })
  }, [])

  const startPanel = (compact) => (
    <StartPanel
      start={start} locating={locating} gpsError={gpsError} onLocate={locate} manualOpen={manualOpen} onManual={() => setManualOpen((o) => !o)}
      onPlace={chooseStart} suggestions={suggestions} picking={picking === 'from'} onPickToggle={() => { setPicking((p) => (p === 'from' ? null : 'from')); mapWrapRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }}
      compact={compact}
    />
  )

  // ---- choosing
  const chooseKind = (k) => {
    setKind(k)
    setDest(null)
    route.clear()
    lastKey.current = null
    setOpenNow(false); setNearest(false); setHighlight(null); setShowMap(true); setPicking(null)
  }
  const selectPlace = (p) => { setDest({ lat: p.lat, lng: p.lng, name: p.name, address: p.address || null, kind }); setHighlight(null) }
  const chooseCustom = (p) => { setDest({ lat: p.lat, lng: p.lng, name: p.name, kind: 'custom' }); setPicking(null) }
  const onMapClick = useCallback((pt) => {
    const pinned = `Pinned location (${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)})`
    setPicking((cur) => {
      if (cur === 'from') setStart({ lat: pt.lat, lng: pt.lng, name: pinned, source: 'pin' })
      else if (cur === 'to') { setDest({ lat: pt.lat, lng: pt.lng, name: pinned, kind: 'custom' }); setKind('custom') }
      return null
    })
  }, [])
  const swap = () => {
    if (!start || !dest) return
    const s = start, d = dest
    setStart({ lat: d.lat, lng: d.lng, name: d.name, source: 'search' })
    setDest({ lat: s.lat, lng: s.lng, name: s.source === 'gps' ? 'My location' : s.name, kind: 'custom' })
    setKind('custom')
  }

  // ---- the route: calculated as soon as there is a start AND a destination (and again when either changes)
  const planKey = start && dest ? `${start.lat.toFixed(4)},${start.lng.toFixed(4)}>${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}#${nonce}` : null
  useEffect(() => {
    if (!planKey || active) return
    if (lastKey.current === planKey) return
    lastKey.current = planKey
    setShowDetails(false)
    ;(async () => {
      const res = await route.request({ origin: originFor(start), destination: { lat: dest.lat, lng: dest.lng, name: dest.name }, kind: dest.kind })
      if (!res) return
      setSelected(res.recommended || null)
      setChip(res.recommended ? 'rec' : 'all')
      mapRef.current?.fitTo(boundsFor(res.routes, start, dest))
      setAnnounce(res.recommended ? `${res.recommended} is recommended.` : 'No route is available: every route has a verified road closure.')
    })()
  }, [planKey, active]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!planKey) lastKey.current = null }, [planKey])

  // ---- derived from the answer
  const open = useMemo(() => routes.filter((r) => !isUnavailable(r)), [routes])
  const recommended = routes.find((r) => r.label === result?.recommended) || null
  const safer = useMemo(() => [...open].filter((r) => r.risk != null).sort((a, b) => a.risk - b.risk || a.duration_min - b.duration_min)[0] || null, [open])
  const fastest = useMemo(() => [...open].sort((a, b) => a.duration_min - b.duration_min)[0] || null, [open])
  const selectedRoute = open.find((r) => r.label === selected) || null

  const select = useCallback((label) => {
    setSelected(label)
    setChip((c) => (c === 'all' ? c : null))
    setAnnounce(`${label} selected.`)
  }, [])
  const onChip = (c) => {
    setChip(c)
    const pick = c === 'rec' ? recommended : c === 'safer' ? safer : c === 'fastest' ? fastest : null
    if (pick) { setSelected(pick.label); setAnnounce(`${pick.label} selected.`) }
    if (c === 'all') mapRef.current?.fitTo(boundsFor(routes, start, dest))
  }

  // ---- alerts before Start (the answer's own alert) - after Start the active-route hook owns them
  const planBlocked = result?.alert && !active
    ? { events: result.alert.blocked_by || [], message: result.alert.message, title: result.alert.title, headline: result.alert.headline, detail: result.alert.detail }
    : null
  const planOffer = useMemo(() => (active ? null : offerFromAlert(result)), [result, active])
  const messages = useMemo(() => (result?.messages || []).filter((m) => !(result.alert && IN_ALERT.test(m.text))), [result])

  // ---- the person starts / ends the route
  const startRoute = () => {
    if (!selectedRoute || !result) return
    act.start(selectedRoute, result)
    setTracking(start?.source === 'gps') // live position only when they started from "My location" (and so already allowed it)
    setConfirmEnd(false)
    setShowDetails(false)
    setEventInfo(null)
  }
  const endRoute = () => { act.end(); setTracking(false); setConfirmEnd(false); setShowDetails(false) }
  const keepNavigating = () => setConfirmEnd(false)
  useEffect(() => { if (active) mapRef.current?.fitTo(boundsFor([active.route], active.destination, start)) }, [active?.route.label && active?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the map
  const placesShown = useMemo(() => (kind && NEARBY_KINDS.has(kind) && nearby.data?.kind === kind ? arrangePlaces(nearby.data.items, { openNow, nearest }) : []), [kind, nearby.data, openNow, nearest])
  useEffect(() => {
    if (view !== 'nearby' || !nearby.data || !start || !placesShown.length) return
    mapRef.current?.fitTo(boundsFor([], start, ...placesShown))
  }, [view, nearby.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const oldPath = useMemo(() => {
    if (!active) return null
    const inResult = matchRoute(active.route.geometry, routes)
    if (act.offer && !act.offer.blocked) return active.route.geometry
    return inResult ? null : active.route.geometry
  }, [active, routes, act.offer])
  const oldLabel = useMemo(() => (active && act.offer && !act.offer.blocked ? matchRoute(active.route.geometry, routes)?.label || null : null), [active, routes, act.offer])
  const sceneRoutes = view === 'compare' || view === 'details' || view === 'live' ? routes : []
  const overlays = useMemo(() => buildScene({
    routes: sceneRoutes, selected, hideLabel: oldLabel, oldPath, picking: !!picking, onSelect: select,
    start, fix: active ? live.fix : null, dest: view === 'options' || view === 'nearby' || view === 'custom' ? (dest && view === 'custom' ? dest : null) : dest, kind,
    places: view === 'nearby' ? placesShown : [], highlight, onPlaceTap: setHighlight, events: mapData.events, conditions: mapData.conditions, onEventTap: setEventInfo,
  }), [sceneRoutes, selected, oldLabel, oldPath, picking, select, start, active, live.fix, dest, view, kind, placesShown, highlight, mapData.events, mapData.conditions])
  const showMapNow = wide || view !== 'options'
  const labelRoutes = view === 'compare' ? routes : view === 'details' ? (selectedRoute ? [selectedRoute] : []) : view === 'live' && act.offer ? routes : []

  // ---- focus: the result (or the alert) when it appears
  useEffect(() => {
    if (!result || route.busy || active) return
    const el = bottomRef.current?.querySelector('[role="alert"], [data-focus]') || bottomRef.current
    el?.focus?.({ preventScroll: true })
  }, [result?.query_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const pulseKey = `${result?.query_id || ''}-${view}-${selected || ''}`
  const reportHref = `/user/report${start && Number.isFinite(start.lat) ? `?lat=${start.lat.toFixed(6)}&lng=${start.lng.toFixed(6)}` : ''}`
  const trafficOn = !!result?.traffic?.available

  // ===================================================================================== screens
  const nearbyPrompt = !start && (
    <div className="em-card em-prompt" role="status">
      <b>Where are you?</b>
      <p>Use your location or search for a starting place first - RoadMind then lists the nearest {KINDS[kind]?.plural || 'places'} with real distances.</p>
    </div>
  )

  let top = null
  let bottom = null
  if (view === 'options') {
    top = (<><StartScreen kind={kind} onKind={chooseKind} />{startPanel(false)}</>)
    bottom = <Link className="btn btn-small em-report" to={reportHref}><TriangleAlert size={15} aria-hidden="true" /> 🚧 Report a road problem</Link>
  } else if (view === 'nearby') {
    top = (
      <>
        <NearbyTop kind={kind} items={nearby.data?.kind === kind ? nearby.data.items : []} openNow={openNow} nearest={nearest} showMap={showMap} onOpenNow={() => setOpenNow((o) => !o)} onNearest={() => setNearest((o) => !o)} onToggleMap={() => setShowMap((s) => !s)} />
        {!start && startPanel(false)}
      </>
    )
    bottom = nearbyPrompt || (
      <div className="em-bottom-inner">
        {startPanel(true)}
        <NearbyList kind={kind} nearby={nearby} places={placesShown} highlight={highlight} onSelect={selectPlace} onRetry={nearby.reload} onCustom={() => chooseKind('custom')} filtered={openNow} />
      </div>
    )
  } else if (view === 'custom') {
    top = (<><CustomScreen dest={dest} onChoose={chooseCustom} suggestions={suggestions} picking={picking === 'to'} onPickToggle={() => { setPicking((p) => (p === 'to' ? null : 'to')); mapWrapRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }} />{startPanel(!!start)}</>)
    bottom = nearbyPrompt
  } else if (view === 'compare' || view === 'details') {
    const needStart = !start
    if (view === 'details' && selectedRoute) {
      top = <ScreenHead title="Route Details" />
    } else {
      top = needStart ? (
        <>
          <ScreenHead title="Emergency Route" />
          <div className="em-card em-prompt" role="status"><b>To: {dest.name}</b><p>Now tell RoadMind where you are starting from to calculate the route.</p></div>
          {startPanel(false)}
        </>
      ) : (
        <CompareTop
          start={start} dest={dest} onSwap={swap} busy={!!route.busy}
          onEditStart={() => setEditingStart((e) => !e)} onEditDest={() => { setDest(null); route.clear(); lastKey.current = null }}
          chip={chip} onChip={onChip} hasRec={!!recommended} hasSafer={!!safer} hasFastest={!!fastest}
          alert={planBlocked && result && <BlockedCard blocked={planBlocked} finding={route.busy === 'alt'} hasOffer={!!planOffer} compact={!!planOffer} generatedAt={result.generated_at} now={now} />}
        >
          {editingStart && startPanel(true)}
        </CompareTop>
      )
    }

    const unavailableNote = result && !open.length
    const notices = messages.length > 0 && (
      <div className="em-notices">{messages.map((m, i) => <Notice key={`${i}-${m.text}`} tone={m.kind === 'error' ? 'bad' : m.kind === 'warn' ? 'warn' : m.kind === 'ok' ? 'good' : 'info'}>{m.text}</Notice>)}</div>
    )
    const foot = result && (
      <>
        <p className="em-disclaimer">{result.disclaimer}</p>
        <p className="em-advice">{TEXT.advice}</p>
        <p className="em-foot">{result.provider === 'google' ? 'Routes and traffic: Google Maps.' : 'Routes: OpenStreetMap-based RoadMind routing. Live traffic is unavailable.'}</p>
        <Link className="btn btn-small em-report" to={reportHref}><TriangleAlert size={15} aria-hidden="true" /> 🚧 Report a road problem</Link>
      </>
    )

    if (needStart) bottom = null
    else if (route.busy === 'route' && !result) bottom = <div className="em-card em-loading" role="status"><span className="em-spin" aria-hidden="true" /> Scoring routes against traffic, road conditions and verified closures…</div>
    else if (route.error && !result) {
      bottom = (
        <div className="em-card em-error" role="alert">
          <b>{route.error}</b>
          <div className="em-row"><button type="button" className="btn btn-small" onClick={() => { lastKey.current = null; setNonce((n) => n + 1) }}>Try again</button></div>
        </div>
      )
    } else if (result && view === 'details' && selectedRoute) {
      bottom = (
        <div ref={bottomRef} tabIndex={-1} data-focus className="em-bottom-inner" aria-live="polite">
          <RouteDetails route={selectedRoute} routes={routes} isRec={selectedRoute.label === result.recommended} avoidsClosure={result.alert?.alternative?.label === selectedRoute.label} summary={result.summary} />
          {notices}
          <button type="button" className="btn btn-primary btn-lg btn-block em-start em-start-inline" onClick={startRoute}><Navigation size={20} aria-hidden="true" /> 🚨 Start Emergency Route</button>
          {foot}
        </div>
      )
    } else if (result) {
      bottom = (
        <div ref={bottomRef} tabIndex={-1} data-focus className="em-bottom-inner" aria-live="polite">
          {planOffer && <AlternativeCard offer={planOffer} onUse={() => select(planOffer.route.label)} onViewRoutes={() => bottomRef.current?.querySelector('.em-routes')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />}
          <RouteLegend />
          <WhyBox result={result} now={now} />
          {unavailableNote && (
            <div className="em-card em-nonerec" role="alert">
              <b>No recommended route</b>
              <p>{result.alert?.detail || 'Every route RoadMind found has a verified road closure, so none is recommended.'}</p>
              <p className="small">{TEXT.advice}</p>
            </div>
          )}
          {selectedRoute && <button type="button" className="btn btn-lg btn-block em-details-btn" onClick={() => setShowDetails(true)}>View Route Details</button>}
          <RouteList result={result} selected={selected} onSelect={select} now={now} />
          {notices}
          {selectedRoute && <button type="button" className="btn btn-primary btn-lg btn-block em-start em-start-inline" onClick={startRoute}><Navigation size={20} aria-hidden="true" /> 🚨 Start Emergency Route</button>}
          {foot}
        </div>
      )
    }
  }

  const stickyStart = (view === 'compare' || view === 'details') && result && selectedRoute && !active
  const liveNode = view === 'live' && active && (
    <LiveNav
      route={active.route} destination={active.destination} origin={active.origin} result={result} mapRef={mapRef} mapWrapRef={mapWrapRef} now={now}
      fix={live.fix} watchError={live.error} tracking={tracking} onTracking={setTracking}
      blocked={act.blocked} offer={act.offer} notice={act.notice} finding={act.finding} checkFailed={act.checkFailed} lastChecked={act.lastChecked} refreshedAt={act.refreshedAt} routeStatus={act.routeStatus} error={route.error}
      onEnd={() => setConfirmEnd(true)} onSwitch={act.switchToOffer} onKeep={act.keepCurrent} onRetry={act.retry} onRecalcFrom={act.recalcFrom} onDismissNotice={act.dismissNotice}
      confirmEnd={confirmEnd} onKeepNavigating={keepNavigating} onConfirmEnd={endRoute}
    />
  )

  return (
    <div className={`container page em-page is-${view}`}>
      <div className={`em-layout is-${view}${view === 'nearby' && !showMap ? ' no-map' : ''}`}>
        <div className="em-top">{top}</div>

        <div className={`em-mapcol${view === 'live' ? ' is-live' : ''}`} ref={mapWrapRef}>
          {showMapNow && (
            <div className="em-map" ref={mapElRef}>
              <MapCanvas ref={mapRef} height="100%" traffic overlays={overlays} onViewportChange={mapData.onViewport} onMapClick={picking ? onMapClick : undefined} showLocate={false} showTrafficToggle>
                <RouteLabels routes={labelRoutes} selected={selected} hideLabel={oldLabel} onSelect={select} picking={!!picking} mapRef={mapRef} wrapRef={mapElRef} pulseKey={pulseKey} />
              </MapCanvas>
            </div>
          )}
          {view !== 'live' && (
            <div className="em-mapnotes">
              {picking && <p className="em-pickhint" role="status">Tap a point on the map to set the {picking === 'from' ? 'starting point' : 'destination'}.</p>}
              {mapData.failed && <p className="em-datanote" role="status">{TEXT.dataUnavailable}</p>}
              {eventInfo && (
                <div className="em-eventinfo" role="status">
                  <b>{eventInfo.emoji} {eventInfo.headline || eventInfo.event_type_label}</b>
                  <span>{eventInfo.road_name ? `${eventInfo.road_name} · ` : ''}{eventInfo.verified || eventInfo.is_blocking ? 'verified by authorised staff' : 'unverified community report'}</span>
                  <button type="button" onClick={() => setEventInfo(null)} aria-label="Dismiss">×</button>
                </div>
              )}
              <MapKey destKind={dest?.kind || kind} trafficOn={trafficOn} defaultOpen={wide} />
            </div>
          )}
          {liveNode}
        </div>

        <div className="em-bottom">{bottom}</div>
      </div>

      {stickyStart && (
        <div className="em-sticky">
          <button type="button" className="btn btn-primary btn-lg btn-block em-start" onClick={startRoute}><Navigation size={20} aria-hidden="true" /> 🚨 Start Emergency Route</button>
          <small>{selectedRoute.label !== result.recommended ? `${selectedRoute.label} selected (your choice). ` : ''}{TEXT.advice}</small>
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
    </div>
  )
}
