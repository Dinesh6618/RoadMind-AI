/**
 * Engine-independent overlay helpers shared by the Google and the Leaflet map: defaults, the cheap change signature,
 * the id-keyed diff, draw-order ranks and the round marker badge.
 *
 * Overlay shapes (everything but type/id/geometry is optional):
 *   { type:'line',   id, path:[[lat,lng],...], color, weight, opacity, dashed, outline, z, onClick, tip }
 *   { type:'marker', id, position:{lat,lng}, emoji, text, color, size, z, onClick, tip }
 *   { type:'circle', id, center:{lat,lng}, radius_m, color, fillOpacity, z, onClick, tip }
 */

export const FIT_PADDING = 40 // px kept free around a fitted area
export const FIT_MAX_ZOOM = 17 // fitting a single point must not zoom into the tiles' last level
export const BRAND = '#5b3df5'

const num = (v) => typeof v === 'number' && Number.isFinite(v)

/** Apply the defaults. Returns null for an overlay that cannot be drawn (unknown type, no id, bad geometry). */
export function normalizeOverlay(o) {
  if (!o || o.id == null) return null
  if (o.type === 'line') {
    if (!Array.isArray(o.path) || o.path.length < 2) return null
    return {
      ...o, color: o.color || BRAND, weight: o.weight ?? 5, opacity: o.opacity ?? 0.95,
      dashed: !!o.dashed, outline: o.outline !== false, z: o.z ?? 1,
    }
  }
  if (o.type === 'marker') {
    if (!o.position || !num(o.position.lat) || !num(o.position.lng)) return null
    return { ...o, color: o.color || BRAND, size: o.size ?? 34, z: o.z ?? 5 }
  }
  if (o.type === 'circle') {
    if (!o.center || !num(o.center.lat) || !num(o.center.lng) || !(o.radius_m > 0)) return null
    return { ...o, color: o.color || BRAND, fillOpacity: o.fillOpacity ?? 0.18, z: o.z ?? 0 }
  }
  return null
}

/** A line's points without anything that would make an engine throw (strings, NaN, short rows). */
export function cleanPath(path) {
  const out = []
  for (const p of path) if (p && num(p[0]) && num(p[1])) out.push(p)
  return out
}

// FNV-1a over the coordinates rounded to ~0.1 m: a few thousand long lines are compared without building huge strings.
function hashPath(path) {
  let h = 2166136261
  for (const p of path) {
    h = Math.imul(h ^ Math.round(p[0] * 1e6), 16777619)
    h = Math.imul(h ^ Math.round(p[1] * 1e6), 16777619)
  }
  return (h >>> 0).toString(36)
}

/** Everything that changes what is drawn, as one string. Callbacks are NOT part of it (only whether there is one). */
export function signature(o) {
  const hasClick = o.onClick ? 1 : 0
  const tip = o.tip || ''
  if (o.type === 'line') return ['L', o.color, o.weight, o.opacity, +o.dashed, +o.outline, o.z, hasClick, tip, o.path.length, hashPath(o.path)].join('|')
  if (o.type === 'marker') return ['M', o.position.lat, o.position.lng, o.emoji || '', o.text || '', o.color, o.size, o.z, hasClick, tip].join('|')
  return ['C', o.center.lat, o.center.lng, o.radius_m, o.color, o.fillOpacity, o.z, hasClick, tip].join('|')
}

/**
 * Draw order of vector shapes: higher z on top; within one z the circle is under the line casing, which is under the line,
 * so crossing lines of the same z never show a casing over each other's colour.
 */
export const PART = { circle: 0, casing: 1, line: 2 }
export const rank = (z, part) => z * 10 + part

/**
 * Keeps `id -> { sig, o, h }` and applies only what changed. `adapter` is the engine:
 *   add(rec) -> handle        draw it (read rec.o.onClick at click time: the latest callback is always in rec.o)
 *   remove(rec)               undraw rec.h
 *   changed?(registry)        called once after a sync that added/removed anything (the Leaflet engine restacks there)
 */
export function createOverlayManager(adapter) {
  const reg = new Map()
  return {
    sync(list) {
      const seen = new Set()
      let changed = false
      for (const raw of list || []) {
        const o = normalizeOverlay(raw)
        if (!o) continue
        const key = `${o.type}:${o.id}`
        if (seen.has(key)) continue // the same id twice: the first one wins
        seen.add(key)
        const sig = signature(o)
        const old = reg.get(key)
        if (old) {
          old.o = o // always keep the newest callbacks
          if (old.sig === sig) continue
          if (old.h) adapter.remove(old)
          reg.delete(key)
        }
        const rec = { key, o, sig, h: null }
        // One bad overlay (an engine can throw on odd geometry) must not take the page down. It stays registered, with
        // no handle, so it is not retried on every render.
        try { rec.h = adapter.add(rec) } catch (err) { console.warn(`[map] overlay "${o.id}" skipped: ${err?.message || err}`) }
        reg.set(key, rec)
        changed = true
      }
      for (const [key, rec] of reg) {
        if (seen.has(key)) continue
        if (rec.h) adapter.remove(rec)
        reg.delete(key)
        changed = true
      }
      if (changed) adapter.changed?.(reg)
    },
    clear() {
      for (const rec of reg.values()) if (rec.h) adapter.remove(rec)
      reg.clear()
    },
    size: () => reg.size,
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Font size for the badge label: an emoji fits larger than a few letters. */
export function badgeFontSize(size, emoji, text) {
  if (emoji) return Math.round(size * 0.5)
  const n = (text || '').length
  return Math.round(size * (n > 3 ? 0.28 : n > 2 ? 0.34 : n > 1 ? 0.4 : 0.48))
}

/** The round badge as an inline SVG data URI (the icon of a classic google.maps.Marker). Padded by 5px for the shadow. */
export function badgeSvgUri({ emoji, text, color, size }) {
  const pad = 5
  const full = size + pad * 2
  const c = full / 2
  const label = esc(emoji || text || '')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${full}" height="${full}" viewBox="0 0 ${full} ${full}">`
    + '<defs><filter id="s" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#0f1a3c" flood-opacity="0.38"/></filter></defs>'
    + `<circle cx="${c}" cy="${c}" r="${size / 2 - 1.5}" fill="${esc(color)}" stroke="#fff" stroke-width="3" filter="url(#s)"/>`
    + (label
      ? `<text x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central" font-size="${badgeFontSize(size, emoji, text)}" font-weight="700" fill="#fff" `
        + `font-family="system-ui, 'Segoe UI', 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif">${label}</text>`
      : '')
    + '</svg>'
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

/** The same badge as a DOM element (the icon of a Leaflet marker). textContent only: labels may come from data. */
export function badgeElement({ emoji, text, color, size }, interactive) {
  const el = document.createElement('div')
  el.className = 'rm-map-pin'
  el.style.setProperty('--c', color)
  el.style.width = el.style.height = `${size}px`
  el.style.fontSize = `${badgeFontSize(size, emoji, text)}px`
  el.textContent = emoji || text || ''
  if (interactive) el.classList.add('is-click')
  return el
}
