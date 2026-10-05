import { Clock, ListChecks, Map as MapIcon, RotateCcw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Notice } from '../../components'
import { ago } from './eventTime'
import EventStatusChip from './EventStatusChip'

/** What a person sees after reporting something that becomes a road event: it now waits for staff to verify it. */
export default function EventConfirmation({ result, onAnother }) {
  const ev = result.event
  return (
    <div className="stack ev-confirm">
      <div className="card ev-confirm-card">
        <div className="ev-confirm-emoji" aria-hidden="true">{ev.emoji}</div>
        <span className="eyebrow">Report received</span>
        <h1>Thank you - your report is waiting for verification by authorised staff</h1>
        <div className="row" style={{ justifyContent: 'center', marginBottom: 6 }}>
          <b className="ev-confirm-head">{ev.headline}</b>
          <EventStatusChip status={ev.display_status} />
        </div>
        <p className="muted" style={{ margin: '0 auto', maxWidth: '58ch' }}>
          Until it is verified it is shown as an <strong>unverified report</strong> and only slightly affects route suggestions.
          Authorised staff will confirm it, or reject it if it is not correct. Nothing is blocked for ever: every report expires.
        </p>
      </div>

      <div className="card">
        <dl className="kv ev-kv">
          <dt>What</dt><dd>{ev.event_type_label}</dd>
          <dt>Where</dt><dd>{ev.road_name || 'Reported location'} <span className="muted small">({ev.lat.toFixed(5)}, {ev.lng.toFixed(5)})</span></dd>
          <dt>Reported</dt><dd>{ago(ev.created_at)}</dd>
          {ev.description && (<><dt>Your description</dt><dd className="ev-desc">{ev.description}</dd></>)}
        </dl>
        {ev.evidence_url && (
          <a className="ev-thumb-link" href={ev.evidence_url} target="_blank" rel="noreferrer">
            <img className="ev-thumb" src={ev.evidence_url} alt="Your photo, kept as evidence for the reviewer" />
            <span className="small muted">Your photo is kept as evidence for the reviewer.</span>
          </a>
        )}
        <div className="row" style={{ marginTop: 22 }}>
          <Link className="btn btn-primary btn-lg" to={`/user/map?lat=${ev.lat}&lng=${ev.lng}`}><MapIcon size={19} aria-hidden="true" /> View on Map</Link>
          <button type="button" className="btn btn-lg" onClick={onAnother}><RotateCcw size={18} aria-hidden="true" /> Report Another</button>
          <Link className="btn btn-lg btn-ghost" to="/user/profile?tab=reports"><ListChecks size={18} aria-hidden="true" /> My reports</Link>
        </div>
      </div>

      <Notice icon={Clock}>You can follow what happens to this report under <b>My reports</b>. RoadMind shows reports and AI results as estimates and does not guarantee the safety of any road.</Notice>
    </div>
  )
}
