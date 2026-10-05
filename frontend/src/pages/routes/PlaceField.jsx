import { LocateFixed, MapPin } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'

/**
 * One end of the trip: a search box (stored places first, then /routes/geocode), "use my location" and "pick on the map".
 * `value` is { name, lat, lng } or null; `onChange` gets the same shape.
 */
export default function PlaceField({ label, tag, value, onChange, suggestions, picking, onPickToggle, locate }) {
  const [text, setText] = useState(value?.name || '')
  const [hits, setHits] = useState([])
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState(false)
  const box = useRef(null)

  useEffect(() => { setText(value?.name || ''); setTyped(false) }, [value?.name])

  useEffect(() => {
    if (!typed || text.trim().length < 2) { setHits([]); return undefined }
    const ctl = new AbortController()
    const t = setTimeout(() => {
      api(`/routes/geocode?q=${encodeURIComponent(text.trim())}`, { signal: ctl.signal }).then(setHits).catch((e) => { if (e.name !== 'AbortError') setHits([]) })
    }, 350)
    return () => { clearTimeout(t); ctl.abort() }
  }, [text, typed])

  useEffect(() => {
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const options = typed && text.trim().length >= 2 ? hits : suggestions
  const listId = `pf-list-${tag}`
  const expanded = open && options.length > 0

  return (
    <div className="field place-input" ref={box}>
      <label htmlFor={`pf-${tag}`}>{label}</label>
      <div className="row nowrap-row" style={{ gap: 8 }}>
        <div className="input-icon" style={{ flex: 1, minWidth: 0 }}>
          <MapPin size={18} aria-hidden="true" style={{ color: tag === 'from' ? 'var(--ink)' : 'var(--brand)' }} />
          <input
            id={`pf-${tag}`} className="input" value={text} placeholder={tag === 'from' ? 'Where are you starting?' : 'Where are you going?'} autoComplete="off"
            role="combobox" aria-expanded={expanded} aria-controls={listId} aria-autocomplete="list"
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
            onChange={(e) => { setText(e.target.value); setTyped(true); setOpen(true) }}
          />
        </div>
        {locate && (
          <button type="button" className="btn btn-soft btn-icon" onClick={locate} aria-label="Use my current location" title="Use my current location"><LocateFixed size={18} /></button>
        )}
        <button
          type="button" className={`btn btn-icon ${picking ? 'btn-primary' : ''}`} onClick={onPickToggle}
          aria-pressed={picking} aria-label={`Pick ${label.toLowerCase()} on the map`} title="Pick on the map"
        ><MapPin size={18} /></button>
      </div>
      {expanded && (
        <div className="suggest" role="listbox" id={listId}>
          {options.map((p) => (
            <button type="button" role="option" aria-selected="false" key={`${p.name}${p.lat}${p.lng}`} onClick={() => { onChange({ name: p.name, lat: p.lat, lng: p.lng }); setOpen(false) }}>
              {p.name}<small>{p.source === 'osm' ? 'OpenStreetMap search' : p.kind}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
