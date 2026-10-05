import { fmtDuration, fmtKm, scoreColors } from './routeFormat'
import { DamagePill, StatusPill, TrafficPill } from './RouteCard'

/** Route | Distance | Travel time | Traffic | Road risk | Blocked | RoadMind risk | Status. A row selects its route. */
export default function ComparisonTable({ routes, selected, onSelect }) {
  return (
    <div className="card card-flush">
      <h3 style={{ padding: '20px 24px 0' }}>Route comparison</h3>
      <div className="table-wrap">
        <table className="data rp-table">
          <caption className="sr-only">Comparison of the available routes</caption>
          <thead>
            <tr>
              <th scope="col">Route</th><th scope="col" className="num">Distance</th><th scope="col" className="num">Travel time</th><th scope="col">Traffic</th>
              <th scope="col">Road risk</th><th scope="col">Blocked</th><th scope="col" className="num">RoadMind risk</th><th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => {
              const rc = scoreColors(r.risk)
              return (
                <tr
                  key={r.label} className={`clickable ${selected === r.label ? 'selected' : ''}`} tabIndex={0} aria-selected={selected === r.label}
                  onClick={() => onSelect(r.label)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r.label) } }}
                >
                  <th scope="row" className="rp-row-head"><b>{r.label}</b>{r.is_fastest && <small className="muted"> fastest</small>}</th>
                  <td className="num">{fmtKm(r.distance_km)}</td>
                  <td className="num">{fmtDuration(r.duration_min)}{r.delay_min >= 1 && <small className="rp-delay"> +{Math.round(r.delay_min)} min</small>}</td>
                  <td><TrafficPill route={r} /></td>
                  <td>{r.damage_level && r.damage_level !== 'Unknown' ? <><DamagePill route={r} /></> : <span className="muted small" title="Road condition data unavailable">n/a</span>}</td>
                  <td>{r.blocked ? <b className="rp-blocked-yes">🚧 YES</b> : 'NO'}</td>
                  <td className="num"><b style={{ color: rc.ink }}>{r.risk == null ? 'n/a' : `${Math.round(r.risk)}/100`}</b></td>
                  <td><StatusPill route={r} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
