import L from 'leaflet'
import { LocateFixed } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { LayersControl, MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { api, useApi } from './api'
import { CONDITION_LABELS, MAJOR_ROADS, STATE_COLORS, num } from './format'

/**
 * The complete road network, always shown, with RoadMind's condition layer on top.
 *
 *   base layer   every road segment of the OpenStreetMap network (grey where RoadMind has no data -
 *                state UNKNOWN / "No Data", which is neither "good" nor "damaged")
 *   condition    segments RoadMind has data for are coloured Good / Moderate / High Risk / Critical
 *
 * Segments are loaded for the visible area, drawn on a canvas and are all clickable. `focusState` highlights one
 * state and DIMS the rest - it never removes a road. Pages draw routes / pins above the network in ROUTE_PANE.
 */

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const DEFAULT_TILES = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM_ATTR, max_zoom: 19 } // overridden by config/roadmind.yaml `map:`
const BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' // transparent 1px: draws the network on a plain background
const ZOOM_BUCKETS = [11, 13, 14, 15, 16] // zoom levels at which the server adds more minor roads
const bucket = (z) => ZOOM_BUCKETS.filter((t) => z >= t).length

function segmentStyle(seg, p, zoom) {
  const known = seg.state !== 'UNKNOWN'
  const major = MAJOR_ROADS.some((h) => seg.highway.startsWith(h))
  const k = zoom >= 17 ? 1.5 : zoom >= 15 ? 1.15 : zoom >= 13 ? 1 : 0.8
  const fade = p.dim ? 0.38 : 1
  const focus = p.focusState
  let style
  if (focus && seg.state !== focus) {
    style = { color: '#b7bfd9', weight: (major ? 3 : 2) * k, opacity: 0.55 * fade }
  } else if (known && p.showCondition) {
    style = { color: STATE_COLORS[seg.state], weight: (major ? 7 : 6) * k, opacity: 0.96 * fade }
  } else if (focus === 'UNKNOWN') {
    style = { color: '#64748b', weight: (major ? 5 : 3.6) * k, opacity: 0.95 * fade }
  } else {
    style = { color: known ? '#8791b5' : STATE_COLORS.UNKNOWN, weight: (major ? 4 : 2.6) * k, opacity: (known ? 0.9 : 0.8) * fade }
  }
  if (seg.id === p.selectedId) style = { ...style, color: focus && seg.state !== focus ? STATE_COLORS[seg.state] : style.color, weight: style.weight + 5, opacity: 1 }
  return { ...style, lineCap: 'round', lineJoin: 'round' }
}

