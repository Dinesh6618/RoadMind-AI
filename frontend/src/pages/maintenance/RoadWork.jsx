import { Upload, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { useAdminApi, useAuth } from '../../auth'
import { Badge, ErrorBox, FactorBars, PriorityBadge, RiskBadge, SeverityBadge, Spinner, StatusBadge } from '../../components'
import { STATUS_LABELS, fmtDate, highwayLabel, num, timeAgo } from '../../format'
import './maintenance.css'

const COMPONENT_LABELS = {
  severity: 'Severity', risk: 'Predicted risk', danger: 'Danger (severity + risk)', reports: 'Recent reports', traffic: 'Traffic',
  facilities: 'Schools / hospitals nearby', people_affected: 'People affected', time_since_repair: 'Time since repair', exposure: 'Exposure',
}
const MAX_BYTES = 8 * 1024 * 1024
const TYPES = ['image/jpeg', 'image/png', 'image/webp']
const NEXT_STEP = { pending: 'inspected', inspected: 'repair_planned', repair_planned: 'repair_completed' } // the button to highlight
const REPORTS_SHOWN = 4

/** Local calendar date as YYYY-MM-DD (the planned repair date cannot be in the past). */
function todayISO() {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 10)
}

const KindBadge = ({ kind }) =>
  kind === 'repair' ? <Badge color="var(--good)" ink="var(--good-ink)">Repair</Badge> : <Badge color="var(--brand)" ink="var(--brand-ink)">Inspection</Badge>

function checkFile(f) {
  if (!f) return null
  if (!TYPES.includes(f.type)) return 'Choose a JPEG, PNG or WebP photo.'
  if (f.size === 0) return 'That file is empty.'
  if (f.size > MAX_BYTES) return 'That photo is larger than 8 MB. Choose a smaller one.'
  return null
}

