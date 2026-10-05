import { ChevronDown, Layers } from 'lucide-react'
import { useId, useState } from 'react'
import { CONDITION_LABELS, STATE_COLORS } from '../../format'
import { BLOCKED_RED, EVENT_ORANGE, PENDING_AMBER } from './overlays'

const STATES = ['GOOD', 'MODERATE', 'HIGH_RISK', 'CRITICAL']

const startsOpen = () => {
  // collapsed on a phone and on a short window, to leave the map free
  try { return !window.matchMedia('(max-width: 820px)').matches && window.innerHeight >= 740 } catch { return true }
}

/**
 * Layer switches (RoadMind condition, Road events) and the legend, in one small glass box.
 * The Google traffic toggle lives inside the map itself (MapCanvas); the legend only says what its colours mean, and
 * says "Live traffic unavailable" whenever the Google traffic layer is not showing.
 */
export default function LayersBox({ showConditions, showEvents, onConditions, onEvents, status }) {
  const [open, setOpen] = useState(startsOpen)
  const bodyId = useId()
  const traffic = !!(status && status.engine === 'google' && status.ready && status.trafficLayer)
  const trafficOffByUser = !!(status && status.engine === 'google' && status.ready && !status.trafficLayer)

  return (
    <section className="rm-layers glass" aria-label="Map layers and legend">
      <button type="button" className="rm-layers__head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <Layers size={16} aria-hidden="true" /> Layers &amp; legend <ChevronDown size={16} aria-hidden="true" className={`rm-layers__chev${open ? ' is-open' : ''}`} />
      </button>
      <div id={bodyId} className="rm-layers__body" hidden={!open}>
        <div className="rm-switches" role="group" aria-label="Show on the map">
          <label className="rm-switch">
            <input type="checkbox" checked={showConditions} onChange={(e) => onConditions(e.target.checked)} />
            <span>RoadMind condition</span>
          </label>
          <label className="rm-switch">
            <input type="checkbox" checked={showEvents} onChange={(e) => onEvents(e.target.checked)} />
            <span>Road events</span>
          </label>
        </div>

        <div className="rm-legend">
          <div className="rm-legend__title">RoadMind road condition</div>
          <ul className="rm-legend__list">
            {STATES.map((s) => (
              <li key={s}><i className="rm-swatch" style={{ '--c': STATE_COLORS[s] }} aria-hidden="true" />{CONDITION_LABELS[s]}</li>
            ))}
          </ul>
          <div className="rm-legend__title">Road events</div>
          <ul className="rm-legend__list">
            <li><i className="rm-dot" style={{ '--c': BLOCKED_RED }} aria-hidden="true">🚧</i>Blocked (verified)</li>
            <li><i className="rm-dot" style={{ '--c': EVENT_ORANGE }} aria-hidden="true">⚠</i>Verified event</li>
            <li><i className="rm-dot" style={{ '--c': PENDING_AMBER }} aria-hidden="true">?</i>Unverified report</li>
          </ul>
          <div className="rm-legend__title">Live traffic</div>
          {traffic ? (
            <div className="rm-legend__traffic">
              <i className="rm-trafficbar" aria-hidden="true" />
              <span>Google live traffic: green normal / yellow-orange moderate-heavy / red jam</span>
            </div>
          ) : (
            <div className="rm-legend__traffic"><span>{trafficOffByUser ? 'Live traffic is switched off (use the Traffic button).' : 'Live traffic unavailable'}</span></div>
          )}
          <p className="rm-legend__fine">A road with no RoadMind line has no condition data yet - that does not mean it is good or damaged.</p>
        </div>
      </div>
    </section>
  )
}
