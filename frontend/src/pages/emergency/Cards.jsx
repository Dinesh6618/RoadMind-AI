import { Check, Info, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { forwardRef } from 'react'
import { agoText, minutesSince, reopeningText } from '../routes/routeFormat'
import { fmtDuration, fmtKm, signedKm, signedMin } from './emergencyFormat'
import { Dots, StatRow } from './ui'

/** The alert family of Emergency Route Mode: blocked road (red), alternative found (green), route update (orange), calm notices. */

function Closure({ ev, generatedAt, now }) {
  const age = ev.age_minutes == null ? null : agoText(ev.age_minutes + (minutesSince(generatedAt, now) ?? 0))
  const reopen = reopeningText(ev.expected_reopening_at)
  return (
    <li>
      <b>{ev.road_name || 'A reported road'}</b>
      <span>{ev.headline || '🚧 BLOCKED'} · {ev.verified === false ? 'not verified' : 'verified by authorised staff'}{age ? ` · reported ${age}` : ''}{reopen ? ` · expected to reopen ${reopen}` : ''}</span>
    </li>
  )
}

/**
 * Screen 7. A strong red card: "🚧 ROAD BLOCKED" + the API's own words, the closure(s), and what is happening next
 * ("Finding an alternative route..." while recalculating, the server's detail when there is none).
 */
export const BlockedCard = forwardRef(function BlockedCard({ blocked, finding, hasOffer, error, onRetry, compact, live, generatedAt, now }, ref) {
  if (!blocked) return null
  const none = !finding && !hasOffer
  return (
    <section className={`em-blocked${compact ? ' is-compact' : ''}${live ? ' is-live' : ''}`} role="alert" ref={ref} tabIndex={-1} aria-labelledby="em-blocked-title">
      <div className="em-blocked-head">
        <span className="em-blocked-ico" aria-hidden="true"><TriangleAlert size={compact ? 26 : 40} strokeWidth={2.2} /></span>
        <div>
          <h2 id="em-blocked-title">{blocked.title || '🚧 ROAD BLOCKED'}</h2>
          <p>{blocked.message}</p>
        </div>
      </div>
      {blocked.events?.length > 0 && <ul className="em-closures" aria-label="Blocking road events">{blocked.events.map((ev) => <Closure key={ev.id} ev={ev} generatedAt={generatedAt} now={now} />)}</ul>}
      {finding && (
        <div className="em-finding" role="status">
          <Dots />
          <div><b>Finding an alternative route...</b><small>This may take a few seconds.</small></div>
        </div>
      )}
      {none && (
        <div className="em-noalt">
          <b>{blocked.headline || 'No unblocked route available'}</b>
          {blocked.detail && <p>{blocked.detail}</p>}
          {error && <p>{error}</p>}
          {onRetry && error && <button type="button" className="btn btn-small" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" /> Try again</button>}
        </div>
      )}
    </section>
  )
})

/** Screen 8. Green confirmation: "✓ Alternative Route Found", the real differences, [View Routes] [Use Alternative]. */
export const AlternativeCard = forwardRef(function AlternativeCard({ offer, onUse, onViewRoutes, viewing, compact }, ref) {
  if (!offer) return null
  const items = [
    [offer.dKm != null && offer.dKm < 0 ? 'Shorter' : 'Longer', signedKm(offer.dKm)],
    [offer.dMin != null && offer.dMin < 0 ? 'Less time' : 'Extra time', signedMin(offer.dMin)],
  ]
  if (offer.lowerRisk) items.push(['Road risk', 'Lower'])
  const swapped = items.map(([label, value]) => [label, value, offer.lowerRisk && label === 'Road risk' ? 'good' : null])
  return (
    <section className={`em-alt${compact ? ' is-compact' : ''}`} role="status" aria-live="polite" ref={ref} tabIndex={-1} aria-labelledby="em-alt-title">
      <div className="em-alt-head">
        <span className="em-check" aria-hidden="true"><Check size={26} strokeWidth={3} /></span>
        <div>
          <h2 id="em-alt-title">✓ Alternative Route Found</h2>
          <p>A new route avoids the blocked road.</p>
        </div>
      </div>
      <p className="em-alt-route"><b>{offer.route.label}</b> · {fmtKm(offer.route.distance_km)} · {fmtDuration(offer.route.duration_min)}</p>
      <StatRow items={swapped} />
      {offer.reason && <p className="small em-alt-reason">{offer.reason}</p>}
      <div className="em-btnrow">
        <button type="button" className="btn" onClick={onViewRoutes} aria-expanded={!!viewing}>View Routes</button>
        <button type="button" className="btn btn-primary" onClick={onUse}>Use Alternative</button>
      </div>
    </section>
  )
})

/** Screen 10. Orange: "⚠️ Route Update Available" - the old route (grey, dashed) and the new one (blue) are on the map. */
export const UpdateCard = forwardRef(function UpdateCard({ offer, notice, onSwitch, onKeep, onDetails, detailsOpen, children }, ref) {
  if (!offer) return null
  return (
    <section className="em-update" role="status" aria-live="polite" ref={ref} tabIndex={-1} aria-labelledby="em-update-title">
      <div className="em-update-head">
        <span className="em-update-ico" aria-hidden="true"><TriangleAlert size={26} /></span>
        <div>
          <h2 id="em-update-title">⚠️ Route Update Available</h2>
          <p>{notice?.text || 'A road condition changed on your route.'}</p>
          <p className="em-update-sub">A different route is now recommended.</p>
        </div>
      </div>
      <div className="em-update-new">
        <div>
          <b>New Route</b>
          <span>{fmtKm(offer.route.distance_km)} · {fmtDuration(offer.route.duration_min)}{offer.lowerRisk ? ' · Lower risk' : ''}</span>
        </div>
        {offer.dMin != null && <span className={`em-delta${offer.dMin > 0 ? ' is-up' : ' is-down'}`}>{signedMin(offer.dMin)}</span>}
      </div>
      <div className="em-btnrow">
        <button type="button" className="btn" onClick={onDetails} aria-expanded={!!detailsOpen}>View Details</button>
        <button type="button" className="btn btn-primary" onClick={onSwitch}>Switch Route</button>
      </div>
      <button type="button" className="em-link em-keep" onClick={onKeep}>Keep current route</button>
      {children}
    </section>
  )
})

/** A calm one-line notice (route recalculated, couldn't check, ...). */
export function Notice({ tone = 'info', title, children, onDismiss, role = 'status' }) {
  return (
    <div className={`em-notice is-${tone}`} role={role}>
      <Info size={18} aria-hidden="true" />
      <span>{title && <b>{title} </b>}{children}</span>
      {onDismiss && <button type="button" onClick={onDismiss} aria-label="Dismiss this message"><X size={16} aria-hidden="true" /></button>}
    </div>
  )
}
