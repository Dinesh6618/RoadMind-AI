import { ExternalLink, X } from 'lucide-react'
import { scoreColors, trafficInfo } from '../routes/routeFormat'
import { TEXT, agoMs, fmtDuration, fmtKm, googleMapsUrl, isUnavailable, riskText, trafficShort } from './emergencyFormat'
import { trafficDetail } from './RouteDetails'
import { StatRow } from './ui'

/** Screen 9: the green "Emergency Route Active" panel with the live status rows. Every row says "unavailable" instead of guessing. */

const STATUS = {
  OK: { text: 'OK - no change on your route', color: '#17a673' },
  CHANGED: { text: 'Changed - a road condition changed', color: '#f7762c' },
  BLOCKED: { text: 'Blocked - verified closure on your route', color: '#d92d20' },
}

function Dot({ color }) { return <i className="em-dot" style={{ '--c': color }} aria-hidden="true" /> }

export default function LiveStatus({ route, result, routeStatus, checkFailed, lastChecked, refreshedAt, remaining_m, remaining_min, now, origin, destination, onClose, tracking }) {
  const st = routeStatus ? STATUS[routeStatus.status] : null
  const t = trafficInfo(route.traffic_available ? route.traffic_level : 'Unknown')
  const risk = scoreColors(route.risk)
  const warnings = [
    ...(result?.messages || []).filter((m) => m.kind === 'warn' || m.kind === 'error').map((m) => m.text),
    ...(isUnavailable(route) ? ['This route has a verified road closure'] : []),
  ]
  return (
    <section className="em-livestatus" aria-label="Live status">
      <header>
        <span className="em-pulse" aria-hidden="true" />
        <div><h2>🟢 Emergency Route Active</h2><p>Monitoring road conditions for updates.</p></div>
        <button type="button" className="em-iconbtn" onClick={onClose} aria-label="Hide live status"><X size={18} aria-hidden="true" /></button>
      </header>
      <StatRow items={[['Remaining', fmtKm(remaining_m / 1000)], ['ETA', fmtDuration(remaining_min)], ['Traffic', trafficShort(route)]]} />
      <div className="em-ls-title"><h3>Live Status</h3><small>Last checked: {agoMs(lastChecked, now) || 'not yet'}</small></div>
      <ul className="em-ls-rows">
        <li><Dot color={st?.color || '#94a3b8'} /><span>Route Status</span><b>{st ? st.text : 'Not checked yet'}</b></li>
        <li><Dot color={t.color} /><span>Traffic Condition</span><b>{trafficDetail(route)}</b></li>
        <li><Dot color={route.risk == null ? '#94a3b8' : risk.color} /><span>Road Condition</span><b>{route.risk == null ? 'Road condition data unavailable' : `RoadMind risk ${riskText(route)}`}</b></li>
        <li><Dot color={warnings.length ? '#f7762c' : '#94a3b8'} /><span>Active Warnings</span><b>{warnings.length ? warnings.map((w, i) => <span key={i} className="em-warnline">{w}</span>) : 'None'}</b></li>
      </ul>
      {checkFailed && <p className="em-ls-fail" role="status">{TEXT.monitorFailed}</p>}
      <p className="em-ls-note small muted">Route data updated {agoMs(refreshedAt, now) || 'just now'}.{tracking ? '' : ' Live position is off.'}</p>
      <a className="btn btn-small em-gmaps" href={googleMapsUrl(origin, destination, route.geometry)} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" /> Navigate in Google Maps</a>
      <p className="small muted em-ls-note">Opens Google Maps with waypoints along this route; Google may still choose its own path.</p>
    </section>
  )
}

