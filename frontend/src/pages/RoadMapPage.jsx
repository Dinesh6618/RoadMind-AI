import { TriangleAlert, Info } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { STATE_COLORS } from '../format'
import { useHistoryLevel } from '../navHistory'
import MapCanvas from '../maps/MapCanvas'
import MapStatusBar from '../maps/MapStatusBar'
import { useMapConfig } from '../maps/useMapConfig'
import DetailDrawer from './roadmap/DetailDrawer'
import LayersBox from './roadmap/LayersBox'
import PlaceSearch from './roadmap/PlaceSearch'
import { hasGeocoder, reverseGeocodeRoad } from './roadmap/geocode'
import { eventAppliesToRoad, eventsNear, inBounds } from './roadmap/geo'
import { conditionOverlays, eventOverlays, highlightOverlay, pinOverlay } from './roadmap/overlays'
import { EventPanel, LookupPanel, NoDataPanel, RoadPanel } from './roadmap/panels'
import { resolveRoadItem } from './roadmap/roadItem'
import { useRoadMindData } from './roadmap/useRoadMindData'
import './roadmap.css'

const FILTERS = [[null, 'All'], ['GOOD', 'Good'], ['MODERATE', 'Moderate'], ['HIGH_RISK', 'High Risk'], ['CRITICAL', 'Critical']]
const NOTE_UNAVAILABLE = 'RoadMind condition data temporarily unavailable.'
const NOTE_EVENTS_UNAVAILABLE = 'RoadMind road events temporarily unavailable.'
const NOTE_EMPTY = 'No RoadMind condition data available in this area.'
const LOOKUP_TIMEOUT_MS = 8000

/**
 * The map page (/user/map, /admin/map, /maintenance/map).
 * The real-world road network and live traffic come from the map itself (Google Maps, or OpenStreetMap tiles without a
 * key). RoadMind only adds overlays on top - road condition lines and road events - so the map is complete with zero
 * RoadMind records and keeps working when the RoadMind API fails.
 * `portal` is "admin" or "maintenance" inside the staff portals (the map then fills the content area), null on the public map.
 */
