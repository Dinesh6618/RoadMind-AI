import { Siren } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useApi } from '../../api'
import { Empty, ErrorBox, Spinner } from '../../components'
import { ago, fmtWhen, inFuture } from './eventTime'
import EventStatusChip from './EventStatusChip'

// One line about what became of the report.
function outcome(ev) {
  switch (ev.display_status) {
    case 'PENDING': return 'Waiting for authorised staff to check it. Until then it is shown as unverified.'
    case 'ACTIVE': return `Verified by staff. In effect until about ${fmtWhen(ev.expires_at)} (${inFuture(ev.expires_at)}) unless staff end it sooner.`
    case 'REJECTED': return 'Staff reviewed this report and did not confirm it.'
    case 'RESOLVED': return `Marked as over${ev.resolved_at ? ` ${ago(ev.resolved_at)}` : ''}.`
    case 'EXPIRED': return 'The time window of this report has passed.'
    default: return ''
  }
}

/** "Road events I reported" in the My reports tab: GET /api/road-reports/mine. */
export default function MyEventReports() {
  const { data, loading, error, reload } = useApi('/road-reports/mine')
  return (
    <section className="ev-mine" aria-labelledby="ev-mine-h">
      <h2 id="ev-mine-h" className="ev-mine-h">Road events I reported</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Flooding, accidents, blocked roads, construction and dangerous conditions wait for authorised staff to verify them.</p>
      {loading && <Spinner />}
      <ErrorBox error={error} onRetry={reload} />
      {data && data.items.length === 0 && (
        <div className="card"><Empty icon={Siren}>You have not reported a road event yet.<br /><Link className="btn btn-soft" style={{ marginTop: 14 }} to="/user/report">Report a road problem</Link></Empty></div>
      )}
      {data && data.items.length > 0 && (
        <ul className="ev-mine-list">
          {data.items.map((ev) => (
            <li key={ev.id} className="card ev-mine-item">
              <span className="ev-mine-emoji" aria-hidden="true">{ev.emoji}</span>
              <div className="ev-mine-body">
                <div className="ev-mine-top">
                  <b>{ev.event_type_label}</b>
                  <EventStatusChip status={ev.display_status} />
                </div>
                <div className="small muted">{ev.road_name || 'Reported location'} · {ev.lat.toFixed(4)}, {ev.lng.toFixed(4)} · reported {ago(ev.created_at)}</div>
                {ev.description && <p className="ev-mine-desc">{ev.description}</p>}
                <div className="small">{outcome(ev)}</div>
              </div>
              {ev.evidence_url && <a href={ev.evidence_url} target="_blank" rel="noreferrer" aria-label={`Open your photo for report ${ev.id}`}><img className="ev-thumb ev-thumb-sm" src={ev.evidence_url} alt="" loading="lazy" /></a>}
              {ev.display_status === 'ACTIVE' || ev.display_status === 'PENDING' ? <Link className="btn btn-small btn-ghost" to={`/user/map?lat=${ev.lat}&lng=${ev.lng}`}>View on map</Link> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
