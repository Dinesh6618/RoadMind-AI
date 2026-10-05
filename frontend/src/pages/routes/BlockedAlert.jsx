import { Navigation, TriangleAlert } from 'lucide-react'
import { agoText, fmtDuration, fmtKm, minutesSince, reopeningText } from './routeFormat'

/**
 * The prominent card shown when the route a driver would normally take (the fastest one) has a VERIFIED blockage.
 * `alert` is result.alert; `now` ticks so "reported 12 min ago" stays right while the page is open.
 */
function Blocker({ ev, generatedAt, now }) {
  // age_minutes was measured when the answer was generated: add the time since then.
  const sinceAnswer = minutesSince(generatedAt, now) ?? 0
  const age = ev.age_minutes == null ? null : agoText(ev.age_minutes + sinceAnswer)
  const reopen = reopeningText(ev.expected_reopening_at)
  return (
    <li className="rp-blocker">
      <div className="rp-blocker-head"><b>{ev.road_name || 'A reported road'}</b><span className="rp-blocker-tag">{ev.headline || '🚧 BLOCKED'}</span></div>
      {ev.description && <p className="small">{ev.description}</p>}
      <p className="small rp-blocker-meta">
        {age && <span>Reported {age}</span>}
        <span>Verified: {ev.verified === false ? 'NO' : 'YES (authorised staff)'}</span>
        {reopen && <span>Expected reopening {reopen}</span>}
      </p>
    </li>
  )
}

export default function BlockedAlert({ alert, generatedAt, now, onUseRecommended, onViewRoutes }) {
  if (!alert) return null
  const alt = alert.alternative
  return (
    <section className="rp-alert" role="alert" aria-labelledby="rp-alert-title">
      <h2 id="rp-alert-title" className="rp-alert-title">{alert.title || '🚧 ROAD BLOCKED'}</h2>
      <p className="rp-alert-msg">{alert.message}</p>

      {alert.blocked_by?.length > 0 && (
        <ul className="rp-blockers" aria-label="Blocking road events">
          {alert.blocked_by.map((ev) => <Blocker key={ev.id} ev={ev} generatedAt={generatedAt} now={now} />)}
        </ul>
      )}

      {alt ? (
        <div className="rp-alt">
          <h3>{alert.headline || 'Alternative route recommended'}</h3>
          <dl className="rp-alt-facts">
            <div><dt>Route</dt><dd>{alt.label}</dd></div>
            <div><dt>Distance</dt><dd>{fmtKm(alt.distance_km)}</dd></div>
            <div><dt>Estimated travel time</dt><dd>{fmtDuration(alt.duration_min)}</dd></div>
            <div><dt>RoadMind risk</dt><dd>{alt.risk == null ? 'n/a' : `${Math.round(alt.risk)}/100`}</dd></div>
          </dl>
          {alt.reason && <p className="small rp-alt-reason"><b>Reason:</b> {alt.reason}</p>}
          <div className="rp-alert-actions">
            <button type="button" className="btn btn-primary" onClick={onUseRecommended}><Navigation size={17} aria-hidden="true" /> Use Recommended Route</button>
            <button type="button" className="btn" onClick={onViewRoutes}>View Other Routes</button>
          </div>
        </div>
      ) : (
        <div className="rp-alt rp-alt-none">
          <h3><TriangleAlert size={18} aria-hidden="true" /> {alert.headline || 'No unblocked route available'}</h3>
          {alert.detail && <p className="small">{alert.detail}</p>}
          <div className="rp-alert-actions">
            <button type="button" className="btn" onClick={onViewRoutes}>View Routes</button>
          </div>
        </div>
      )}
    </section>
  )
}
