import { ChevronUp, LocateFixed, Maximize2, Navigation, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlternativeCard, BlockedCard, Notice, UpdateCard } from './Cards'
import { TEXT, boundsFor, clockText, fmtDuration, fmtKm, fmtMeters } from './emergencyFormat'
import { buildIndex, progressAt, stepOffsets } from './geoNav'
import LiveStatus from './LiveStatus'
import Maneuver from './Maneuver'
import { DetailRows } from './RouteDetails'
import { RouteList } from './CompareScreen'

/**
 * Screen 6 (+ 7, 8, 9, 10 as they happen): the full-screen navigation overlay. The map is the page's own map (made full screen by CSS);
 * this draws the controls on top of it.
 *
 * The person's position arrives as `fix` (a real GPS fix, at most one per ~3 s, started only after they tapped Start). The fix is
 * snapped to the route line to get the remaining distance, the next step and "off route". Without a fix nothing is invented:
 * the route's own distance / time are shown and the turn card says it is waiting for a position.
 */

const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null

export default function LiveNav({
  route, destination, origin, result, mapRef, mapWrapRef, now,
  fix, watchError, tracking, onTracking,
  blocked, offer, notice, finding, checkFailed, lastChecked, refreshedAt, routeStatus, error,
  onEnd, onSwitch, onKeep, onRetry, onRecalcFrom, onDismissNotice,
  confirmEnd, onKeepNavigating, onConfirmEnd,
}) {
  const steps = useMemo(() => (route.steps_available ? route.steps || [] : []), [route])
  const idx = useMemo(() => buildIndex(route.geometry), [route.geometry])
  const offs = useMemo(() => (idx && steps.length ? stepOffsets(idx, steps) : []), [idx, steps])
  const prev = useRef(0)
  useEffect(() => { prev.current = 0 }, [idx])
  const prog = useMemo(() => (idx && fix ? progressAt(idx, offs, steps, fix, prev.current) : null), [idx, offs, steps, fix])
  useEffect(() => { if (prog && !prog.off) prev.current = prog.offset }, [fix]) // eslint-disable-line react-hooks/exhaustive-deps

  // off the route: two fixes in a row (one odd fix is only GPS noise)
  const [offCount, setOffCount] = useState(0)
  useEffect(() => { if (prog) setOffCount((n) => (prog.off ? n + 1 : 0)) }, [fix]) // eslint-disable-line react-hooks/exhaustive-deps
  const offRoute = offCount >= 2 && !finding

  const total = idx?.total ?? route.distance_km * 1000
  const remaining = prog ? prog.remaining_m : total
  const remMin = prog && idx && idx.total ? route.duration_min * (remaining / idx.total) : route.duration_min
  const eta = clockText(now + remMin * 60000)
  const progress = prog ? Math.round(prog.fraction * 100) : 0

  // the turn card
  const first = prog && prog.stepIndex === 0 && prog.offset < 30
  const turn = useMemo(() => {
    if (!steps.length || !prog) return null
    const step = first ? steps[0] : prog.next
    return step
      ? { maneuver: step.maneuver, instruction: step.instruction, dist: first ? 'Now' : fmtMeters(prog.next_m), key: `${step.index}-${step.instruction}` }
      : { maneuver: 'DESTINATION', instruction: `Arrive at ${destination.name || 'your destination'}`, dist: fmtMeters(prog.remaining_m), key: 'arrive' }
  }, [steps, prog, first, destination.name])

  // spoken instructions: only when the person turns the sound on, and only with the browser's own speech
  const [sound, setSound] = useState(false)
  const spoken = useRef('')
  useEffect(() => {
    if (!synth || !sound || !turn) return
    const text = `${turn.dist === 'Now' ? '' : `In ${turn.dist}, `}${turn.instruction}`
    if (spoken.current === turn.key) return
    spoken.current = turn.key
    synth.cancel()
    synth.speak(new SpeechSynthesisUtterance(text))
  }, [sound, turn])
  useEffect(() => { if (!sound) spoken.current = '' }, [sound])
  useEffect(() => () => { synth?.cancel() }, [])

  // follow the person on the map until they move it themselves; [recenter] follows again
  const [follow, setFollow] = useState(true)
  useEffect(() => { if (follow && fix) mapRef.current?.panTo({ lat: fix.lat, lng: fix.lng, zoom: 16 }) }, [follow, fix]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = mapWrapRef.current
    if (!el) return undefined
    const stop = (e) => { if (e.target.closest?.('.em-map')) setFollow(false) }
    el.addEventListener('pointerdown', stop, true)
    el.addEventListener('wheel', stop, { passive: true })
    return () => { el.removeEventListener('pointerdown', stop, true); el.removeEventListener('wheel', stop) }
  }, [mapWrapRef])

  const [statusOpen, setStatusOpen] = useState(false)
  const [routesOpen, setRoutesOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  // the alert appears: bring it into view
  const alertRef = useRef(null)
  const offerRef = useRef(null)
  useEffect(() => { if (blocked) alertRef.current?.focus({ preventScroll: false }) }, [!!blocked]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (offer && !blocked) offerRef.current?.focus({ preventScroll: false }) }, [offer?.route.label, !!blocked]) // eslint-disable-line react-hooks/exhaustive-deps
  const keepRef = useRef(null)
  useEffect(() => { if (confirmEnd) keepRef.current?.focus() }, [confirmEnd])

  const fitRoute = () => { mapRef.current?.fitTo(boundsFor([route], destination, fix)); setFollow(false) }
  const recenter = () => { if (fix) { mapRef.current?.panTo({ lat: fix.lat, lng: fix.lng, zoom: 16 }); setFollow(true) } }
  const kmh = fix && fix.speed != null ? Math.round(fix.speed * 3.6) : null

  const hasOffer = !!offer

  return (
    <div className="map-ui em-live-ui">
      <div className="em-live-top">
        {blocked && <BlockedCard ref={alertRef} blocked={blocked} finding={finding} hasOffer={hasOffer} error={error} onRetry={onRetry} compact live generatedAt={result?.generated_at} now={now} />}
        {blocked ? null : steps.length > 0 ? (
          <div className="em-turn" aria-live="polite">
            {turn ? (
              <>
                <span className="em-turn-ico"><Maneuver maneuver={turn.maneuver} size={40} /></span>
                <div className="em-turn-txt"><b>{turn.dist}</b><span>{turn.instruction}</span></div>
              </>
            ) : (
              <>
                <span className="em-turn-ico"><Navigation size={34} aria-hidden="true" /></span>
                <div className="em-turn-txt">
                  <b>Waiting for your position…</b>
                  <span>{tracking ? (watchError === 'denied' ? TEXT.gpsDenied : 'Turn-by-turn starts when a GPS position arrives.') : 'Turn-by-turn directions follow your live position.'}</span>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="em-turn is-plain">
            <span className="em-turn-ico"><Navigation size={32} aria-hidden="true" /></span>
            <div className="em-turn-txt"><b>Following the planned route</b><span>{TEXT.noTurns}</span></div>
          </div>
        )}
      </div>

      <div className="em-live-side">
        {synth && steps.length > 0 && (
          <button type="button" className="em-round" onClick={() => setSound((s) => !s)} aria-pressed={sound} aria-label={sound ? 'Turn spoken directions off' : 'Turn spoken directions on'}>
            {sound ? <Volume2 size={22} aria-hidden="true" /> : <VolumeX size={22} aria-hidden="true" />}
          </button>
        )}
        <button type="button" className="em-round" onClick={fitRoute} aria-label="Show the whole route" title="Show the whole route"><Maximize2 size={21} aria-hidden="true" /></button>
        {tracking && fix && <button type="button" className={`em-round${follow ? ' is-on' : ''}`} onClick={recenter} aria-label="Recenter on my position" aria-pressed={follow} title="Recenter on my position"><LocateFixed size={22} aria-hidden="true" /></button>}
        {kmh != null && <div className="em-speed" role="status" aria-label={`Speed ${kmh} kilometres per hour`}><b>{kmh}</b><span>km/h</span></div>}
      </div>

      <div className={`em-live-sheet${statusOpen ? ' is-wide' : ''}${offer ? ' has-offer' : ''}`}>
        {offer && (offer.blocked
          ? <AlternativeCard ref={offerRef} offer={offer} onUse={onSwitch} onViewRoutes={() => setRoutesOpen((o) => !o)} viewing={routesOpen} compact />
          : <UpdateCard ref={offerRef} offer={offer} notice={notice} onSwitch={onSwitch} onKeep={onKeep} onDetails={() => setDetailsOpen((o) => !o)} detailsOpen={detailsOpen}>
            {detailsOpen && <DetailRows route={offer.route} routes={result?.routes} />}
          </UpdateCard>)}
        {offer && offer.blocked && routesOpen && result && <RouteList result={result} selected={offer.route.label} onSelect={() => {}} now={now} activeLabel={route.label} />}
        {notice && !offer && <Notice title={notice.title} onDismiss={onDismissNotice}>{notice.text}</Notice>}
        {offRoute && (
          <div className="em-offroute" role="alert">
            <b>You are off the planned route.</b>
            <span>RoadMind can plan a new route from where you are now.</span>
            <button type="button" className="btn btn-small btn-primary" onClick={() => onRecalcFrom(fix)}>Recalculate from here</button>
          </div>
        )}
        {checkFailed && <Notice role="status">{TEXT.monitorFailed}</Notice>}
        {tracking && watchError === 'denied' && <Notice tone="warn" role="alert">{TEXT.gpsDenied}</Notice>}
        {!tracking && <button type="button" className="btn btn-small em-track" onClick={() => onTracking(true)}><LocateFixed size={15} aria-hidden="true" /> Track my position</button>}
        {statusOpen && <LiveStatus route={route} result={result} routeStatus={routeStatus} checkFailed={checkFailed} lastChecked={lastChecked} refreshedAt={refreshedAt} remaining_m={remaining} remaining_min={remMin} now={now} origin={origin} destination={destination} onClose={() => setStatusOpen(false)} tracking={tracking} />}
      </div>

      <div className="em-live-bottom">
        <div className="em-livebar">
          <div className="em-livebar-main">
            <b>{fmtDuration(remMin)}</b>
            <span>{fmtKm(remaining / 1000)} · ETA {prog ? '≈ ' : ''}{eta}</span>
            <small>{destination.name || 'Destination'}</small>
          </div>
          <button type="button" className="em-statusbtn" onClick={() => setStatusOpen((o) => !o)} aria-expanded={statusOpen} aria-label="Live status">
            <i className="em-dot" style={{ '--c': checkFailed ? '#f7762c' : '#17a673' }} aria-hidden="true" /> Live <ChevronUp size={16} aria-hidden="true" className={statusOpen ? 'is-open' : ''} />
          </button>
          <button type="button" className="em-end" onClick={onEnd}>End</button>
        </div>
        <div className="em-livebar-progress" role="progressbar" aria-label="Route progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>
      </div>

      {confirmEnd && (
        <div className="em-confirm" role="alertdialog" aria-modal="true" aria-labelledby="em-confirm-title">
          <div className="em-confirm-box">
            <h2 id="em-confirm-title">End the emergency route?</h2>
            <p>RoadMind will stop watching this route for closures and changes.</p>
            <div className="em-btnrow">
              <button type="button" className="btn btn-primary" onClick={onKeepNavigating} ref={keepRef}>Keep navigating</button>
              <button type="button" className="btn em-btn-danger" onClick={onConfirmEnd}>End route</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
