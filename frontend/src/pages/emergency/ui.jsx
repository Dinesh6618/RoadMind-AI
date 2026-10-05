/** Small presentational pieces shared by the Emergency Route screens. */

/** The heading of a screen. The page-level Back button lives in the app header (PublicLayout), so there is none here. */
export function ScreenHead({ title, children }) {
  return (
    <div className="em-screenhead">
      <h1>{title}</h1>
      {children && <div className="em-screenhead-right">{children}</div>}
    </div>
  )
}

/** A rounded filter / mode chip. `pressed` is announced (aria-pressed). */
export function Chip({ pressed, onClick, disabled, children, title }) {
  return (
    <button type="button" className={`em-chip${pressed ? ' is-on' : ''}`} aria-pressed={!!pressed} onClick={onClick} disabled={disabled} title={title}>{children}</button>
  )
}

/** The status chip of a route / place ("🟢 OPEN", "❌ UNAVAILABLE" ...). */
export const Tag = ({ tone = 'neutral', children }) => <span className={`em-tag is-${tone}`}>{children}</span>

/** value over label, as in the mockup's 3-stat rows. */
export function StatRow({ items }) {
  return (
    <dl className="em-stats">
      {items.map(([label, value, tone, sub]) => (
        <div key={label} className={tone ? `is-${tone}` : ''}>
          <dd>{value}</dd>
          <dt>{label}</dt>
          {sub && <small>{sub}</small>}
        </div>
      ))}
    </dl>
  )
}

export const Dots = () => <span className="em-spin" aria-hidden="true" />
