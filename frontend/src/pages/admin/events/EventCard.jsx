import { Camera, CheckCircle2, Clock, Map as MapIcon, MapPin, PencilLine, RotateCcw, ShieldCheck, ShieldX, User as UserIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../../api'
import { Badge, ErrorBox } from '../../../components'
import { ago, fmtWhen, inFuture } from '../../report/eventTime'
import EventStatusChip from '../../report/EventStatusChip'
import { BLOCKING_TYPES, HOURS_MAX, HOURS_MIN, RADIUS_MAX, RADIUS_MIN, bucketOf, checkImage, explain, parseNumber } from './util'

const COLORS = { review: '#f2b01e', active: '#17a673', closed: '#94a3b8', rejected: '#e0342f' }

/** When the event stops counting, in words that fit its state. */
function timeline(ev, now) {
  const lines = []
  const pending = ev.verification_status === 'PENDING'
  if (ev.display_status === 'ACTIVE') {
    lines.push(`Expected reopening ~ ${fmtWhen(ev.expires_at)} (${inFuture(ev.expires_at, now)})`)
  } else if (ev.display_status === 'PENDING') {
    lines.push(`Unverified - stops counting ~ ${fmtWhen(ev.effective_expires_at)} (${inFuture(ev.effective_expires_at, now)}) unless verified`)
  } else if (ev.display_status === 'EXPIRED') {
    lines.push(pending ? `Expired unverified ${ago(ev.effective_expires_at, now)}` : `Expired ${ago(ev.expires_at, now)}`)
  } else if (ev.display_status === 'RESOLVED') {
    lines.push(`Resolved ${ago(ev.resolved_at, now) || ''}${ev.resolved_by ? ` by ${ev.resolved_by}` : ''}`.trim())
  } else if (ev.display_status === 'REJECTED') {
    lines.push(`Rejected${ev.verified_at ? ` ${ago(ev.verified_at, now)}` : ''}${ev.verified_by ? ` by ${ev.verified_by}` : ''}`)
  }
  if (ev.verification_status === 'VERIFIED' && ev.verified_by && ev.display_status !== 'RESOLVED') {
    lines.push(`${ev.reported_by?.kind === 'staff' ? 'Entered and verified' : 'Verified'} by ${ev.verified_by}${ev.verified_at ? ` ${ago(ev.verified_at, now)}` : ''}`)
  }
  return lines
}

/** One road event with the actions that make sense for its state. Every action asks for its details first, then confirms. */
export default function EventCard({ ev, portal, now, onDone, onUnauthorized }) {
  const [panel, setPanel] = useState(null) // 'verify' | 'reject' | 'resolve' | 'update' | 'evidence'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState('')
  const [hours, setHours] = useState('')
  const [description, setDescription] = useState(ev.description || '')
  const [roadName, setRoadName] = useState(ev.road_name || '')
  const [radius, setRadius] = useState(String(Math.round(ev.radius_m)))
  const [progress, setProgress] = useState('')
  const [file, setFile] = useState(null)

  const bucket = bucketOf(ev)
  const verified = ev.verification_status === 'VERIFIED'
  const pending = ev.verification_status === 'PENDING'
  const rejected = ev.verification_status === 'REJECTED'
  const resolved = ev.status === 'RESOLVED'
  const canVerify = pending || rejected
  const canReject = pending
  const canResolve = verified && ev.status === 'ACTIVE'
  const canUpdate = !rejected && !resolved
  const blockingType = BLOCKING_TYPES.includes(ev.event_type)
  const place = ev.road_name || 'Reported location'
  const mapTo = `/${portal}/map?lat=${ev.lat}&lng=${ev.lng}${ev.road_id ? `&focus=${ev.road_id}` : ''}`

  function open(name) {
    setError(null)
    setNote(''); setHours(''); setProgress(''); setFile(null)
    setDescription(ev.description || ''); setRoadName(ev.road_name || ''); setRadius(String(Math.round(ev.radius_m)))
    setPanel((p) => (p === name ? null : name))
  }

  async function run(job, message) {
    setBusy(true); setError(null)
    try {
      const updated = await job()
      setPanel(null)
      onDone(message(updated), updated)
    } catch (err) {
      if (err.status === 401) onUnauthorized()
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }
  const fail = (message) => setError(new Error(message))

  function doVerify(approved) {
    const h = parseNumber(hours, { min: HOURS_MIN, max: HOURS_MAX, label: 'Duration', unit: 'hours' })
    if (approved && h.error) return fail(h.error)
    const body = { approved, note: note.trim() }
    if (approved && h.value !== undefined) body.hours = h.value
    run(
      () => api(`/road-events/${ev.id}/verify`, { method: 'PATCH', json: body }),
      (u) => (approved
        ? `Verified: ${u.headline} - ${place}. It now counts strongly in route recommendations until about ${fmtWhen(u.expires_at)} unless you resolve it sooner.`
        : `Rejected: ${u.headline} - ${place}. It no longer counts in route recommendations.`),
    )
  }

  function doResolve() {
    run(
      () => api(`/road-events/${ev.id}/resolve`, { method: 'PATCH', json: { note: note.trim() } }),
      (u) => `${blockingType ? 'Road marked as reopened' : 'Marked resolved'}: ${u.headline} - ${place}. It no longer counts in route recommendations.`,
    )
  }

  function doUpdate() {
    const h = parseNumber(hours, { min: HOURS_MIN, max: HOURS_MAX, label: 'Duration', unit: 'hours' })
    const r = parseNumber(radius, { min: RADIUS_MIN, max: RADIUS_MAX, label: 'Radius', unit: 'metres' })
    if (h.error) return fail(h.error)
    if (r.error) return fail(r.error)
    let text = description.trim()
    if (progress.trim()) text = `${text}${text ? '\n' : ''}Progress (${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}): ${progress.trim()}`
    if (text.length > 1000) return fail('The description (with the progress update) is longer than 1000 characters.')
    const body = {}
    if (text !== (ev.description || '')) body.description = text
    if (roadName.trim() !== (ev.road_name || '')) body.road_name = roadName.trim()
    if (h.value !== undefined) body.hours = h.value
    if (r.value !== undefined && r.value !== Math.round(ev.radius_m)) body.radius_m = r.value
    if (Object.keys(body).length === 0) return fail('Nothing to save - change the description, the duration or the radius first.')
    run(
      () => api(`/road-events/${ev.id}`, { method: 'PATCH', json: body }),
      (u) => `Updated: ${u.headline} - ${place}.${body.hours ? ` It now lasts until about ${fmtWhen(u.expires_at)}.` : ''}`,
    )
  }

  function doEvidence() {
    const problem = checkImage(file)
    if (problem) return fail(problem)
    const form = new FormData()
    form.append('image', file)
    run(
      () => api(`/road-events/${ev.id}/evidence`, { method: 'POST', form }),
      (u) => `Photo attached to ${u.headline} - ${place}.`,
    )
  }

  return (
    <article className="card ev-card" style={{ '--ec': COLORS[bucket] }} aria-label={`${ev.event_type_label} at ${place}`}>
      <div className="ev-card-main">
        {ev.evidence_url ? (
          <a className="ev-thumb-link" href={ev.evidence_url} target="_blank" rel="noreferrer">
            <img className="ev-thumb" src={ev.evidence_url} loading="lazy" alt={`Evidence photo for report ${ev.id}`} />
            <span className="sr-only"> (opens the full photo in a new tab)</span>
          </a>
        ) : null}
        <div className="ev-card-body">
          <div className="ev-card-head">
            <span className="ev-emoji" aria-hidden="true">{ev.emoji}</span>
            <div className="ev-card-title">
              <h3>{ev.headline}</h3>
              <div className="small muted">{ev.event_type_label} · #{ev.id}</div>
            </div>
            <div className="ev-chips">
              <EventStatusChip status={ev.display_status} />
              {(ev.display_status === 'EXPIRED' || ev.display_status === 'RESOLVED') && !rejected && <Badge color="#64748b">{verified ? 'Was verified' : 'Was unverified'}</Badge>}
              {ev.is_blocking && <Badge dot color="#e0342f" ink="#a3191a" title="A verified blockage: route suggestions avoid it">Routes avoid this</Badge>}
            </div>
          </div>

          <div className="ev-meta">
            <span><MapPin size={15} aria-hidden="true" /> <b>{place}</b></span>
            <span className="muted">{ev.lat.toFixed(5)}, {ev.lng.toFixed(5)} · radius {Math.round(ev.radius_m)} m</span>
            <span><Clock size={15} aria-hidden="true" /> Reported {ago(ev.created_at, now)}</span>
            <span><UserIcon size={15} aria-hidden="true" /> {ev.reported_by?.kind === 'staff' ? 'Entered by staff' : 'Community report'}{ev.reported_by?.name ? ` - ${ev.reported_by.name}` : ''}</span>
          </div>

          {ev.description && <p className="ev-desc">{ev.description}</p>}
          <ul className="ev-times">{timeline(ev, now).map((t) => <li key={t}>{t}</li>)}</ul>
          {ev.review_note && <p className="ev-note"><b>Review note:</b> {ev.review_note}</p>}
        </div>
      </div>

      <div className="ev-actions">
        {canVerify && <button type="button" className="btn btn-small btn-primary" aria-expanded={panel === 'verify'} onClick={() => open('verify')} disabled={busy}><ShieldCheck size={16} aria-hidden="true" /> Verify</button>}
        {canReject && <button type="button" className="btn btn-small btn-danger" aria-expanded={panel === 'reject'} onClick={() => open('reject')} disabled={busy}><ShieldX size={16} aria-hidden="true" /> Reject (false report)</button>}
        {canResolve && <button type="button" className="btn btn-small" aria-expanded={panel === 'resolve'} onClick={() => open('resolve')} disabled={busy}><CheckCircle2 size={16} aria-hidden="true" /> {blockingType ? 'Mark road reopened' : 'Mark resolved'}</button>}
        {canUpdate && <button type="button" className="btn btn-small" aria-expanded={panel === 'update'} onClick={() => open('update')} disabled={busy}><PencilLine size={16} aria-hidden="true" /> Update / extend</button>}
        <button type="button" className="btn btn-small" aria-expanded={panel === 'evidence'} onClick={() => open('evidence')} disabled={busy}><Camera size={16} aria-hidden="true" /> {ev.evidence_url ? 'Replace photo' : 'Upload evidence'}</button>
        <Link className="btn btn-small btn-ghost" to={mapTo}><MapIcon size={16} aria-hidden="true" /> View on map</Link>
      </div>

      {panel && (
        <div className="ev-panel" role="group" aria-label="Confirm this action">
          {panel === 'verify' && (
            <>
              <p className="ev-panel-text">Verifying makes this report count <b>strongly</b> in route recommendations{blockingType ? ' - routes through it will be marked to avoid' : ''}. It stops counting when it expires or when you resolve it.{ev.display_status === 'EXPIRED' ? ' This report has already expired; verifying it makes it current again for the chosen time.' : ''}</p>
              <div className="ev-fields">
                <div className="field"><label htmlFor={`h-${ev.id}`}>Lasts (hours, optional)</label><input id={`h-${ev.id}`} className="input" type="number" min={HOURS_MIN} max={HOURS_MAX} step="1" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="default for this type" /></div>
                <div className="field ev-grow"><label htmlFor={`n-${ev.id}`}>Note (optional)</label><input id={`n-${ev.id}`} className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. confirmed by site visit" /></div>
              </div>
              <div className="row"><button type="button" className="btn btn-primary" onClick={() => doVerify(true)} disabled={busy}>{busy ? 'Verifying…' : 'Verify report'}</button><button type="button" className="btn btn-ghost" onClick={() => setPanel(null)} disabled={busy}>Cancel</button></div>
            </>
          )}
          {panel === 'reject' && (
            <>
              <p className="ev-panel-text">Rejecting marks this as a false or mistaken report. It stops counting in route recommendations at once.</p>
              <div className="field"><label htmlFor={`n-${ev.id}`}>Reason (optional)</label><input id={`n-${ev.id}`} className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. road was open when checked" /></div>
              <div className="row"><button type="button" className="btn btn-danger" onClick={() => doVerify(false)} disabled={busy}>{busy ? 'Rejecting…' : 'Reject report'}</button><button type="button" className="btn btn-ghost" onClick={() => setPanel(null)} disabled={busy}>Cancel</button></div>
            </>
          )}
          {panel === 'resolve' && (
            <>
              <p className="ev-panel-text">{blockingType ? 'Use this when the road is open again.' : 'Use this when the problem is over.'} Resolving ends the event: route suggestions stop taking it into account.</p>
              <div className="field"><label htmlFor={`n-${ev.id}`}>Note (optional)</label><input id={`n-${ev.id}`} className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. tree cleared, both lanes open" /></div>
              <div className="row"><button type="button" className="btn btn-primary" onClick={doResolve} disabled={busy}>{busy ? 'Saving…' : blockingType ? 'Mark road reopened' : 'Mark resolved'}</button><button type="button" className="btn btn-ghost" onClick={() => setPanel(null)} disabled={busy}>Cancel</button></div>
            </>
          )}
          {panel === 'update' && (
            <>
              <p className="ev-panel-text">Change the wording, how long it lasts (counted from now - use this to extend it) or how far around the point it applies.</p>
              <div className="field"><label htmlFor={`d-${ev.id}`}>Description</label><textarea id={`d-${ev.id}`} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
              {ev.event_type === 'CONSTRUCTION' && (
                <div className="field"><label htmlFor={`p-${ev.id}`}>Construction progress (added to the description)</label><input id={`p-${ev.id}`} className="input" maxLength={200} value={progress} onChange={(e) => setProgress(e.target.value)} placeholder="e.g. resurfacing about 60% done, one lane open" /></div>
              )}
              <div className="ev-fields">
                <div className="field ev-grow"><label htmlFor={`r-${ev.id}`}>Road name</label><input id={`r-${ev.id}`} className="input" maxLength={160} value={roadName} onChange={(e) => setRoadName(e.target.value)} /></div>
                <div className="field"><label htmlFor={`h-${ev.id}`}>Lasts (hours from now)</label><input id={`h-${ev.id}`} className="input" type="number" min={HOURS_MIN} max={HOURS_MAX} step="1" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="unchanged" /></div>
                <div className="field"><label htmlFor={`rd-${ev.id}`}>Radius (m)</label><input id={`rd-${ev.id}`} className="input" type="number" min={RADIUS_MIN} max={RADIUS_MAX} step="5" inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value)} /></div>
              </div>
              <div className="row"><button type="button" className="btn btn-primary" onClick={doUpdate} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button><button type="button" className="btn btn-ghost" onClick={() => setPanel(null)} disabled={busy}>Cancel</button></div>
            </>
          )}
          {panel === 'evidence' && (
            <>
              <p className="ev-panel-text">Attach a photo that shows the situation (JPEG, PNG or WebP, up to 8 MB). Photos are stored without location or device metadata.{ev.evidence_url ? ' It replaces the current photo.' : ''}</p>
              <div className="field">
                <label htmlFor={`f-${ev.id}`}>Photo</label>
                <input id={`f-${ev.id}`} className="input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { setError(null); setFile(e.target.files?.[0] || null) }} />
              </div>
              <div className="row"><button type="button" className="btn btn-primary" onClick={doEvidence} disabled={busy || !file}>{busy ? 'Uploading…' : 'Upload photo'}</button><button type="button" className="btn btn-ghost" onClick={() => setPanel(null)} disabled={busy}><RotateCcw size={15} aria-hidden="true" /> Cancel</button></div>
            </>
          )}
        </div>
      )}
      {error && <div className="ev-card-error"><ErrorBox error={error} /></div>}
    </article>
  )
}
