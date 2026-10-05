import { Camera, Info, Navigation, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Spinner, StateBadge } from '../../components'
import { highwayLabel, num, timeAgo } from '../../format'
import { coordLabel } from './geocode'
import { eventColor, eventKind, eventStatusText, reopeningText, reportedAgo, verifiedText } from './overlays'

/** The side / bottom-sheet panels of the map page: a road with RoadMind data, a road event, a spot with no RoadMind data. */

const apiBase = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')
const mediaUrl = (u) => (!u ? null : /^https?:/i.test(u) ? u : `${apiBase}${u}`)

/** What the Live traffic row says. Never a number: RoadMind has no traffic data of its own, Google draws it on the map. */
export function liveTrafficText(status) {
  if (status && status.engine === 'google' && status.ready) return status.trafficLayer ? 'Shown on the map (Google live traffic layer)' : 'Switched off on the map (use the Traffic button)'
  return 'Live traffic unavailable'
}

/** Shell: glass panel, labelled, focused when it opens (keyboard users land in it), closes with the X (Escape is handled by the page). */
function Panel({ label, onClose, children, tone }) {
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  return (
    <aside ref={ref} tabIndex={-1} className={`rm-panel glass${tone ? ` is-${tone}` : ''}`} role="region" aria-label={label}>
      <button type="button" className="btn btn-icon btn-ghost close btn-small rm-panel__close" onClick={onClose} aria-label="Close panel"><X size={18} /></button>
      {children}
    </aside>
  )
}

const Fact = ({ label, children }) => <div className="fact"><span>{label}</span><b>{children}</b></div>

/** Reason / Reported / Verified / Expected reopening of one event - shared by the event panel and a blocked road's card. */
function EventFacts({ ev }) {
  const reopening = reopeningText(ev)
  return (
    <>
      <Fact label="Reason">{ev.event_type_label}{ev.description ? <> - <span className="rm-desc">{ev.description}</span></> : null}</Fact>
      <Fact label="Reported">{reportedAgo(ev)}</Fact>
      <Fact label="Verified"><span className={ev.verified ? 'rm-yes' : 'rm-no'}>{verifiedText(ev)}</span></Fact>
      {reopening && <Fact label="Expected reopening">{reopening} <small className="muted">(estimate)</small></Fact>}
    </>
  )
}

function Evidence({ url }) {
  const src = mediaUrl(url)
  if (!src) return null
  return (
    <a className="rm-evidence" href={src} target="_blank" rel="noreferrer" aria-label="Open the evidence photo in a new tab">
      <img src={src} alt="Evidence photo for this report" loading="lazy" />
      <span>Evidence photo</span>
    </a>
  )
}