export default function RoadMapPage({ portal = null }) {
  const staff = !!portal
  const [params] = useSearchParams()
  const auth = useAuth()
  const staffRole = portal || (auth?.isAdmin ? 'admin' : auth?.isMaintenance ? 'maintenance' : null)
  const { config } = useMapConfig()
  const mapRef = useRef(null)

  const [status, setStatus] = useState(null) // from MapCanvas.onStatus
  const [focus, setFocus] = useState(null) // condition filter chip
  const [showConditions, setShowConditions] = useState(true)
  const [showEvents, setShowEvents] = useState(true)
  const [selection, setSelection] = useState(null) // { kind: 'road'|'event'|'nodata'|'lookup', at, ... }
  const [drawer, setDrawer] = useState(null) // { id, item }
  const [searchPin, setSearchPin] = useState(null)

  const { cond, ev, load } = useRoadMindData(config.refresh_seconds)
  const itemsRef = useRef([])
  itemsRef.current = cond.items
  const lookup = useRef(null) // AbortController of the click lookup in flight

  // ------------------------------------------------------------------------------------------ what the person picked
  const openRoad = useCallback((item, at) => {
    lookup.current?.abort()
    setDrawer(null)
    setSelection({ kind: 'road', item, at: at || null })
  }, [])

  const openEvent = useCallback((event, at) => {
    lookup.current?.abort()
    setDrawer(null)
    setSelection({ kind: 'event', event, at: at || { lat: event.lat, lng: event.lng } })
  }, [])

  const close = useCallback(() => { lookup.current?.abort(); setSelection(null) }, [])

  // Road details are part of the browser history: the phone / browser Back button closes the details drawer, then the road panel,
  // and only then leaves the map (Home -> Map -> Road details: Back, Back, Back retraces it).
  useHistoryLevel(drawer ? 2 : selection ? 1 : 0, (level) => {
    if (level < 2) setDrawer(null)
    if (level < 1) { lookup.current?.abort(); setSelection(null) }
  })

  /** A click on the base map or a base road (not on a RoadMind overlay): is there a RoadMind road under it? */
  const onMapClick = useCallback(async (at) => {
    if (!at) return
    lookup.current?.abort()
    const ctl = new AbortController()
    lookup.current = ctl
    setDrawer(null)
    setSearchPin(null)
    setSelection({ kind: 'lookup', at })

    // A lookup that hangs must not leave "Checking this road…" on screen: after a while it ends as "unavailable".
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctl.abort() }, LOOKUP_TIMEOUT_MS)
    const cancelled = () => ctl.signal.aborted && !timedOut // the person clicked somewhere else
    let match = null
    let failed = false
    try {
      match = await api(`/network/match?lat=${at.lat}&lng=${at.lng}&radius=30`, { signal: ctl.signal })
    } catch (err) {
      if (cancelled() || (err?.name === 'AbortError' && !timedOut)) { clearTimeout(timer); return }
      failed = true
    }
    if (cancelled()) { clearTimeout(timer); return }

    if (!failed && match?.matched && match.state && match.state !== 'UNKNOWN') {
      try {
        const item = await resolveRoadItem(match.road_id, match.midpoint, itemsRef.current, ctl.signal)
        if (cancelled()) { clearTimeout(timer); return }
        if (item) { clearTimeout(timer); setSelection({ kind: 'road', item, at }); return }
      } catch (err) {
        if (cancelled() || (err?.name === 'AbortError' && !timedOut)) { clearTimeout(timer); return }
        failed = true
      }
    }
    clearTimeout(timer)
    if (timedOut) lookup.current = null // nothing left to cancel

    // No RoadMind condition data under this point: say so, never colour it good or damaged.
    const dbName = match?.matched && match.name && !/^unnamed/i.test(match.name) ? match.name : null
    const geocoder = hasGeocoder()
    setSelection({ kind: 'nodata', at, name: geocoder ? null : dbName, resolving: geocoder, unavailable: failed })
    if (!geocoder) return
    const googleName = await reverseGeocodeRoad(at.lat, at.lng, 1500)
    if (lookup.current !== ctl && !timedOut) return // another click replaced this one
    setSelection((s) => (s && s.kind === 'nodata' && s.at === at ? { ...s, name: googleName || dbName, resolving: false } : s))
  }, [])

  // Deep link from a report result: ?focus=<road id>&lat=&lng=   (the map itself starts centred there)
  const deep = useMemo(() => {
    const lat = parseFloat(params.get('lat')), lng = parseFloat(params.get('lng'))
    return { id: params.get('focus'), at: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!deep.id && !deep.at) return undefined
    const ctl = new AbortController()
    ;(async () => {
      try {
        const item = deep.id ? await resolveRoadItem(deep.id, deep.at, [], ctl.signal).catch((e) => { if (e?.name === 'AbortError') throw e; return null }) : null
        if (ctl.signal.aborted) return
        if (item) setSelection({ kind: 'road', item, at: deep.at })
      } catch { /* aborted */ }
    })()
    return () => ctl.abort()
  }, [deep])

  // Escape closes the drawer first, then the panel (the search box handles its own Escape and marks the event handled)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (drawer) setDrawer(null)
      else if (selection) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer, selection, close])

  // --------------------------------------------------------------------------------------------------- map overlays
  const selectedItem = selection?.kind === 'road' ? selection.item : null
  const selectedEventId = selection?.kind === 'event' ? selection.event.id : null
  const clickedAt = selection && (selection.kind === 'nodata' || selection.kind === 'lookup') ? selection.at : null

  const overlays = useMemo(() => {
    const out = []
    const halo = highlightOverlay(selectedItem)
    if (halo) out.push(halo)
    if (showConditions) out.push(...conditionOverlays(cond.items, focus, openRoad))
    if (showEvents) out.push(...eventOverlays(ev.items, selectedEventId, openEvent))
    if (clickedAt) out.push(pinOverlay('clicked', clickedAt))
    if (searchPin) out.push(pinOverlay('search', searchPin, '📍'))
    return out
  }, [cond.items, ev.items, focus, showConditions, showEvents, selectedItem, selectedEventId, clickedAt, searchPin, openRoad, openEvent])

  const onViewportChange = useCallback((vp) => load(vp), [load])
  const onPick = useCallback((p) => {
    setSearchPin({ lat: p.lat, lng: p.lng })
    mapRef.current?.panTo({ lat: p.lat, lng: p.lng, zoom: p.zoom })
  }, [])
  const pickFilter = (state) => { setFocus(state); setShowConditions(true) }

  // ------------------------------------------------------------------------------------------------- status + notices
  const blockedCount = ev.items.filter((e) => e.is_blocking).length
  const rmState = cond.state === 'error' || ev.state === 'error' ? 'error' : cond.state === 'loading' || ev.state === 'loading' ? 'loading' : 'ok'
  const roadmind = { state: rmState, count: cond.items.length, blocked: blockedCount, updatedAt: cond.updatedAt || ev.updatedAt }
  const note = cond.state === 'error' ? NOTE_UNAVAILABLE : ev.state === 'error' ? NOTE_EVENTS_UNAVAILABLE : cond.state === 'ok' && cond.items.length === 0 ? (cond.message || NOTE_EMPTY) : null
  const simulated = cond.simulated || config.simulated_data

  const center = useMemo(() => deep.at || undefined, [deep])
  const initialZoom = deep.at ? 17 : undefined

  // The selected event, kept fresh from the latest list (a snapshot when it has scrolled out of the fetched area)
  const liveEvent = selection?.kind === 'event' ? (ev.items.find((e) => e.id === selection.event.id) || selection.event) : null
  const eventEnded = !!(selection?.kind === 'event' && ev.state === 'ok' && inBounds(selection.event, ev.bounds) && !ev.items.some((e) => e.id === selection.event.id))
  const applying = useMemo(() => (selectedItem ? ev.items.filter((e) => eventAppliesToRoad(e, selectedItem)) : []), [selectedItem, ev.items])
  const fresh = selectedItem ? (cond.items.find((i) => i.id === selectedItem.id) || selectedItem) : null
  const nearby = useMemo(() => (selection?.kind === 'nodata' ? eventsNear(ev.items, selection.at) : []), [selection, ev.items])

  return (
    <div className={staff ? 'admin-map' : 'map-screen'}>
      <div className={`rm-stage${status?.engine === 'google' ? ' is-google' : ''}`}>
        <MapCanvas
          ref={mapRef} height="100%" overlays={overlays} initialCenter={center} initialZoom={initialZoom}
          onViewportChange={onViewportChange} onMapClick={onMapClick} onStatus={setStatus}
        >
          <div className="map-ui rm-top">
            <PlaceSearch onPick={onPick} />
            <div className="filter-pills glass" role="group" aria-label="Show RoadMind roads by condition">
              {FILTERS.map(([state, label]) => (
                <button
                  type="button" key={label} className={`chip ${focus === state ? 'on' : ''}`} onClick={() => pickFilter(state)} aria-pressed={focus === state}
                  title={state ? `${cond.counts[state] || 0} in the loaded area` : undefined}
                >
                  {state && <i style={{ '--c': STATE_COLORS[state] }} />}{label}
                </button>
              ))}
            </div>
            <LayersBox showConditions={showConditions} showEvents={showEvents} onConditions={setShowConditions} onEvents={setShowEvents} status={status} />
            {note && (
              <p className={`rm-note glass${cond.state === 'error' || ev.state === 'error' ? ' is-warn' : ''}`} role="status">
                {cond.state === 'error' || ev.state === 'error' ? <TriangleAlert size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}<span>{note}</span>
              </p>
            )}
            {simulated && <p className="rm-note rm-note--sim glass"><span>Demo condition data is simulated</span></p>}
          </div>

          <MapStatusBar status={status} roadmind={roadmind} className={selection ? 'rm-hide-sm' : ''} />

          {selection?.kind === 'lookup' && <LookupPanel key="lookup" onClose={close} />}
          {selection?.kind === 'road' && !drawer && (
            <RoadPanel key={`road-${fresh.id}`} item={fresh} applying={applying} status={status} at={selection.at} onClose={close} onDetails={(item) => setDrawer({ id: item.id, item })} onOpenEvent={(e) => openEvent(e)} />
          )}
          {selection?.kind === 'event' && <EventPanel key={`event-${liveEvent.id}`} ev={liveEvent} ended={eventEnded} staffRole={staffRole} onClose={close} />}
          {selection?.kind === 'nodata' && (
            <NoDataPanel key={`nodata-${selection.at.lat}-${selection.at.lng}`} at={selection.at} name={selection.name} resolving={selection.resolving} unavailable={selection.unavailable} nearby={nearby} onClose={close} onOpenEvent={(e) => openEvent(e)} />
          )}
        </MapCanvas>
      </div>

      {drawer && <DetailDrawer key={drawer.id} id={drawer.id} item={drawer.item} portal={portal} status={status} blocking={ev.items.filter((e) => e.is_blocking && eventAppliesToRoad(e, drawer.item))} onClose={() => setDrawer(null)} />}
    </div>
  )
}
