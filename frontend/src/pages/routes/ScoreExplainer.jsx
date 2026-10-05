import { ChevronDown, Gauge } from 'lucide-react'
import { RISK_PARTS } from './routeFormat'

/** "How RoadMind scores a route": read-only; the percentages are the server's own weights (result.weights) once there is a result. */
export default function ScoreExplainer({ weights }) {
  return (
    <details className="rp-explain">
      <summary><Gauge size={16} aria-hidden="true" /> How RoadMind scores a route <ChevronDown size={16} aria-hidden="true" className="rp-chev" /></summary>
      <div className="rp-explain-body">
        <p className="small muted">Every route gets a RoadMind risk score from 0 to 100 (lower is better), built from four parts:</p>
        <ul>
          {RISK_PARTS.map((p) => (
            <li key={p.key}>
              <b>{p.label}{weights?.[p.key] != null ? ` · ${Math.round(weights[p.key] * 100)}%` : ''}</b>
              <span>{p.about}</span>
            </li>
          ))}
        </ul>
        <p className="small muted">A part that is unavailable (for example live traffic without Google Maps) is left out and the others share its weight, so it is never counted as zero. The weights are set on the server. A much slower route gets a small extra penalty, so travel time only breaks ties.</p>
        <p className="small"><b>RoadMind estimates risk from reports, AI detections and live traffic; it cannot guarantee that a road is physically safe.</b></p>
      </div>
    </details>
  )
}