/** A short list of events with a button each (a road's other events, or the events under a clicked spot). */
function EventList({ events, onOpenEvent, title }) {
  if (!events.length) return null
  return (
    <div className="rm-evlist">
      <div className="rm-sub">{title}</div>
      <ul>
        {events.map((e) => (
          <li key={e.id}>
            <button type="button" className="rm-evbtn" onClick={() => onOpenEvent(e)} style={{ '--c': eventColor(e) }}>
              <span aria-hidden="true" className="rm-evbtn__ico">{e.verified || e.is_blocking ? e.emoji : '?'}</span>
              <span className="rm-evbtn__txt"><b>{eventStatusText(e)}</b><small>{e.road_name || 'Reported location'}</small></span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* -------------------------------------------------------------------------------------- a road that has RoadMind data */
export function RoadPanel({ item, applying, status, at, onClose, onDetails, onOpenEvent }) {
  const navigate = useNavigate()
  const here = at || { lat: item.lat, lng: item.lng }
  const blocking = applying.filter((e) => e.is_blocking)
  const others = applying.filter((e) => !e.is_blocking)
  const hasHere = Number.isFinite(here?.lat) && Number.isFinite(here?.lng)
  const getRoute = () => navigate(`/user/routes?toLat=${here.lat.toFixed(6)}&toLng=${here.lng.toFixed(6)}&toName=${encodeURIComponent(item.name || '')}`)
  const conf = item.ai_confidence != null ? `${Math.round(item.ai_confidence * 100)}%` : '—'
  const risk = item.risk_percent != null ? `${item.risk_percent}%${item.risk_level ? ` · ${item.risk_level[0] + item.risk_level.slice(1).toLowerCase()}` : ''}` : '—'
  const sev = item.severity ?? item.current_severity

  return (
    <Panel label={`Road: ${item.name}`} onClose={onClose}>
      <h3>{item.name}</h3>
      <div className="muted small">{highwayLabel(item.highway)}{item.length_m != null ? ` · ${num(item.length_m)} m` : ''}</div>
      <div className="facts rm-facts">
        <Fact label="Live traffic">{liveTrafficText(status)}</Fact>
        <Fact label="RoadMind condition"><StateBadge state={item.state} /></Fact>
        <Fact label="Latest damage">{item.damage_type || 'None recorded'}</Fact>
        <Fact label="Severity">{sev != null ? `${Math.round(sev)}/100` : '—'}</Fact>
        <Fact label="AI confidence">{conf}</Fact>
        <Fact label="Potholes / Cracks">{item.pothole_count != null ? `${item.pothole_count} / ${item.crack_count ?? 0}` : '—'}</Fact>
        <Fact label="User reports">{item.report_count ?? 0}{item.reports_90d != null ? ` (${item.reports_90d} in 90 days)` : ''}</Fact>
        <Fact label="Last report">{item.last_report_at ? timeAgo(item.last_report_at) : 'none yet'}</Fact>
        <Fact label="Predicted deterioration risk (about 90 days)">{risk}</Fact>
        <Fact label="Maintenance">{item.maintenance_status_label || '—'}{item.priority_category ? ` · ${item.priority_category}` : ''}</Fact>
        <Fact label="Road status">
          {blocking.length ? <span className="rm-blocked-tag">🚧 BLOCKED</span> : <span className="rm-open-tag">OPEN</span>}
        </Fact>
      </div>
      {blocking.length > 0 && (
        <div className="facts rm-facts rm-blockbox" aria-label="Why this road is shown as blocked">
          <EventFacts ev={blocking[0]} />
          {blocking.length > 1 && <div className="small muted">+ {blocking.length - 1} more blocking {blocking.length - 1 === 1 ? 'event' : 'events'} here</div>}
          <button type="button" className="rm-link" onClick={() => onOpenEvent(blocking[0])}>Open the event details</button>
        </div>
      )}
      {!blocking.length && !others.length && <p className="small muted rm-oknote">No blocking event has been reported to RoadMind for this road.</p>}
      <EventList events={others} onOpenEvent={onOpenEvent} title={blocking.length ? 'Other events here' : 'Road events here'} />
      {item.simulated && <p className="small rm-sim">Simulated demo data - not a real observation.</p>}
      <p className="small muted rm-fine">AI-generated estimates from reports and road data - not an official assessment and never a guarantee of safety.</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={() => onDetails(item)}>View Details</button>
        {hasHere && <button type="button" className="btn" onClick={getRoute}><Navigation size={17} aria-hidden="true" /> Get Route</button>}
      </div>
    </Panel>
  )
}

/* ------------------------------------------------------------------------------------------- a road event */
export function EventPanel({ ev, ended, staffRole, onClose }) {
  const kind = eventKind(ev)
  const eventsPage = staffRole === 'admin' ? '/admin/events' : staffRole === 'maintenance' ? '/maintenance/events' : null
  const avoid = `/user/routes?avoidLat=${ev.lat.toFixed(6)}&avoidLng=${ev.lng.toFixed(6)}&avoidName=${encodeURIComponent(ev.road_name || '')}&avoidEvent=${ev.id}`
  return (
    <Panel label={`Road event: ${ev.event_type_label}`} onClose={onClose} tone={kind}>
      <h3 className="rm-evhead"><span aria-hidden="true">{ev.emoji}</span> {ev.event_type_label}</h3>
      {kind === 'pending' && (
        <p className="rm-pending" role="note"><TriangleAlert size={16} aria-hidden="true" /> <span><b>Unverified report.</b> A community member reported this; authorised staff have not confirmed it yet. It does not close the road by itself.</span></p>
      )}
      {ended && <p className="rm-pending" role="status"><Info size={16} aria-hidden="true" /> <span>This event is no longer in the active list - it may have ended. The details below are from when you opened it.</span></p>}
      <div className="facts rm-facts">
        <Fact label="Road">{ev.road_name || 'Reported location'}</Fact>
        <Fact label="Status"><span className={kind === 'blocking' ? 'rm-blocked-tag' : kind === 'pending' ? 'rm-pending-tag' : 'rm-verified-tag'}>{eventStatusText(ev)}</span></Fact>
        <EventFacts ev={ev} />
      </div>
      <Evidence url={ev.evidence_url} />
      <p className="small muted rm-fine">Expected times are estimates. RoadMind shows only what has been reported to it - check the road before you rely on it.</p>
      <div className="actions rm-actions-col">
        <Link className="btn btn-primary" to={avoid}><Navigation size={17} aria-hidden="true" /> Get a route avoiding this</Link>
        {eventsPage && <Link className="btn" to={eventsPage}>Open Road events page</Link>}
      </div>
    </Panel>
  )
}

/* ---------------------------------------------------------------- a spot / road RoadMind has no condition data for */
export function NoDataPanel({ at, name, resolving, unavailable, nearby, onClose, onOpenEvent }) {
  const navigate = useNavigate()
  const label = name || coordLabel(at)
  const q = `lat=${at.lat.toFixed(6)}&lng=${at.lng.toFixed(6)}`
  return (
    <Panel label={`Selected road: ${label}`} onClose={onClose}>
      <h3>Road: {resolving && !name ? <span className="muted">looking up the name…</span> : label}</h3>
      <div className="facts rm-facts">
        <Fact label="RoadMind status">Condition data unavailable</Fact>
      </div>
      <p className="small rm-nodata-text">
        {unavailable
          ? 'RoadMind condition data is temporarily unavailable, so this road\'s condition cannot be shown right now. That does not mean it is in good or bad condition.'
          : 'RoadMind has no condition information for this road yet. That does not mean it is in good or bad condition.'}
      </p>
      <EventList events={nearby} onOpenEvent={onOpenEvent} title="Road events here" />
      <div className="actions rm-actions-col">
        <button type="button" className="btn btn-primary" onClick={() => navigate(`/user/report?${q}${name ? `&road=${encodeURIComponent(name)}` : ''}`)}><Camera size={17} aria-hidden="true" /> Report damage here</button>
        <button type="button" className="btn" onClick={() => navigate(`/user/routes?toLat=${at.lat.toFixed(6)}&toLng=${at.lng.toFixed(6)}&toName=${encodeURIComponent(name || 'Selected location')}`)}><Navigation size={17} aria-hidden="true" /> Get Route</button>
      </div>
    </Panel>
  )
}

export function LookupPanel({ onClose }) {
  return (
    <Panel label="Checking this spot" onClose={onClose}>
      <Spinner label="Checking this road…" />
    </Panel>
  )
}