function NetworkLayer({ showCondition, focusState, dim, selectedId, onSelect, onPick, reloadKey, onData, onStatus }) {
  const map = useMap()
  const live = useRef({})
  live.current = { showCondition, focusState, dim, selectedId, onSelect, onPick }
  const group = useRef(L.layerGroup())
  const dots = useRef(L.layerGroup())
  const layers = useRef(new Map()) // id -> { seg, line }
  const loaded = useRef(null)
  const ctl = useRef(null)
  const tip = useRef(L.tooltip({ direction: 'top', offset: [0, -4], opacity: 0.96, className: 'rm-tip' }))

  const restyle = useCallback(() => {
    const p = live.current
    const zoom = map.getZoom()
    for (const { seg, line } of layers.current.values()) line.setStyle(segmentStyle(seg, p, zoom))
    // condition on top of the grey base network; the focused state on top of the rest
    for (const { seg, line } of layers.current.values()) if (seg.state !== 'UNKNOWN' && (!p.focusState || seg.state === p.focusState)) line.bringToFront()
    for (const { seg, line } of layers.current.values()) if (p.focusState && seg.state === p.focusState && p.focusState === 'UNKNOWN') line.bringToFront()
    layers.current.get(p.selectedId)?.line.bringToFront()
  }, [map])

  const attach = useCallback((seg) => {
    const line = L.polyline(seg.geometry, segmentStyle(seg, live.current, map.getZoom()))
    line.on('mouseover', (e) => {
      const el = document.createElement('span')
      el.textContent = `${seg.name} · ${CONDITION_LABELS[seg.state]}` // textContent: road names come from external data
      tip.current.setContent(el).setLatLng(e.latlng)
      map.openTooltip(tip.current)
    })
    line.on('mousemove', (e) => tip.current.setLatLng(e.latlng))
    line.on('mouseout', () => map.closeTooltip(tip.current))
    line.on('click', (e) => {
      L.DomEvent.stopPropagation(e)
      map.closeTooltip(tip.current)
      live.current.onPick?.(e.latlng, seg)
      live.current.onSelect?.(seg, e.latlng)
    })
    return line
  }, [map])

  const load = useCallback(async (force = false) => {
    const zoom = Math.round(map.getZoom())
    const view = map.getBounds()
    const cur = loaded.current
    if (!force && cur && cur.bounds.contains(view) && cur.bucket === bucket(zoom)) return
    const box = view.pad(0.35)
    ctl.current?.abort()
    const ac = (ctl.current = new AbortController())
    onStatus({ loading: true })
    try {
      const qs = new URLSearchParams({ south: box.getSouth(), west: box.getWest(), north: box.getNorth(), east: box.getEast(), zoom })
      const res = await api(`/network?${qs}`, { signal: ac.signal })
      const next = new Set(res.segments.map((s) => s.id))
      for (const [id, rec] of layers.current) {
        if (!next.has(id)) { group.current.removeLayer(rec.line); layers.current.delete(id) }
      }
      for (const seg of res.segments) {
        const old = layers.current.get(seg.id)
        if (old && old.seg.state === seg.state && old.seg.report_count === seg.report_count) { old.seg = seg; continue }
        if (old) group.current.removeLayer(old.line)
        const line = attach(seg)
        group.current.addLayer(line)
        layers.current.set(seg.id, { seg, line })
      }
      dots.current.clearLayers()
      if (zoom >= 16) {
        for (const [lat, lng] of res.intersections) {
          L.circleMarker([lat, lng], { radius: 3, weight: 1.2, color: '#6b749c', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(dots.current)
        }
      }
      loaded.current = { bounds: box, bucket: bucket(zoom) }
      restyle()
      onData?.({ counts: res.counts, total: res.segments.length, truncated: res.truncated })
      onStatus({ loading: false, empty: res.segments.length === 0, truncated: res.truncated })
    } catch (err) {
      if (err.name === 'AbortError') return
      onStatus({ loading: false, error: err.message })
    }
  }, [map, attach, restyle, onData, onStatus])

  useEffect(() => {
    const g = group.current, d = dots.current
    g.addTo(map)
    d.addTo(map)
    load(true)
    return () => { ctl.current?.abort(); g.remove(); d.remove(); g.clearLayers(); layers.current.clear(); loaded.current = null }
  }, [map]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (reloadKey) { loaded.current = null; load(true) } }, [reloadKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { restyle() }, [showCondition, focusState, dim, selectedId, restyle])

  const timer = useRef(null)
  useMapEvents({
    moveend: () => { clearTimeout(timer.current); timer.current = setTimeout(() => load(false), 250) },
    zoomend: () => restyle(),
    click: (e) => live.current.onPick?.(e.latlng, null),
  })
  return null
}

/** Pane for things drawn ABOVE the road network (routes, pins). Pass pane={ROUTE_PANE} to react-leaflet vectors. */
export const ROUTE_PANE = 'routePane'
function Panes() {
  const map = useMap()
  if (!map.getPane(ROUTE_PANE)) map.createPane(ROUTE_PANE).style.zIndex = 450 // created during render so children can use it
  return null
}

function Fit({ bounds }) {
  const map = useMap()
  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 17 })
  }, [map, JSON.stringify(bounds)]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function Pan({ target }) {
  const map = useMap()
  useEffect(() => {
    if (target) map.setView([target.lat, target.lng], Math.max(map.getZoom(), target.zoom || 16))
  }, [map, target?.lat, target?.lng]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function Resizer() {
  const map = useMap()
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(map.getContainer())
    return () => ro.disconnect()
  }, [map])
  return null
}

/** A box that sits on the map without letting clicks/drags through to it. */
export function Overlay({ className, children, style }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) { L.DomEvent.disableClickPropagation(ref.current); L.DomEvent.disableScrollPropagation(ref.current) }
  }, [])
  return <div ref={ref} className={className} style={style}>{children}</div>
}

/** "Find me" button: asks the browser for the position only when clicked. */
export function LocateControl({ onError }) {
  const map = useMap()
  const dot = useRef(null)
  useEffect(() => {
    const found = (e) => {
      dot.current?.remove()
      dot.current = L.layerGroup([
        L.circle(e.latlng, { radius: Math.min(e.accuracy, 400), weight: 0, fillColor: '#5b3df5', fillOpacity: 0.12, interactive: false }),
        L.circleMarker(e.latlng, { radius: 8, weight: 3, color: '#fff', fillColor: '#5b3df5', fillOpacity: 1, interactive: false }),
      ]).addTo(map)
    }
    const failed = () => onError?.('Could not get your location. Allow location access in the browser, or search for a place instead.')
    map.on('locationfound', found)
    map.on('locationerror', failed)
    return () => { map.off('locationfound', found); map.off('locationerror', failed); dot.current?.remove() }
  }, [map, onError])
  return (
    <Overlay className="map-ui map-side">
      <button className="map-fab glass" onClick={() => map.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true })} aria-label="Show my location" title="Show my location">
        <LocateFixed size={20} />
      </button>
    </Overlay>
  )
}

