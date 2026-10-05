import { RefreshCw } from 'lucide-react'
import { agoText, minutesSince } from './routeFormat'

/** "Live traffic from Google Maps." / "Live traffic unavailable" + "Last updated: 3 min ago" + a manual Recalculate button. */
export default function ResultStatus({ result, now, busy, onRecalculate }) {
  const t = result.traffic || {}
  const live = !!t.available
  const text = live ? t.message || 'Live traffic from Google Maps.' : t.message || 'Live traffic unavailable'
  const updated = agoText(minutesSince(result.generated_at, now))
  return (
    <div className="rp-status-line">
      <div className="rp-status-text">
        <span className={`rp-dot${live ? ' is-live' : ''}`} aria-hidden="true" />
        <span>{text}</span>
      </div>
      <div className="rp-status-meta">
        {updated && <span className="small muted">Last updated: {updated}</span>}
        <button type="button" className="btn btn-small" onClick={onRecalculate} disabled={busy}>
          <RefreshCw size={14} aria-hidden="true" className={busy ? 'rp-spin' : ''} /> Recalculate
        </button>
      </div>
    </div>
  )
}
