import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { FIT_MAX_ZOOM, FIT_PADDING, PART, badgeSvgUri, cleanPath, createOverlayManager, rank } from './overlays'
import { useEngineSync } from './useEngineSync'

/**
 * The Google Maps engine: the real road network comes from Google; RoadMind data is only drawn on top.
 * Classic google.maps.Marker (no mapId needed), Polyline, Circle and TrafficLayer. Used by MapCanvas only.
 */

const READY_FALLBACK_MS = 4000 // `tilesloaded` normally marks "ready"; if it never comes, do not hold the page's data back forever
const VIEWPORT_DEBOUNCE_MS = 300
const LOCATION_BLUE = '#2563eb'

const ll = (e) => (e?.latLng ? { lat: e.latLng.lat(), lng: e.latLng.lng() } : null)

function viewportOf(map) {
  const b = map.getBounds()
  const c = map.getCenter()
  if (!b || !c) return null
  const ne = b.getNorthEast(), sw = b.getSouthWest()
  return { south: sw.lat(), west: sw.lng(), north: ne.lat(), east: ne.lng(), zoom: map.getZoom(), center: { lat: c.lat(), lng: c.lng() } }
}

const GoogleEngine = forwardRef(function GoogleEngine(
  { gmaps, center, zoom, restore, fit, pan, overlays, trafficOn, location, onReady, onViewport, onMapClick, onFail }, ref,
) {
  const elRef = useRef(null)
  const tipRef = useRef(null)
  const mapRef = useRef(null)
  const handle = useRef({}) // { fitTo, panTo, mgr } for useEngineSync
  const trafficRef = useRef(null)
  const cb = useRef({})
  cb.current = { onReady, onViewport, onMapClick, onFail }
  const [map, setMap] = useState(null)

  useImperativeHandle(ref, () => ({
    fitTo: (b) => !!mapRef.current && (handle.current.fitTo(b), true),
    panTo: (p) => !!mapRef.current && (handle.current.panTo(p), true),
    getViewport: () => (mapRef.current ? viewportOf(mapRef.current) : null),
  }), [])

  // The map is created one tick after mount: React StrictMode (dev) mounts, unmounts and mounts again at once, and every
  // new google.maps.Map is a billable map load - this way only the second mount ever creates a map.
  useEffect(() => {
    let teardown
    const timer = setTimeout(() => { teardown = createMap() }, 0)
    return () => { clearTimeout(timer); teardown?.() }

    function createMap() {
      const el = elRef.current
      if (!el || mapRef.current) return undefined // never two maps in one container
      const tipEl = tipRef.current
      const start = restore || { center, zoom }
      let m
      try {
        m = new gmaps.Map(el, {
          center: start.center, zoom: start.zoom, mapTypeId: 'roadmap',
          mapTypeControl: true,
          mapTypeControlOptions: {
            mapTypeIds: ['roadmap', 'satellite', 'hybrid', 'terrain'],
            style: gmaps.MapTypeControlStyle.DROPDOWN_MENU, // compact on a phone; top right so the left stays free for a page's search box
            position: gmaps.ControlPosition.TOP_RIGHT,
          },
          zoomControl: true, fullscreenControl: true, streetViewControl: true, scaleControl: true,
          gestureHandling: 'greedy', clickableIcons: true,
        })
      } catch (err) { // e.g. Google refuses to start: hand over to the OpenStreetMap map instead of crashing the page
        cb.current.onFail?.(err)
        return undefined
      }
      mapRef.current = m

      // Tooltip for lines/circles: Google has none, so one small div follows the pointer.
      const pointer = { x: 0, y: 0 }
      const place = () => { tipEl.style.left = `${pointer.x}px`; tipEl.style.top = `${pointer.y}px` }
      const onMove = (e) => {
        const r = el.getBoundingClientRect()
        pointer.x = e.clientX - r.left
        pointer.y = e.clientY - r.top
        if (tipEl.classList.contains('is-on')) place()
      }
      el.addEventListener('pointermove', onMove, { capture: true, passive: true })
      const tooltip = {
        show(text) { tipEl.textContent = text; place(); tipEl.classList.add('is-on') }, // textContent: tips may carry data
        hide() { tipEl.classList.remove('is-on') },
      }

      // Overlays -> Google objects. Clickable only when there is something to do on click or a tooltip to show.
      const manager = createOverlayManager({
        add(rec) {
          const o = rec.o
          const interactive = !!(o.onClick || o.tip)
          const objs = []
          const click = (e) => {
            const at = ll(e) || (rec.o.type === 'marker' ? rec.o.position : null)
            if (rec.o.onClick) rec.o.onClick(at) // an overlay with its own handler never reaches onMapClick
            else cb.current.onMapClick?.(at) // a tooltip-only overlay behaves like the map under it
          }
          const hover = (obj) => {
            if (!o.tip) return
            obj.addListener('mouseover', () => tooltip.show(rec.o.tip))
            obj.addListener('mouseout', () => tooltip.hide())
          }
          if (o.type === 'line') {
            const path = cleanPath(o.path).map(([lat, lng]) => ({ lat, lng }))
            if (o.outline) {
              objs.push(new gmaps.Polyline({ map: m, path, clickable: false, strokeColor: '#ffffff', strokeOpacity: Math.min(1, o.opacity), strokeWeight: o.weight + 2, zIndex: rank(o.z, PART.casing) }))
            }
            const stroke = o.dashed
              // the documented dashed-polyline recipe: an invisible line carrying repeating dash symbols
              ? { strokeOpacity: 0, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: o.opacity, strokeColor: o.color, strokeWeight: o.weight, scale: o.weight }, offset: '0', repeat: `${Math.round(o.weight * 4)}px` }] }
              : { strokeColor: o.color, strokeOpacity: o.opacity, strokeWeight: o.weight }
            const line = new gmaps.Polyline({ map: m, path, clickable: interactive, zIndex: rank(o.z, PART.line), ...stroke })
            if (interactive) { line.addListener('click', click); hover(line) }
            objs.push(line)
          } else if (o.type === 'marker') {
            const full = o.size + 10 // the badge image carries 5px of padding for its shadow
            const mk = new gmaps.Marker({
              map: m, position: o.position, zIndex: o.z, clickable: interactive, title: o.tip || undefined, // native title tooltip + accessible name
              icon: { url: badgeSvgUri(o), scaledSize: new gmaps.Size(full, full), anchor: new gmaps.Point(full / 2, full / 2) },
            })
            if (interactive) mk.addListener('click', click)
            objs.push(mk)
          } else {
            const c = new gmaps.Circle({
              map: m, center: o.center, radius: o.radius_m, clickable: interactive, zIndex: rank(o.z, PART.circle),
              strokeColor: o.color, strokeOpacity: 0.7, strokeWeight: 1.5, fillColor: o.color, fillOpacity: o.fillOpacity,
            })
            if (interactive) { c.addListener('click', click); hover(c) }
            objs.push(c)
          }
          return objs
        },
        remove(rec) {
          tooltip.hide()
          for (const obj of rec.h || []) { gmaps.event.clearInstanceListeners(obj); obj.setMap(null) }
        },
      })

      const fitTo = ([[s, w], [n, e]]) => {
        m.fitBounds({ south: s, west: w, north: n, east: e }, FIT_PADDING)
        gmaps.event.addListenerOnce(m, 'idle', () => { if (m.getZoom() > FIT_MAX_ZOOM) m.setZoom(FIT_MAX_ZOOM) })
      }
      const panTo = (p) => {
        const target = Math.max(m.getZoom() || 0, p.zoom || 16)
        if (target !== m.getZoom()) { m.setZoom(target); m.setCenter({ lat: p.lat, lng: p.lng }) } else m.panTo({ lat: p.lat, lng: p.lng })
      }
      handle.current = { fitTo, panTo, mgr: manager }

      // "Ready" = Google drew its tiles (or 4 s passed). A bad key fires gm_authFailure instead and MapCanvas swaps the engine.
      let ready = false
      let debounce = null
      let fallback = null
      const emit = () => { const vp = viewportOf(m); if (vp) cb.current.onViewport?.(vp) }
      const markReady = () => {
        if (ready) return
        ready = true
        clearTimeout(fallback)
        cb.current.onReady?.()
        emit()
      }
      m.addListener('click', (e) => { cb.current.onMapClick?.(ll(e)) }) // base map, base roads and POI icons (overlays with a handler stop here)
      m.addListener('idle', () => { if (ready) { clearTimeout(debounce); debounce = setTimeout(emit, VIEWPORT_DEBOUNCE_MS) } })
      gmaps.event.addListenerOnce(m, 'tilesloaded', markReady)
      fallback = setTimeout(markReady, READY_FALLBACK_MS)

      trafficRef.current = new gmaps.TrafficLayer()
      setMap(m)

      return () => {
        clearTimeout(debounce)
        clearTimeout(fallback)
        el.removeEventListener('pointermove', onMove, { capture: true })
        manager.clear()
        trafficRef.current?.setMap(null)
        trafficRef.current = null
        gmaps.event.clearInstanceListeners(m)
        mapRef.current = null
        handle.current = {}
        el.innerHTML = '' // Google leaves its DOM behind; the next map (StrictMode remount) starts clean
        setMap(null)
      }
    }
  }, [gmaps]) // eslint-disable-line react-hooks/exhaustive-deps

  useEngineSync(map, handle, { fit, pan, overlays, restore })

  // Live traffic (Google only).
  useEffect(() => {
    if (map && trafficRef.current) trafficRef.current.setMap(trafficOn ? map : null)
  }, [map, trafficOn])

  // The user's location: a blue dot with an accuracy circle (neither takes clicks).
  useEffect(() => {
    if (!map || !location) return undefined
    const at = { lat: location.lat, lng: location.lng }
    const circle = new gmaps.Circle({
      map, center: at, radius: Math.min(location.accuracy || 0, 1500), clickable: false, zIndex: 1,
      strokeColor: LOCATION_BLUE, strokeOpacity: 0.35, strokeWeight: 1, fillColor: LOCATION_BLUE, fillOpacity: 0.14,
    })
    const dot = new gmaps.Marker({
      map, position: at, clickable: false, zIndex: 99999,
      icon: { path: gmaps.SymbolPath.CIRCLE, scale: 8, fillColor: LOCATION_BLUE, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3 },
    })
    return () => { circle.setMap(null); dot.setMap(null) }
  }, [map, location, gmaps])

  return (
    <div className="rm-map-engine">
      <div className="rm-map-canvas" ref={elRef} />
      <div className="rm-map-tip" ref={tipRef} aria-hidden="true" />
    </div>
  )
})

export default GoogleEngine
