import { CalendarClock, Hash, Map as MapIcon, MapPin, RotateCcw, Route as RoadIcon, ScanSearch, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Notice, PriorityBadge, RiskBadge, SeverityBadge, SeverityRing, StateBadge } from '../components'
import { LEVEL_COLORS, LEVEL_INK, fmtDate, highwayLabel } from '../format'

const LABEL_COLORS = { pothole: '#eb3c3c', longitudinal_crack: '#f5962a', transverse_crack: '#fac81e', alligator_crack: '#dc46c8', surface_damage: '#3296eb' }
const SEV_GRADIENT = {
  Critical: ['#e0342f', '#a3191a'], High: ['#f7762c', '#c24d0a'], Moderate: ['#d99a0c', '#9a6700'], Low: ['#17a673', '#0b7a52'],
}

/** The AI detection result: annotated photo, per-damage list, big severity card and the report's details. */
export default function ReportResult({ r, onAnother }) {
  const det = r.detection
  const sev = r.severity
  const [a, b] = SEV_GRADIENT[sev.level] || SEV_GRADIENT.Low
  const when = new Date(r.created_at)
  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 4 }}>
        <span className="eyebrow"><Sparkles size={14} aria-hidden="true" /> AI analysis complete</span>
        <h1>{r.damage_detected ? 'Damage Detected' : 'No Damage Detected'}</h1>
        <p>{sev.description}</p>
      </div>

      <div className="result-grid">
        <div className="stack">
          <div className="result-img">
            {det.annotated_image_url && <img src={det.annotated_image_url} alt="Your photo with the detected damage outlined" />}
            <span className="ai-chip glass"><ScanSearch size={16} aria-hidden="true" /> {det.detector.replace(' (demo mode)', '')}</span>
          </div>
          {det.note && <p className="note note-warn" style={{ margin: 0 }}>{det.note}</p>}
        </div>

        <div className="stack">
          <div className="sev-card" style={{ '--sev-a': a, '--sev-b': b }}>
            <SeverityRing score={sev.score} />
            <div className="lvl">{sev.level}</div>
            <p>{sev.summary}</p>
          </div>

          <div className="card">
            <h3>Detected Damages</h3>
            {det.detections.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>The detector did not find potholes or cracks in this image.</p>
            ) : (
              <div className="det-list">
                {det.detections.map((d, i) => (
                  <div className="det" key={i}>
                    <span className="swatch" style={{ background: LABEL_COLORS[d.label] || '#64748b' }} />
                    <div><b>{d.label_display}</b><small>Confidence {d.confidence_percent}%</small></div>
                    <SeverityBadge level={d.severity_level} />
                  </div>
                ))}
              </div>
            )}
            <p className="small muted" style={{ margin: '12px 0 0' }}>{det.count} damaged area{det.count === 1 ? '' : 's'} found. Confidence is the model's own score, not a guarantee.</p>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="meta-grid meta-4">
          <div className="meta"><MapPin size={20} aria-hidden="true" /><div><small>Location</small><b>{r.location.lat.toFixed(5)}, {r.location.lng.toFixed(5)}</b></div></div>
          <div className="meta"><RoadIcon size={20} aria-hidden="true" /><div><small>Road Name</small><b>{r.location.road_name}</b></div></div>
          <div className="meta"><CalendarClock size={20} aria-hidden="true" /><div><small>Date &amp; Time</small><b>{fmtDate(r.created_at, true)}</b></div></div>
          <div className="meta"><Hash size={20} aria-hidden="true" /><div><small>Report ID</small><b>#{r.report_id}</b></div></div>
        </div>
        <div className="row" style={{ marginTop: 22 }}>
          <Link className="btn btn-primary btn-lg" to={`/user/map?focus=${r.location.road_id}&lat=${r.location.lat}&lng=${r.location.lng}`}><MapIcon size={19} aria-hidden="true" /> View on Map</Link>
          <button className="btn btn-lg" onClick={onAnother}><RotateCcw size={18} aria-hidden="true" /> Report Another</button>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card stack-sm">
          <h3>What this does to the road's record</h3>
          <dl className="kv">
            <dt>Road</dt><dd>{r.location.road_name} <span className="muted small">({highwayLabel(r.location.highway)})</span></dd>
            <dt>Condition now</dt><dd><StateBadge state={r.road.state} /></dd>
            <dt>Reports on this road</dt><dd>{r.road.report_count} ({r.road.reports_90d} in 90 days)</dd>
            <dt>Predicted deterioration risk</dt><dd><RiskBadge level={r.prediction.level} percent={r.prediction.risk_percent} /></dd>
            <dt>Maintenance priority</dt><dd><PriorityBadge category={r.priority.category} /> {Math.round(r.priority.score)}/100</dd>
          </dl>
          {r.location.road_was_unknown && !r.location.new_road_created && (
            <Notice kind="warn">RoadMind had no condition data for this road before - it was No Data. This report gives it its first rating (<strong>{r.road.state_label}</strong>); treat it as an early estimate.</Notice>
          )}
          {r.location.network_loaded && <Notice>The road network around this location was loaded from OpenStreetMap so the report could be attached to a real road.</Notice>}
          {r.location.new_road_created && <Notice kind="warn">No road network could be found for that pin, so a short placeholder road was created with estimated defaults.</Notice>}
        </div>
        <div className="card stack-sm">
          <h3>Why the risk looks like this</h3>
          {r.prediction.factors.length > 0 ? (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {r.prediction.factors.map((f) => <li key={f.feature}>{f.label} ({f.display}) {f.effect_points >= 0 ? 'raises' : 'lowers'} risk by {Math.abs(f.effect_points).toFixed(0)} points</li>)}
            </ul>
          ) : <p className="muted small" style={{ margin: 0 }}>No single factor stands out.</p>}
          <p className="note" style={{ margin: '4px 0 0' }}>{sev.disclaimer} {r.prediction.note}</p>
        </div>
      </div>
    </div>
  )
}
