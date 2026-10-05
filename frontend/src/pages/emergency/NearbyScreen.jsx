import { LayoutList, Map as MapIcon, Phone, RefreshCw } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { KINDS, fmtDuration, fmtKm } from './emergencyFormat'
import { Chip, ScreenHead, Tag } from './ui'

/** Screen 3: nearby hospitals / fire stations / police stations - filter chips on top, list cards (the map is the page's). */

const titleCase = (t) => t.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
const driveKm = (p) => (p.route_distance_km != null ? p.route_distance_km : p.distance_km)

/** True when at least one place SAYS whether it is open (the "Open Now" chip only exists then). */
export const anyStatesOpen = (items) => (items || []).some((p) => typeof p.open_now === 'boolean')

/** The places in display order. "Open Now" keeps only places that state `open_now: true`; "Nearest" sorts by distance. */
export function arrangePlaces(items, { openNow, nearest }) {
  let list = [...(items || [])]
  if (openNow) list = list.filter((p) => p.open_now === true)
  if (nearest) list.sort((a, b) => driveKm(a) - driveKm(b))
  return list
}

export function NearbyTop({ kind, items, openNow, nearest, showMap, onOpenNow, onNearest, onToggleMap }) {
  const meta = KINDS[kind]
  const title = `Nearby ${titleCase(meta.plural)}`
  return (
    <>
      <ScreenHead title={title} />
      <div className="em-chips" role="group" aria-label="Filter places">
        <Chip pressed>{meta.emoji} {titleCase(meta.plural)}</Chip>
        {anyStatesOpen(items) && <Chip pressed={openNow} onClick={onOpenNow} title="Only places that state they are open now">Open Now</Chip>}
        <Chip pressed={nearest} onClick={onNearest} title="Sort by distance">Nearest</Chip>
        <button type="button" className="em-chip em-chip-icon" onClick={onToggleMap} aria-pressed={!showMap} aria-label={showMap ? 'Show the list only' : 'Show the map'} title={showMap ? 'List only' : 'Show map'}>
          {showMap ? <LayoutList size={18} aria-hidden="true" /> : <MapIcon size={18} aria-hidden="true" />}
        </button>
      </div>
    </>
  )
}

function PlaceCard({ place, kind, highlighted, onSelect, cardRef }) {
  const meta = KINDS[kind]
  const km = driveKm(place)
  const straight = place.route_distance_km == null
  const hasEta = place.eta_min != null
  const tel = place.phone ? String(place.phone).replace(/[^\d+]/g, '') : ''
  return (
    <li className={`em-place${highlighted ? ' is-hl' : ''}`} ref={cardRef} tabIndex={-1}>
      <span className={`em-place-ico is-${kind}`} aria-hidden="true">{meta.emoji}</span>
      <div className="em-place-body">
        <b className="em-place-name">{place.name}</b>
        {place.address && <span className="em-place-addr">{place.address}</span>}
        <span className="em-place-meta">
          <span>{fmtKm(km)}{straight ? ' straight line' : ''}</span>
          <span aria-hidden="true">•</span>
          {hasEta ? <span>{fmtDuration(place.eta_min)} <em>{place.eta_traffic_aware ? 'live traffic' : 'no live traffic'}</em></span> : <span className="em-place-noeta">travel time after you select</span>}
        </span>
        <span className="em-place-tags">
          {typeof place.open_now === 'boolean' && <Tag tone={place.open_now ? 'good' : 'bad'}>{place.open_now ? 'Open' : 'Closed'}</Tag>}
          {place.has_emergency === true && <Tag tone="info">Emergency department listed</Tag>}
          {place.opening_hours && <small>{place.opening_hours}</small>}
        </span>
        {tel && <a className="em-place-tel" href={`tel:${tel}`}><Phone size={14} aria-hidden="true" /> {place.phone}</a>}
      </div>
      <button type="button" className="btn btn-primary em-select" onClick={() => onSelect(place)} aria-label={`Select ${place.name}`}>Select</button>
    </li>
  )
}

/** The cards, with the API's own footer ("Places from ..." + notes) and honest empty / error states. */
export function NearbyList({ kind, nearby, places, highlight, onSelect, onRetry, onCustom, filtered }) {
  const refs = useRef({})
  useEffect(() => {
    if (highlight == null) return
    refs.current[highlight]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [highlight])
  const meta = KINDS[kind]
  const d = nearby.data

  if (nearby.state === 'loading' && !d) return <div className="em-card em-loading" role="status"><span className="em-spin" aria-hidden="true" /> Looking for {meta.plural} near you…</div>
  if (nearby.state === 'error') {
    return (
      <div className="em-card em-error" role="alert">
        <b>{nearby.error}</b>
        <p className="small">You can still choose a destination yourself with Custom Location.</p>
        <div className="em-row">
          <button type="button" className="btn btn-small" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" /> Try again</button>
          <button type="button" className="btn btn-small btn-soft" onClick={onCustom}>📍 Custom Location</button>
        </div>
      </div>
    )
  }
  if (!d) return null
  return (
    <>
      {places.length === 0 ? (
        <div className="em-card em-empty" role="status">
          <b>{filtered ? 'No place states that it is open now.' : d.message || `No ${meta.plural} were found nearby.`}</b>
          <p className="small">You can still choose a destination yourself with Custom Location.</p>
          <button type="button" className="btn btn-small btn-soft" onClick={onCustom}>📍 Custom Location</button>
        </div>
      ) : (
        <ul className="em-places" aria-label={`Nearby ${meta.plural}`}>
          {places.map((p, i) => (
            <PlaceCard key={`${p.name}-${p.lat}-${p.lng}`} place={p} kind={kind} highlighted={highlight === i} onSelect={onSelect} cardRef={(el) => { if (el) refs.current[i] = el; else delete refs.current[i] }} />
          ))}
        </ul>
      )}
      <p className="em-foot">
        Places from {d.source_label || d.source}.
        {d.notes?.length > 0 && <> {d.notes.join(' ')}</>}
        {nearby.state === 'loading' && ' Updating…'}
      </p>
    </>
  )
}
