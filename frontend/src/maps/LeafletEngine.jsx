import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { FIT_MAX_ZOOM, FIT_PADDING, PART, badgeElement, cleanPath, createOverlayManager, rank } from './overlays'
import { useEngineSync } from './useEngineSync'

/**
 * The fallback engine: a Leaflet map on real OpenStreetMap raster tiles (a real-world road network - never RoadMind's
 * own database), used when there is no Google key or Google fails to load. Plain Leaflet in a ref (no react-leaflet).
 * Used by MapCanvas only.
 */

const VIEWPORT_DEBOUNCE_MS = 300

const viewportOf = (m) => {
  const b = m.getBounds()
  const c = m.getCenter()
  return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast(), zoom: m.getZoom(), center: { lat: c.lat, lng: c.lng } }
}

const tipNode = (text) => { const s = document.createElement('span'); s.textContent = text; return s } // textContent: tips may carry data

const LeafletEngine = forwardRef(function LeafletEngine(
  { tiles, center, zoom, restore, fit, pan, overlays, location, onReady, onViewport, onMapClick }, ref,
) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const handle = useRef({}) // { fitTo, panTo, mgr, markReady } for useEngineSync
  const cb = useRef({})
  cb.current = { onReady, onViewport, onMapClick }
  const [map, setMap] = useState(null)

  useImperativeHandle(ref, () => ({
    fitTo: (b) => !!mapRef.current && (handle.current.fitTo(b), true),
    panTo: (p) => !!mapRef.current && (handle.current.panTo(p), true),
    getViewport: () => (mapRef.current ? viewportOf(mapRef.current) : null),
  }), [])

  // Created one tick after mount: React StrictMode (dev) mounts, unmounts and mounts again at once, and a map built for
  // the first mount would only fire tile requests (at OpenStreetMap) that are cancelled a moment later.
  useEffect(() => {
    let teardown
    const timer = setTimeout(() => { teardown = createMap() }, 0)
    return () => { clearTimeout(timer); teardown?.() }

    function createMap() {
      const el = elRef.current
      if (!el || mapRef.current) return undefined // never two maps in one container
      const start = restore || { center, zoom }
      const m = L.map(el, {
        center: [start.center.lat, start.center.lng], zoom: start.zoom, zoomControl: false, maxZoom: tiles.max_zoom || 19, worldCopyJump: true,
        // one canvas for every line (thousands stay fast); `tolerance` makes thin lines easy to hit with a finger
        renderer: L.canvas({ padding: 0.5, tolerance: 6 }),
      })
      mapRef.current = m
      // referrerPolicy "origin": tile servers require a Referer, and only the site origin is sent
      L.tileLayer(tiles.url, { maxZoom: tiles.max_zoom || 19, attribution: tiles.attribution, referrerPolicy: 'origin' }).addTo(m)
      L.control.zoom({ position: 'bottomright' }).addTo(m) // added after the attribution, so it sits above it (like Google's zoom)

      let ready = false
      let debounce = null
      const emit = () => cb.current.onViewport?.(viewportOf(m))
      m.on('moveend', () => { if (ready) { clearTimeout(debounce); debounce = setTimeout(emit, VIEWPORT_DEBOUNCE_MS) } })
      m.on('click', (e) => cb.current.onMapClick?.({ lat: e.latlng.lat, lng: e.latlng.lng })) // overlays with a handler do not bubble to here

      // Overlays -> Leaflet layers. Interactive only when there is something to do on click or a tooltip to show.
      const manager = createOverlayManager({
        add(rec) {
          const o = rec.o
          const hasClick = !!o.onClick
          const interactive = hasClick || !!o.tip
          const base = { interactive, bubblingMouseEvents: !hasClick } // a tooltip-only overlay still lets the click reach the map
          const paths = [] // vector layers, restacked by rank
          let layer
          if (o.type === 'line') {
            const pts = cleanPath(o.path)
            if (o.outline) {
              paths.push({ rank: rank(o.z, PART.casing), layer: L.polyline(pts, { interactive: false, color: '#ffffff', weight: o.weight + 2, opacity: Math.min(1, o.opacity), lineCap: o.dashed ? 'butt' : 'round', lineJoin: 'round', dashArray: o.dashed ? `${o.weight * 2} ${o.weight * 2}` : null }).addTo(m) })
            }
            layer = L.polyline(pts, { ...base, color: o.color, weight: o.weight, opacity: o.opacity, lineCap: o.dashed ? 'butt' : 'round', lineJoin: 'round', dashArray: o.dashed ? `${o.weight * 2} ${o.weight * 2}` : null }).addTo(m)
            paths.push({ rank: rank(o.z, PART.line), layer })
          } else if (o.type === 'circle') {
            layer = L.circle([o.center.lat, o.center.lng], { ...base, radius: o.radius_m, color: o.color, weight: 1.5, opacity: 0.7, fillColor: o.color, fillOpacity: o.fillOpacity }).addTo(m)
            paths.push({ rank: rank(o.z, PART.circle), layer })
          } else {
            const icon = L.divIcon({ className: 'rm-map-pin-icon', html: badgeElement(o, hasClick), iconSize: [o.size, o.size], iconAnchor: [o.size / 2, o.size / 2] })
            layer = L.marker([o.position.lat, o.position.lng], { ...base, icon, zIndexOffset: o.z * 1000, keyboard: hasClick, alt: o.tip || o.text || o.emoji || '' }).addTo(m)
          }
          if (o.tip) layer.bindTooltip(tipNode(o.tip), { sticky: o.type !== 'marker', direction: 'top', offset: [0, o.type === 'marker' ? -o.size / 2 : -4], opacity: 0.96, className: 'rm-map-ltip' })
          if (hasClick) layer.on('click', (e) => { const cur = rec.o.onClick; if (cur) cur({ lat: e.latlng.lat, lng: e.latlng.lng }) })
          return { layer, paths }
        },
        remove(rec) {
          rec.h.paths.forEach((p) => p.layer.remove())
          rec.h.layer.remove()
        },
        // Vector layers have no zIndex: re-stack them by rank (higher z on top). Only when something was added or removed.
        changed(reg) {
          const all = []
          for (const rec of reg.values()) if (rec.h) all.push(...rec.h.paths)
          all.sort((a, b) => a.rank - b.rank)
          for (const p of all) p.layer.bringToFront()
          handle.current.accuracy?.bringToBack()
        },
      })

      handle.current = {
        mgr: manager,
        fitTo: (b) => m.fitBounds(b, { padding: [FIT_PADDING, FIT_PADDING], maxZoom: FIT_MAX_ZOOM, animate: ready }),
        panTo: (p) => m.setView([p.lat, p.lng], Math.max(m.getZoom(), p.zoom || 16), { animate: ready }),
        // after the first fit/pan of the page was applied, so the first viewport report is the one the user actually sees
        markReady() { if (ready) return; ready = true; cb.current.onReady?.(); emit() },
      }

      const ro = new ResizeObserver(() => m.invalidateSize())
      ro.observe(el)
      setMap(m)

      return () => {
        clearTimeout(debounce)
        ro.disconnect()
        manager.clear()
        m.remove()
        mapRef.current = null
        handle.current = {}
        setMap(null)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEngineSync(map, handle, { fit, pan, overlays, restore })

  // Declared after useEngineSync: effects run in order, so the first fit/pan/overlays are in place before "ready".
  useEffect(() => { if (map) handle.current.markReady?.() }, [map])

  // The user's location: a blue dot with an accuracy circle (neither takes clicks).
  useEffect(() => {
    if (!map || !location) return undefined
    const at = [location.lat, location.lng]
    const accuracy = L.circle(at, { interactive: false, radius: Math.min(location.accuracy || 0, 1500), weight: 1, opacity: 0.35, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.14 }).addTo(map)
    accuracy.bringToBack()
    handle.current.accuracy = accuracy
    const dot = L.marker(at, { interactive: false, keyboard: false, zIndexOffset: 100000, icon: L.divIcon({ className: 'rm-map-me-icon', html: '<div class="rm-map-me"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(map)
    return () => { accuracy.remove(); dot.remove(); if (handle.current.accuracy === accuracy) handle.current.accuracy = null }
  }, [map, location])

  return (
    <div className="rm-map-engine">
      <div className="rm-map-canvas" ref={elRef} />
    </div>
  )
})

export default LeafletEngine
