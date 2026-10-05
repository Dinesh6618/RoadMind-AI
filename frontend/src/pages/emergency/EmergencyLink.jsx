import { Link } from 'react-router-dom'
import './cta.css'

/**
 * The "🚨 Emergency Route" entry button of the existing Home and Route Planner pages (an addition: nothing else on those pages changes).
 * `to` carries an optional chosen destination: ?toLat&toLng&toName. `badge` adds the small NEW pill.
 */
export default function EmergencyLink({ dest = null, badge = false, className = '' }) {
  let to = '/user/emergency-route'
  if (dest && Number.isFinite(dest.lat) && Number.isFinite(dest.lng)) {
    const q = new URLSearchParams({ toLat: String(dest.lat), toLng: String(dest.lng), toName: dest.name || '' })
    to = `${to}?${q}`
  }
  return (
    <Link className={`btn btn-lg em-cta ${className}`.trim()} to={to}>
      <span className="em-cta-ico" aria-hidden="true">🚨</span>
      <span className="em-cta-text">Emergency Route</span>
      {badge && <span className="em-cta-new">NEW</span>}
    </Link>
  )
}