function Status({ status, data, info, onImported }) {
  const map = useMap()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const known = data ? data.total - (data.counts.UNKNOWN || 0) : 0
  const canImport = info?.remote_import_enabled

  async function importView() {
    const b = map.getBounds()
    setBusy(true); setMsg(null)
    try {
      const res = await api('/network/import', { method: 'POST', json: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() } })
      setMsg(res.already_loaded ? 'This area is already loaded.' : `Loaded ${res.segments_added} road segments from OpenStreetMap.`)
      onImported()
    } catch (e) {
      setMsg(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay className="map-info">
      <div>
        {status.loading && !data ? 'Loading roads…' : data ? <><b>{num(data.total)}</b> roads loaded · <b>{num(known)}</b> with RoadMind data</> : '—'}
        {status.loading && data && <span className="muted"> · updating…</span>}
      </div>
      {status.truncated && <div className="small muted">Very many roads in view - zoom in to see them all.</div>}
      {status.error && <div className="small" style={{ color: '#a3191a' }}>{status.error}</div>}
      {canImport && (status.empty || msg) && (
        <div className="small" style={{ marginTop: 4 }}>
          {status.empty && <div>No road network is loaded for this view.</div>}
          {status.empty && <button className="rm-btn" disabled={busy} onClick={importView}>{busy ? 'Loading…' : 'Load roads for this view'}</button>}
          {msg && <div className="muted">{msg}</div>}
        </div>
      )}
      {canImport && !status.empty && !msg && data && (
        <button className="rm-link" disabled={busy} onClick={importView} title="Fetch any missing roads for this view from OpenStreetMap">{busy ? 'Loading…' : 'Load missing roads here'}</button>
      )}
    </Overlay>
  )
}

export default function NetworkMap({
  height = 520, showCondition = true, focusState = null, dim = false, selectedId, onSelect, onPick, bounds, pan, onData, reloadKey = 0, children,
  className = '', hideStatus = false, hideBadge = false,
}) {
  const info = useApi('/network/info')
  const [status, setStatus] = useState({ loading: true })
  const [data, setData] = useState(null)
  const [reload, setReload] = useState(reloadKey)
  const handleData = useCallback((d) => { setData(d); onData?.(d) }, [onData])
  const fit = bounds || (info.data?.bounds ? [[info.data.bounds[0], info.data.bounds[1]], [info.data.bounds[2], info.data.bounds[3]]] : null)
  const center = info.data?.center || [13.0735, 80.2645]
  const tiles = info.data?.tiles || DEFAULT_TILES

  return (
    <div className={`map-wrap ${className}`} style={{ height }}>
      <MapContainer center={center} zoom={15} maxZoom={19} scrollWheelZoom preferCanvas className="map" worldCopyJump>
        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="Base map (OpenStreetMap)">
            {/* referrerPolicy "origin": tile servers require a Referer, and only the site origin is sent */}
            <TileLayer key={tiles.url} url={tiles.url} maxZoom={tiles.max_zoom} attribution={tiles.attribution} referrerPolicy="origin" />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Roads only (no base map)">
            <TileLayer url={BLANK_TILE} maxZoom={19} attribution={OSM_ATTR} />
          </LayersControl.BaseLayer>
        </LayersControl>
        <Panes />
        <Resizer />
        {fit && <Fit bounds={fit} />}
        {pan && <Pan target={pan} />}
        <NetworkLayer
          showCondition={showCondition} focusState={focusState} dim={dim} selectedId={selectedId} onSelect={onSelect} onPick={onPick}
          reloadKey={reload} onData={handleData} onStatus={setStatus}
        />
        {children}
        {!hideStatus && <Status status={status} data={data} info={info.data} onImported={() => { info.reload(); setReload((r) => r + 1) }} />}
        {!hideBadge && info.data?.simulated_data && (
          <div className="map-badge" title="Roads and place names are real (OpenStreetMap). The condition data (reports, severity, risk) is generated for the demo.">
            Demo condition data is simulated
          </div>
        )}
      </MapContainer>
    </div>
  )
}
