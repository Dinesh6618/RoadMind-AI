import { ROUTE_BLUE, ROUTE_GREY, ROUTE_RED, KIND, routeKind } from './routeScene'

/**
 * Route chips (A · Recommended / B · 24/100 ...) and the colour key. Drawn over the map on wide screens (`is-overlay`) and as a
 * block under it on phones (`is-below`, so it never hides the routes); CSS shows exactly one of them.
 * "inner colour = traffic" is only mentioned when the answer really has traffic.
 */
export default function MapKey({ routes, activeLabel, onSelect, trafficOn, variant }) {
  if (!routes.length) return null
  return (
    <div className={`rp-maplegend ${variant === 'overlay' ? 'is-overlay glass' : 'is-below card'}`}>
      <div className="rp-chips" role="group" aria-label="Routes on the map">
        {routes.map((r) => {
          const k = KIND[routeKind(r)]
          const word = routeKind(r) === 'alt' ? (r.risk == null ? 'Alternative' : `${Math.round(r.risk)}/100`) : k.word
          const on = r.label === activeLabel
          return (
            <button
              type="button" key={r.label} className={`rp-chip${on ? ' on' : ''}`} style={{ '--c': k.color }} aria-pressed={on} onClick={() => onSelect(r.label)}
              aria-label={`${r.label}: ${k.word}${r.risk == null ? '' : `, risk ${Math.round(r.risk)} out of 100`}`} title={`${r.label}: ${k.word}`}
            >
              <i aria-hidden="true">{r.label.replace('Route ', '')}</i>{word}
            </button>
          )
        })}
      </div>
      <p className="rp-legend-line">
        Route colour: <span style={{ '--c': ROUTE_BLUE }}>blue</span> recommended, <span style={{ '--c': ROUTE_GREY }}>grey</span> alternative, <span style={{ '--c': ROUTE_RED }}>red</span> avoid{trafficOn ? ' · inner colour = traffic' : ''}
      </p>
    </div>
  )
}