/** Mark inspected / repair planned / repair completed, with an optional note, or just add a note. */
function Actions({ road, onSaved }) {
  const { logout } = useAuth()
  const uid = useId()
  const status = road.priority?.status || road.maintenance_status
  const next = NEXT_STEP[status]
  const [note, setNote] = useState('')
  const [plannedDate, setPlannedDate] = useState('')
  const [busy, setBusy] = useState(null) // 'inspected' | 'repair_planned' | 'repair_completed' | 'note'
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)

  async function run(kind) {
    if (kind === 'repair_completed' && !window.confirm(`Mark the repair on "${road.name}" as completed?\n\nIts severity history will restart from today. You can attach photos of the finished work in the Photo evidence section (before or after).`)) return
    setBusy(kind); setError(null); setSaved(null)
    try {
      const text = note.trim()
      if (kind === 'note') {
        await api(`/staff/roads/${road.id}/notes`, { method: 'POST', json: { note: text } })
        setSaved('Note added to the maintenance log.')
      } else {
        const body = { status: kind }
        if (text) body.notes = text
        if (kind === 'repair_planned' && plannedDate) body.planned_date = plannedDate
        await api(`/staff/roads/${road.id}/status`, { method: 'PATCH', json: body })
        setSaved(`Saved: ${STATUS_LABELS[kind]}${text ? ' (note added)' : ''}.`)
      }
      setNote('')
      onSaved()
    } catch (err) {
      if (err.status === 401) logout()
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  const btn = (kind, label) => (
    <button type="button" className={`btn mt-tap ${next === kind ? 'btn-primary' : ''}`} disabled={!!busy} onClick={() => run(kind)}>
      {busy === kind ? 'Saving…' : label}
    </button>
  )

  return (
    <section className="mt-block" aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`}>Actions</h3>
      <div className="mt-status-btns">
        {btn('inspected', 'Mark inspected')}
        {btn('repair_planned', 'Mark repair planned')}
        {btn('repair_completed', 'Mark repair completed')}
      </div>
      <div className="mt-field">
        <label htmlFor={`${uid}-date`}>Planned repair date</label>
        <input id={`${uid}-date`} type="date" className="input" min={todayISO()} value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} aria-describedby={`${uid}-date-h`} />
        <div className="hint" id={`${uid}-date-h`}>Optional, used with “Mark repair planned”. Left empty, the repair is planned for 14 days from today.</div>
      </div>
      <div className="mt-field">
        <label htmlFor={`${uid}-note`}>Note</label>
        <textarea id={`${uid}-note`} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby={`${uid}-note-h`} placeholder="What did you find or do?" />
        <div className="hint" id={`${uid}-note-h`}>Saved with your name and today’s date. It is sent along with a status button above, or on its own with “Add note only”.</div>
      </div>
      <button type="button" className="btn btn-soft mt-tap" disabled={!!busy || !note.trim()} onClick={() => run('note')}>
        {busy === 'note' ? 'Saving…' : 'Add note only'}
      </button>
      <div className="mt-live" role="status">{saved && <div className="alert alert-ok">{saved}</div>}</div>
      <ErrorBox error={error} />
    </section>
  )
}

/** Upload form and gallery of the photos already on file for this road. */
function Evidence({ road, onSaved }) {
  const { logout } = useAuth()
  const uid = useId()
  const status = road.priority?.status || road.maintenance_status
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [fileError, setFileError] = useState(null)
  const [kindChoice, setKindChoice] = useState(null) // null = suggest from the road's status
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)
  const [inputKey, setInputKey] = useState(0) // changing it clears the file input
  const kind = kindChoice ?? (status === 'repair_planned' || status === 'repair_completed' ? 'repair' : 'inspection')
  const photos = road.evidence || []

  useEffect(() => {
    if (!file) { setPreview(null); return undefined }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function choose(e) {
    const f = e.target.files?.[0] || null
    const problem = checkFile(f)
    setDone(null); setError(null)
    if (problem) {
      setFile(null); setFileError(problem); setInputKey((k) => k + 1)
      return
    }
    setFileError(null); setFile(f)
  }

  async function upload(e) {
    e.preventDefault()
    if (!file) { setFileError('Choose a photo first.'); return }
    setBusy(true); setError(null); setDone(null)
    try {
      const form = new FormData()
      form.append('image', file)
      form.append('kind', kind)
      form.append('caption', caption.trim())
      await api(`/staff/roads/${road.id}/evidence`, { method: 'POST', form })
      setFile(null); setCaption(''); setInputKey((k) => k + 1)
      setDone(`${kind === 'repair' ? 'Repair' : 'Inspection'} photo uploaded.`)
      onSaved()
    } catch (err) {
      if (err.status === 401) logout()
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-block" aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`}>Photo evidence {photos.length > 0 && <span className="mt-count">{photos.length}</span>}</h3>
      <form className="mt-upload" onSubmit={upload} noValidate>
        <div className="mt-field">
          <label htmlFor={`${uid}-file`}>Photo</label>
          <input key={inputKey} id={`${uid}-file`} type="file" className="input mt-file" accept="image/jpeg,image/png,image/webp" onChange={choose} aria-describedby={`${uid}-file-h`} aria-invalid={fileError ? 'true' : undefined} />
          <div className="hint" id={`${uid}-file-h`}>JPEG, PNG or WebP, up to 8 MB. Location data is removed from the photo when it is stored.</div>
          {fileError && <div className="form-error" role="alert">{fileError}</div>}
        </div>
        {preview && <img className="mt-preview" src={preview} alt="Preview of the photo you selected" />}
        <div className="mt-field">
          <label htmlFor={`${uid}-kind`}>Type of photo</label>
          <select id={`${uid}-kind`} value={kind} onChange={(e) => setKindChoice(e.target.value)}>
            <option value="inspection">Inspection</option>
            <option value="repair">Repair</option>
          </select>
        </div>
        <div className="mt-field">
          <label htmlFor={`${uid}-cap`}>Caption <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
          <input id={`${uid}-cap`} className="input" maxLength={300} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="e.g. Pothole filled and compacted" />
        </div>
        <button type="submit" className="btn btn-primary mt-tap" disabled={busy || !file}>
          <Upload size={18} aria-hidden="true" />{busy ? 'Uploading…' : 'Upload photo'}
        </button>
        <ErrorBox error={error} />
      </form>
      <div className="mt-live" role="status">{done && <div className="alert alert-ok">{done}</div>}</div>

      {photos.length === 0 ? <p className="muted small mt-after">No photos uploaded for this road yet.</p> : (
        <ul className="mt-gallery" aria-label="Uploaded photos">
          {photos.map((p) => (
            <li key={p.id}>
              <figure className="mt-shot">
                <a href={p.url} target="_blank" rel="noreferrer">
                  <img src={p.url} loading="lazy" alt={`${p.kind === 'repair' ? 'Repair' : 'Inspection'} photo${p.caption ? `: ${p.caption}` : ''}`} />
                  <span className="sr-only"> (opens the full image in a new tab)</span>
                </a>
                <figcaption>
                  <span><KindBadge kind={p.kind} /></span>
                  {p.caption && <span className="mt-cap">{p.caption}</span>}
                  <span className="muted">{p.by} · {fmtDate(p.created_at, true)}</span>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function RecentReports({ road }) {
  const [all, setAll] = useState(false)
  const reports = road.recent_reports || []
  const shown = all ? reports : reports.slice(0, REPORTS_SHOWN)
  return (
    <section className="mt-block" aria-label="Recent damage reports">
      <h3>Recent reports</h3>
      {reports.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No damage reports on this road yet.</p> : (
        <>
          <ul className="mt-mini-list">
            {shown.map((r) => (
              <li key={r.id} className="mt-mini">
                {r.annotated_url ? (
                  <a href={r.annotated_url} target="_blank" rel="noreferrer">
                    <img className="mt-thumb" src={r.annotated_url} loading="lazy" alt={`Annotated photo of report ${r.id}: ${r.damage_summary || 'damage'}`} />
                    <span className="sr-only"> (opens the full image in a new tab)</span>
                  </a>
                ) : <span className="mt-nophoto">no photo</span>}
                <div>
                  <div className="mt-mini-title"><strong className="small">{r.damage_summary || 'Damage report'}</strong> <SeverityBadge level={r.severity_level} /></div>
                  <div className="small muted">#{r.id} · {fmtDate(r.reported_at)}{r.source === 'seed' ? ' · simulated' : ''}</div>
                  {r.description && <div className="small mt-clip">{r.description}</div>}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-link-row" style={{ marginTop: 12 }}>
            {reports.length > REPORTS_SHOWN && (
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setAll((v) => !v)} aria-expanded={all}>{all ? 'Show fewer' : `Show all ${reports.length}`}</button>
            )}
            <Link className="small" to={`/maintenance/reports?road=${road.id}`}>All reports for this road</Link>
          </div>
        </>
      )}
    </section>
  )
}

function Panel({ roadId, onClose, onChanged }) {
  const detail = useAdminApi(`/staff/roads/${roadId}`)
  const d = detail.data && Number(detail.data.id) === Number(roadId) ? detail.data : null
  const afterChange = () => { detail.reload(); onChanged?.() }
  const closeBtn = onClose && (
    <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close road panel"><X size={18} aria-hidden="true" /></button>
  )

  if (detail.error) {
    return (
      <div className="card stack">
        <div className="row between"><h2 className="mt-h">Road #{roadId}</h2>{closeBtn}</div>
        <ErrorBox error={detail.error} onRetry={detail.reload} />
      </div>
    )
  }
  if (!d) return <div className="card"><Spinner label="Loading road…" /></div>

  const pr = d.priority
  const comps = pr?.components
  const status = pr?.status || d.maintenance_status
  const category = pr?.category || d.priority_category
  const score = pr?.score ?? d.priority_score
  const action = pr?.action || d.recommended_action
  const notes = pr?.notes

  return (
    <article className="card stack" aria-label={`Work panel for ${d.name}`}>
      <div className="mt-work-head">
        <div>
          <h2>{d.name}</h2>
          <div className="small muted">{d.zone} · {highwayLabel(d.highway)} · {d.traffic_level} traffic (est.) · #{d.id}</div>
          {d.assigned_to && <div className="small muted">Assigned to {d.assigned_to.name}</div>}
        </div>
        {closeBtn}
      </div>

      <div>
        <div className="mt-badges">
          <SeverityBadge level={d.severity_level} />
          <RiskBadge level={d.risk_level} percent={d.risk_percent} />
          {category && <PriorityBadge category={category} />}
          {score != null && <span className="mt-score">{Math.round(score)}/100</span>}
          <StatusBadge status={status} />
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          Severity {num(d.current_severity)}/100 · {d.report_count} report{d.report_count === 1 ? '' : 's'}{d.last_report_at ? ` · last ${timeAgo(d.last_report_at)}` : ''}
        </div>
      </div>

      {action && <p className="mt-recommend"><strong>Recommended:</strong> {action}</p>}

      {comps && (
        <section className="mt-block" aria-label="How the priority was calculated">
          <h3>How the priority was calculated</h3>
          <FactorBars items={Object.entries(COMPONENT_LABELS).map(([k, label]) => ({ label, value: comps[k] ?? 0 }))} />
          <p className="small muted" style={{ margin: '10px 0 0' }}>Priority = 100 × danger × {comps.multiplier} (context multiplier from exposure).</p>
        </section>
      )}

      <Actions road={d} onSaved={afterChange} />
      <Evidence road={d} onSaved={afterChange} />

      <section className="mt-block" aria-label="Maintenance notes">
        <h3>Maintenance notes</h3>
        {notes ? <div className="note-log" tabIndex={0} role="region" aria-label="Maintenance notes log">{notes}</div> : <p className="muted small" style={{ margin: 0 }}>No notes yet.</p>}
      </section>

      <section className="mt-block" aria-label="Repair history">
        <h3>Repair history</h3>
        {d.repairs.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No repairs on file.</p> : (
          <ul className="small mt-history">
            {d.repairs.slice(0, 5).map((r, i) => (
              <li key={i}>{r.status === 'completed' ? `Completed ${fmtDate(r.completed_date)}` : `Planned for ${fmtDate(r.planned_date)}`}{r.notes ? ` — ${r.notes}` : ''}</li>
            ))}
          </ul>
        )}
      </section>

      <RecentReports road={d} />
      {d.disclaimer && <p className="small muted" style={{ margin: 0 }}>{d.disclaimer}</p>}
    </article>
  )
}

/** Work panel for one road: priority, status actions, notes, photo evidence and recent reports. */
export default function RoadWork({ roadId, onClose, onChanged }) {
  // keyed by road so that drafts (note, photo) never leak from one road to the next
  return <Panel key={roadId} roadId={roadId} onClose={onClose} onChanged={onChanged} />
}
