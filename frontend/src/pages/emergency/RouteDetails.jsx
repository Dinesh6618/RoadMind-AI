import { Ban, Car, Check, Route as RouteIcon, ShieldCheck, TriangleAlert, Trophy } from 'lucide-react'
import { scoreColors } from '../routes/routeFormat'
import { fmtDuration, fmtKm, highRiskSegments, isUnavailable, riskText, trafficShort } from './emergencyFormat'
import { StatRow } from './ui'

/** Screen 5: the details of ONE route. Every value is the route's own; a row says "unavailable" rather than guess. */

const FLAG_LINES = { HIGH_ROAD_RISK: 'High road risk on part of this route', FLOODING_REPORTED: 'Flooding reported on this route', ROAD_DAMAGE: 'Road damage reported on this route' }

/** What kind of route this is, only from the numbers of the routes that were returned. */
export function routeTypes(route, routes) {
  const open = (routes || []).filter((r) => !isUnavailable(r))
  const out = []
  if (route.status === 'RECOMMENDED') out.push('Recommended')
  if (open.length > 1) {
    const minT = Math.min(...open.map((r) => r.duration_min))
    if (route.duration_min === minT) out.push('Fastest available')
    const risks = open.map((r) => r.risk).filter((v) => v != null)
    if (route.risk != null && risks.length > 1 && route.risk === Math.min(...risks)) out.push('Lowest road risk')
  }
  return out.length ? out : ['Alternative']
}

/** The traffic row: the level, and the delay when Google gave one. */
export function trafficDetail(route) {
  if (!route.traffic_available || !route.traffic_level || route.traffic_level === 'Unknown') return 'Live traffic unavailable'
  const delay = route.delay_min != null && route.delay_min >= 1 ? ` · +${Math.round(route.delay_min)} min delay` : ''
  return `${route.traffic_level}${delay}`
}

function Row({ icon: Icon, tone, label, children, sub }) {
  return (
    <li className={`em-row-item${tone ? ` is-${tone}` : ''}`}>
      <span className="em-row-ico" aria-hidden="true"><Icon size={18} /></span>
      <div className="em-row-main">
        <span className="em-row-label">{label}</span>
        <span className="em-row-val">{children}</span>
      </div>
      {sub && <div className="em-row-sub">{sub}</div>}
    </li>
  )
}

export function DetailRows({ route, routes }) {
  const segs = highRiskSegments(route)
  const flagLines = (route.flags || []).filter((f) => FLAG_LINES[f]).map((f) => FLAG_LINES[f])
  const closures = route.blocked_by || []
  const risk = scoreColors(route.risk)
  const parts = [['Road damage', route.road_damage_risk], ['Flood', route.flood_risk], ['Other', route.other_risk]].filter(([, v]) => v != null)
  return (
    <ul className="em-rows" aria-label="Route details">
      <Row icon={ShieldCheck} label="RoadMind Risk" sub={parts.length ? parts.map(([k, v]) => `${k} ${Math.round(v)}/100`).join(' · ') : null}>
        {route.risk == null ? 'Road condition data unavailable' : <span className="em-pill" style={{ '--c': risk.color, '--ink': risk.ink }}>{riskText(route)}</span>}
      </Row>
      <Row icon={Ban} tone={closures.length ? 'bad' : null} label="Blocked Roads" sub={closures.length ? closures.map((e) => e.road_name || 'a reported road').join(', ') : null}>
        {closures.length ? `${closures.length} verified closure${closures.length > 1 ? 's' : ''}` : <>None <Check size={15} className="em-ok" aria-hidden="true" /></>}
      </Row>
      <Row icon={TriangleAlert} tone={segs.length || flagLines.length ? 'warn' : null} label="High-Risk Segments" sub={segs.length || flagLines.length ? [...segs.map((s) => `${s.name}${s.level ? ` (${s.level})` : ''}`), ...flagLines].join(' · ') : null}>
        {segs.length ? `${segs.length} segment${segs.length > 1 ? 's' : ''}` : flagLines.length ? 'See below' : 'None reported on the data RoadMind has'}
      </Row>
      <Row icon={Car} label="Traffic Condition">{trafficDetail(route)}</Row>
      <Row icon={RouteIcon} label="Route Type">{(routes ? routeTypes(route, routes) : ['Alternative']).join(' · ')}</Row>
    </ul>
  )
}

/** The green card of screen 5 plus the 3 stats. `isRec`: this route is RoadMind's recommendation. */
export default function RouteDetails({ route, routes, isRec, avoidsClosure, summary }) {
  return (
    <>
      <section className={`em-reccard${isRec ? '' : ' is-selected'}`} aria-labelledby="em-rec-title">
        <span className="em-reccard-ico" aria-hidden="true"><Trophy size={26} /></span>
        <div>
          <h2 id="em-rec-title">{isRec ? 'Recommended Emergency Route' : `${route.label} (your choice)`}</h2>
          {isRec && avoidsClosure && <p><b>Recommended because this route avoids a verified road closure.</b></p>}
          {!isRec && <p>RoadMind recommends a different route; this one was chosen by you.</p>}
          {route.reason && <p>{route.reason}</p>}
          {!route.reason && summary && <p className="small">{summary}</p>}
        </div>
      </section>
      <StatRow items={[['Distance', fmtKm(route.distance_km)], ['ETA', fmtDuration(route.duration_min)], ['Traffic', trafficShort(route)]]} />
      <DetailRows route={route} routes={routes} />
    </>
  )
}
