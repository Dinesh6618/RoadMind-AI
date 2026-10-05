import { ChevronDown } from 'lucide-react'
import { STATE_COLORS } from '../../format'
import { KINDS } from './emergencyFormat'

/** The collapsible map key under the emergency map. Traffic wording only when the answer really has live traffic. */
export default function MapKey({ destKind, trafficOn, defaultOpen }) {
  const emoji = KINDS[destKind]?.emoji || '📍'
  return (
    <details className="em-key" open={defaultOpen}>
      <summary><span>Map key</span><ChevronDown size={17} aria-hidden="true" /></summary>
      <ul className="em-key-list">
        <li><span className="em-key-me" aria-hidden="true" />You</li>
        <li><span className="em-key-pin" aria-hidden="true">{emoji}</span>Destination</li>
        <li><span className="em-key-pin is-red" aria-hidden="true">🚧</span>Closed road</li>
        <li><span className="em-key-line is-blue" aria-hidden="true" />Recommended route</li>
        <li><span className="em-key-line is-grey" aria-hidden="true" />Alternative</li>
        <li><span className="em-key-line is-red is-dash" aria-hidden="true" />Blocked / unavailable</li>
      </ul>
      <p className="em-key-title">RoadMind road condition</p>
      <ul className="em-key-list">
        <li><span className="em-key-line" style={{ '--c': STATE_COLORS.GOOD }} aria-hidden="true" />Good</li>
        <li><span className="em-key-line" style={{ '--c': STATE_COLORS.MODERATE }} aria-hidden="true" />Moderate</li>
        <li><span className="em-key-line" style={{ '--c': STATE_COLORS.HIGH_RISK }} aria-hidden="true" />High risk</li>
        <li><span className="em-key-line" style={{ '--c': STATE_COLORS.CRITICAL }} aria-hidden="true" />Critical</li>
      </ul>
      <p className="em-key-fine">{trafficOn ? 'The inner colour of the selected route is live traffic from Google Maps (green normal, orange slow, red jam).' : 'Live traffic is shown only when Google Maps traffic is available.'}</p>
    </details>
  )
}
