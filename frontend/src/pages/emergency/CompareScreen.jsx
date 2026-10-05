import { ArrowDownUp, MapPin, Pencil } from 'lucide-react'
import { fmtDuration, fmtKm, closureSentences, isUnavailable, riskText, routeChips, sortRoutes, trafficText } from './emergencyFormat'
import { Chip, ScreenHead, Tag } from './ui'

/** Screen 4: the trip card, the route chips, the legend, why-this-route, and the compact comparison list. */

export function TripCard({ start, dest, onSwap, onEditStart, onEditDest, busy }) {
  return (
    <section className="em-trip" aria-label="Your trip">
      <div className="em-trip-rows">
        <div className="em-trip-row">
          <span className="em-trip-dot" aria-hidden="true" />
          <div className="em-trip-txt"><b>{start.source === 'gps' ? 'Your Location' : start.name}</b><small>{start.source === 'gps' ? start.name : 'Starting place'}</small></div>
          <button type="button" className="em-iconbtn" onClick={onEditStart} aria-label="Change the starting point"><Pencil size={16} aria-hidden="true" /></button>
        </div>
        <div className="em-trip-row">
          <span className="em-trip-pin" aria-hidden="true"><MapPin size={20} /></span>
          <div className="em-trip-txt"><small className="em-trip-to">To</small><b>{dest.name}</b>{dest.address && <small>{dest.address}</small>}</div>
          <button type="button" className="em-iconbtn" onClick={onEditDest} aria-label="Choose a different destination"><Pencil size={16} aria-hidden="true" /></button>
        </div>
      </div>
      <button type="button" className="em-swap" onClick={onSwap} disabled={busy} aria-label="Swap start and destination" title="Swap start and destination"><ArrowDownUp size={18} aria-hidden="true" /></button>
    </section>
  )
}

export function CompareTop({ alert, start, dest, onSwap, onEditStart, onEditDest, chip, onChip, hasSafer, hasFastest, hasRec, busy, children }) {
  return (
    <>
      <ScreenHead title="Emergency Route" />
      {alert}
      <TripCard start={start} dest={dest} onSwap={onSwap} onEditStart={onEditStart} onEditDest={onEditDest} busy={busy} />
      {children}
      <div className="em-chips" role="group" aria-label="Which route to highlight">
        <Chip pressed={chip === 'rec'} onClick={() => onChip('rec')} disabled={!hasRec}>Recommended</Chip>
        <Chip pressed={chip === 'all'} onClick={() => onChip('all')}>All Routes</Chip>
        <Chip pressed={chip === 'safer'} onClick={() => onChip('safer')} disabled={!hasSafer} title="The open route with the lowest RoadMind risk">Safer</Chip>
        <Chip pressed={chip === 'fastest'} onClick={() => onChip('fastest')} disabled={!hasFastest} title="The open route with the shortest travel time">Fastest</Chip>
      </div>
    </>
  )
}

/** One swatch row: blue = recommended / selected, grey = alternative, red dashed = blocked. */
export function RouteLegend() {
  return (
    <ul className="em-legend-row" aria-label="Route colours">
      <li><i className="is-rec" />Recommended</li>
      <li><i className="is-alt" />Alternative</li>
      <li><i className="is-bad" />Blocked</li>
    </ul>
  )
}

/** Why the fastest route is unavailable and why the recommended one was chosen - in the answer's own words. */
export function WhyBox({ result, now }) {
  const routes = result.routes || []
  const closed = routes.filter(isUnavailable)
  const rec = routes.find((r) => r.label === result.recommended)
  if (!closed.length && !rec) return null
  return (
    <section className={`em-why${closed.length ? ' has-closed' : ''}`} aria-label="Why this recommendation">
      {closed.map((r) => (
        <p key={r.label}>
          <b>{r.is_fastest ? `Fastest route (${fmtDuration(r.duration_min)})` : `${r.label} (${fmtDuration(r.duration_min)})`} is unavailable:</b>{' '}
          {closureSentences(r, result.generated_at, now).join('; ') || 'a verified road closure is on this route'}.
        </p>
      ))}
      {rec ? <p><b>Why {rec.label} was chosen:</b> {rec.reason}</p> : <p><b>No route is recommended:</b> every route RoadMind found has a verified road closure.</p>}
    </section>
  )
}

/** The comparison list. Unavailable routes are struck through, show their closure and have NO select button. */
export function RouteList({ result, selected, onSelect, now, activeLabel }) {
  const routes = sortRoutes(result.routes)
  return (
    <ul className="em-routes" aria-label="Routes found">
      {routes.map((r) => {
        const bad = isUnavailable(r)
        const on = r.label === selected
        const sentences = bad ? closureSentences(r, result.generated_at, now) : []
        return (
          <li key={r.label} className={`em-route${bad ? ' is-bad' : ''}${on ? ' is-on' : ''}`}>
            <div className="em-route-head">
              <span className="em-letter" aria-hidden="true">{r.label.replace('Route ', '')}</span>
              <b>{r.label}</b>
              {r.label === activeLabel && <Tag tone="info">● Active</Tag>}
              <span className="em-route-chips">{routeChips(r).map((c) => <Tag key={c.key} tone={c.tone}>{c.text}</Tag>)}</span>
            </div>
            <dl className="em-route-metrics">
              <div><dt>Distance</dt><dd>{fmtKm(r.distance_km)}</dd></div>
              <div><dt>ETA</dt><dd>{fmtDuration(r.duration_min)}</dd></div>
              <div><dt>Traffic</dt><dd>{trafficText(r)}</dd></div>
              <div><dt>Risk</dt><dd>{riskText(r)}</dd></div>
            </dl>
            {bad && (
              <div className="em-route-closed">
                <b>Unavailable - not recommended.</b>{' '}{sentences.length ? sentences.map((s, i) => <span key={i}>{s.charAt(0).toUpperCase() + s.slice(1)}. </span>) : 'A verified road closure is on this route.'}
              </div>
            )}
            {!bad && r.reason && <p className="em-route-reason">{r.reason}</p>}
            {!bad && (
              <button type="button" className={`btn btn-small em-route-pick${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => onSelect(r.label)}>{on ? '✓ Selected' : 'Select route'}</button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
