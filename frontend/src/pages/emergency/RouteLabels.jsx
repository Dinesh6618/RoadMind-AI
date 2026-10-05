import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pointAlong } from '../routes/routeScene'
import { fmtDuration, fmtKm, isUnavailable } from './emergencyFormat'
import { WORD, drawKind } from './scene'

/**
 * The floating route labels of the comparison map ("13 min · 5.1 km  Recommended"). MapCanvas has no way to draw a DOM label at a
 * map position, so these are placed here: the map's visible bounds (MapCanvas ref.getViewport) are projected with the same Web
 * Mercator maths both map engines use. While the person drags / zooms, the viewport is re-read every frame (and for a moment after),
 * so the labels follow the map; otherwise nothing runs.
 */

const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const LW = 124 // label box used for keeping labels from sitting on top of each other
const LH = 46
const BASE = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88]

/** { vp, w, h } of the map element, kept fresh while the map moves. `pulseKey` changes when something moved it (a fit, new routes). */
export function useProjection(mapRef, wrapRef, pulseKey) {
  const [st, setSt] = useState({ vp: null, w: 0, h: 0 })
  const until = useRef(0)
  const held = useRef(false)
  const raf = useRef(0)

  const read = useCallback(() => {
    const el = wrapRef.current
    const vp = mapRef.current?.getViewport?.()
    if (!el || !vp) return
    const r = el.getBoundingClientRect()
    setSt((o) => (o.vp && o.w === r.width && o.h === r.height && o.vp.south === vp.south && o.vp.north === vp.north && o.vp.west === vp.west && o.vp.east === vp.east ? o : { vp, w: r.width, h: r.height }))
  }, [mapRef, wrapRef])

  const loop = useCallback(() => {
    read()
    raf.current = held.current || performance.now() < until.current ? requestAnimationFrame(loop) : 0
  }, [read])

  const pulse = useCallback((ms = 800) => {
    until.current = Math.max(until.current, performance.now() + ms)
    if (!raf.current) raf.current = requestAnimationFrame(loop)
  }, [loop])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const down = () => { held.current = true; pulse(800) }
    const up = () => { held.current = false; pulse(700) }
    const wheel = () => pulse(900)
    const click = () => pulse(700)
    el.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: true })
    el.addEventListener('click', click, true)
    const ro = new ResizeObserver(() => pulse(300))
    ro.observe(el)
    return () => {
      el.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('click', click, true)
      ro.disconnect()
      cancelAnimationFrame(raf.current)
      raf.current = 0
    }
  }, [wrapRef, pulse])

  useEffect(() => { pulse(1400) }, [pulseKey, pulse]) // a fit / pan animation is running

  return { ...st, read }
}

function layout(routes, selected, hideLabel, vp, w, h) {
  if (!vp || !w || !h || !(vp.east > vp.west)) return []
  const yTop = merc(vp.north)
  const ySpan = yTop - merc(vp.south)
  if (!(ySpan > 0)) return []
  const project = (p) => ({ x: ((p[1] - vp.west) / (vp.east - vp.west)) * w, y: ((yTop - merc(p[0])) / ySpan) * h })
  const fits = (p) => p.x >= LW / 2 + 4 && p.x <= w - LW / 2 - 4 && p.y >= LH + 8 && p.y <= h - 10
  const placed = []
  const out = []
  const order = [...routes].filter((r) => r.label !== hideLabel && Array.isArray(r.geometry) && r.geometry.length > 1)
    .sort((a, b) => (b.label === selected) - (a.label === selected))
  order.forEach((r, i) => {
    const start = i % BASE.length
    let first = null
    let chosen = null
    for (let k = 0; k < BASE.length && !chosen; k++) {
      const f = BASE[(start + k) % BASE.length]
      const at = pointAlong(r.geometry, f)
      if (!at) continue
      const p = project(at)
      if (!fits(p)) continue
      if (!first) first = p
      const box = [p.x - LW / 2, p.y - LH - 8, p.x + LW / 2, p.y - 8]
      if (!placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) { placed.push(box); chosen = p }
    }
    const p = chosen || first
    if (p) out.push({ r, x: p.x, y: p.y })
  })
  return out
}

export default function RouteLabels({ routes, selected, hideLabel, onSelect, picking, mapRef, wrapRef, pulseKey }) {
  const { vp, w, h } = useProjection(mapRef, wrapRef, pulseKey)
  const items = useMemo(() => layout(routes, selected, hideLabel, vp, w, h), [routes, selected, hideLabel, vp, w, h])
  if (!items.length) return null
  return (
    <div className="map-ui em-labels" aria-hidden={picking ? 'true' : undefined}>
      {items.map(({ r, x, y }) => {
        const kind = drawKind(r, selected)
        const word = kind === 'rec' && r.status !== 'RECOMMENDED' ? 'Selected' : WORD[kind]
        const canPick = !picking && !isUnavailable(r)
        const body = (
          <>
            <b>{fmtDuration(r.duration_min)} · {fmtKm(r.distance_km)}</b>
            <span>{kind === 'bad' ? '✕ ' : ''}{word}</span>
          </>
        )
        const style = { left: `${x}px`, top: `${y}px` }
        return canPick ? (
          <button type="button" key={r.label} className={`em-rlabel is-${kind}`} style={style} onClick={() => onSelect(r.label)} aria-label={`${r.label}: ${word}, ${fmtDuration(r.duration_min)}, ${fmtKm(r.distance_km)}. Select this route`}>{body}</button>
        ) : (
          <div key={r.label} className={`em-rlabel is-${kind}`} style={style}>{body}</div>
        )
      })}
    </div>
  )
}
