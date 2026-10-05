import { Star, Zap } from 'lucide-react'
import { STATE_COLORS } from '../../format'
import { Badge } from '../../components'
import { RISK_PARTS, damageInfo, fmtDuration, fmtKm, scoreColors, trafficInfo } from './routeFormat'
import { KIND, routeKind } from './routeScene'

const pctText = (v) => `${Math.round(v * 100)}%`

/** Status pill: RECOMMENDED / ALTERNATIVE / AVOID. */
export function StatusPill({ route }) {
  const kind = routeKind(route)
  const k = KIND[kind]
  return (
    <span className="route-pill rp-pill" style={{ '--c': k.color, '--ink-c': k.ink }}>
      {kind === 'rec' && <Star size={14} aria-hidden="true" fill="currentColor" />}
      {k.pill}
    </span>
  )
}

export function TrafficPill({ route }) {
  const t = trafficInfo(route.traffic_level)
  return <Badge dot color={t.color} ink={t.ink}>{t.label}</Badge>
}

export function DamagePill({ route }) {
  const d = damageInfo(route.damage_level)
  return <Badge dot color={d.color} ink={d.ink}>{route.damage_level || 'Unknown'}</Badge>
}

/** The four parts of the risk score, each with its value (or n/a) and the weight it had in this route's score. */
export function RiskBars({ route }) {
  const used = route.risk_weights || {}
  return (
    <ul className="rp-bars" aria-label={`How the ${route.risk ?? 'n/a'} out of 100 risk of ${route.label} is made up`}>
      {RISK_PARTS.map((p) => {
        const v = route[p.field]
        const w = used[p.key]
        const has = v != null
        const c = scoreColors(has ? v : null)
        return (
          <li key={p.key} title={p.about}>
            <span className="rp-bar-name">{p.label}</span>
            <span className={`rp-bar-track${has ? '' : ' is-na'}`} aria-hidden="true">{has && <i style={{ width: `${Math.max(3, Math.min(100, v))}%`, background: c.color }} />}</span>
            <b className="rp-bar-val" style={has ? { color: c.ink } : undefined}>{has ? Math.round(v) : 'n/a'}</b>
            <em className="rp-bar-w">{has && w != null ? `×${pctText(w)}` : ''}</em>
          </li>
        )
      })}
    </ul>
  )
}

/** One route as a clickable (and keyboard operable) card. */
export default function RouteCard({ route, selected, onSelect, cardRef }) {
  const kind = routeKind(route)
  const k = KIND[kind]
  const risk = route.risk
  const rc = scoreColors(risk)
  const delay = route.delay_min != null && route.delay_min >= 1 ? Math.round(route.delay_min) : null
  const unknownDamage = !route.damage_level || route.damage_level === 'Unknown'
  const cov = route.data_coverage
  const covPct = cov == null ? null : Math.round(cov * 100)
  const unverified = route.unverified_events || []

  return (
    <article
      ref={cardRef} id={`rp-card-${route.label.replace(/\W+/g, '-')}`}
      className={`route-card rp-card${selected ? ' on' : ''}${kind === 'rec' ? ' is-rec' : ''}${route.blocked ? ' is-blocked' : ''}`}
      style={{ '--c': k.color, '--ink-c': k.ink }}
      role="button" tabIndex={0} aria-pressed={selected}
      aria-label={`${route.label}, ${k.word.toLowerCase()}, ${fmtKm(route.distance_km)}, ${fmtDuration(route.duration_min)}, risk ${risk ?? 'not available'} out of 100${route.blocked ? ', blocked' : ''}`}
      onClick={() => onSelect(route.label)}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(route.label) } }}
    >
      <header>
        <h3>
          <span className="letter">{route.label.replace('Route ', '')}</span>
          {route.label}
          {route.is_fastest && <span className="rp-tag" title="The quickest route, i.e. the one you would normally take"><Zap size={12} aria-hidden="true" /> fastest</span>}
        </h3>
        <StatusPill route={route} />
      </header>

      <div className="rp-metrics">
        <div><span className="rp-k">Distance</span><b>{fmtKm(route.distance_km)}</b></div>
        <div>
          <span className="rp-k">Travel time</span><b>{fmtDuration(route.duration_min)}</b>
          {delay != null && <small className="rp-delay">+{delay} min traffic delay</small>}
        </div>
        <div><span className="rp-k">Risk</span><b style={{ color: rc.ink }}>{risk == null ? 'n/a' : <>{Math.round(risk)}<small className="rp-of">/100</small></>}</b></div>
        <div><span className="rp-k">Traffic</span><TrafficPill route={route} /></div>
        <div>
          <span className="rp-k">Road damage</span><DamagePill route={route} />
          {unknownDamage && <small className="rp-hint">Road condition data unavailable</small>}
        </div>
        <div>
          <span className="rp-k">Blocked</span>
          {route.blocked ? <b className="rp-blocked-yes">🚧 YES</b> : <b className="rp-blocked-no">NO</b>}
        </div>
      </div>

      <RiskBars route={route} />

      {covPct != null && (
        <div className="coverage" title="Share of this route (by length) that RoadMind has condition data for. Stretches without data are unknown: not good, not damaged.">
          <div className="coverage-bar"><i style={{ width: `${covPct}%`, background: STATE_COLORS.UNKNOWN }} /></div>
          <span className="small muted">Condition data on {covPct}% of this route{route.unknown_km > 0 ? ` · ${route.unknown_km} km no data` : ''}</span>
        </div>
      )}
      {route.reason && <p className="small rp-reason">{route.reason}</p>}
      {unverified.length > 0 && <p className="small rp-unverified">ℹ️ An unverified community report is near this route</p>}
    </article>
  )
}
