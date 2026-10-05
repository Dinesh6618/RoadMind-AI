import { MapPin, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../api'

/** Search box over the map (uses /routes/geocode). `onPick({ lat, lng, zoom, name })` moves the map there. */
export default function PlaceSearch({ onPick }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return undefined }
    const ctl = new AbortController()
    const t = setTimeout(() => {
      api(`/routes/geocode?q=${encodeURIComponent(q.trim())}`, { signal: ctl.signal })
        .then((r) => setHits(Array.isArray(r) ? r : []))
        .catch((err) => { if (err?.name !== 'AbortError') setHits([]) })
    }, 300)
    return () => { clearTimeout(t); ctl.abort() }
  }, [q])

  const showList = open && hits.length > 0
  return (
    <div className="search-wrap place-input">
      <div className="search-pill glass">
        <Search size={19} aria-hidden="true" />
        <input
          placeholder="Search a place or road…" aria-label="Search for a place" role="combobox" aria-expanded={showList} aria-autocomplete="list" autoComplete="off"
          value={q} onChange={(e) => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Escape' && showList) { e.preventDefault(); setOpen(false) } }}
        />
        {q && <button type="button" className="btn btn-icon btn-ghost btn-small" onClick={() => { setQ(''); setHits([]) }} aria-label="Clear search"><X size={16} /></button>}
      </div>
      {showList && (
        <div className="suggest" role="listbox" aria-label="Matching places">
          {hits.map((h) => (
            <button type="button" role="option" aria-selected="false" key={`${h.name}${h.lat}${h.lng}`} onClick={() => { onPick({ lat: h.lat, lng: h.lng, zoom: 17, name: h.name }); setQ(h.name); setOpen(false) }}>
              <MapPin size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6, color: 'var(--brand)' }} />{h.name}<small>{h.source === 'osm' ? 'OpenStreetMap search' : h.kind}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
