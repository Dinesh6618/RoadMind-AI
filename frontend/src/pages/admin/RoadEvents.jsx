import { ArrowLeft, CircleCheck, ClipboardCheck, OctagonX, RefreshCw, Siren, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { Empty, ErrorBox, Spinner, Stat } from '../../components'
import { ago, parseIso } from '../report/eventTime'
import CreateEventPanel from './events/CreateEventPanel'
import EventCard from './events/EventCard'
import { EVENT_TYPE_ORDER, bucketOf, explain } from './events/util'
import '../events.css'

const PAGE = 200
const MAX_EVENTS = 1000 // the page loads at most this many (newest first, reports needing a decision first)
const REFRESH_MS = 60000
const DAY = 86400000

const TABS = [
  ['review', 'Needs review', 'Nothing is waiting for review. New community reports appear here until someone verifies or rejects them.'],
  ['active', 'Active', 'No verified event is in effect right now.'],
  ['closed', 'Resolved / expired', 'No resolved or expired events yet. Reports nobody confirmed in time also end up here, and can still be verified.'],
  ['rejected', 'Rejected', 'No report has been rejected.'],
  ['all', 'All', 'No road events have been recorded yet. Use "Record an event" to add one.'],
]

/** Every event, paged: the tabs, the type filter and the counts are all worked out from this one list. */
async function loadEvents() {
  const items = []
  let total = 0, types = null
  for (let offset = 0; offset < MAX_EVENTS; offset += PAGE) {
    const d = await api(`/road-events?limit=${PAGE}&offset=${offset}`)
    total = d.total
    types = d.types || types
    items.push(...d.items)
    if (items.length >= total || d.items.length === 0) break
  }
  return { items, total, types }
}

/**
 * Staff page for road events: verify or reject community reports, mark roads blocked or reopened, update construction,
 * attach evidence. Administrators and road-maintenance staff can do all of it (the server enforces it); `portal` only picks
 * where the links go.
 */
export default function RoadEvents({ portal = 'admin' }) {
  const { logout } = useAuth()
  const [data, setData] = useState(null) // { items, total, types }
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [refreshedAt, setRefreshedAt] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [tab, setTab] = useState('review')
  const [type, setType] = useState('')
  const [banner, setBanner] = useState(null)
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    setRefreshing(true)
    try {
      const d = await loadEvents()
      if (mine !== seq.current) return
      setData(d); setError(null); setRefreshedAt(Date.now())
    } catch (err) {
      if (mine !== seq.current) return
      if (err.status === 401) logout()
      setError(explain(err))
    } finally {
      if (mine === seq.current) { setLoading(false); setRefreshing(false) }
    }
  }, [logout])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { // refresh every minute while the tab is visible; coming back to a stale tab refreshes at once
    const tick = () => { if (document.visibilityState === 'visible') refresh() }
    const id = setInterval(tick, REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])
  useEffect(() => { // keeps "5 min ago" honest between refreshes
    const id = setInterval(() => setNow(Date.now()), 20000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => { // back on a tab that stayed hidden for a while
    const onVisible = () => { if (document.visibilityState === 'visible' && refreshedAt && Date.now() - refreshedAt > REFRESH_MS) refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh, refreshedAt])

  const items = data?.items
  const stats = useMemo(() => {
    if (!items) return null
    const s = { review: 0, reviewExpired: 0, blocking: 0, active: 0, closed30: 0, closed: 0, rejected: 0 }
    for (const ev of items) {
      const b = bucketOf(ev)
      if (b === 'review') { s.review += 1; if (ev.display_status === 'EXPIRED') s.reviewExpired += 1 }
      else if (b === 'active') { s.active += 1; if (ev.is_blocking) s.blocking += 1 }
      else if (b === 'closed') { s.closed += 1; const t = parseIso(ev.created_at); if (t && now - t.getTime() <= 30 * DAY) s.closed30 += 1 }
      else s.rejected += 1
    }
    return s
  }, [items, now])

  const typeOptions = useMemo(() => {
    const seen = new Set((items || []).map((e) => e.event_type))
    const known = data?.types || {}
    return EVENT_TYPE_ORDER.filter((t) => seen.has(t) || known[t]).map((t) => [t, known[t]?.label || t])
  }, [items, data])

  const shown = useMemo(() => (items || []).filter((e) => (tab === 'all' || bucketOf(e) === tab) && (!type || e.event_type === type)), [items, tab, type])
  const count = (t) => (!stats ? null : t === 'all' ? items.length : t === 'review' ? stats.review : t === 'active' ? stats.active : t === 'closed' ? stats.closed : stats.rejected)

  const done = useCallback((message) => { setBanner(message); refresh() }, [refresh])

  return (
    <div className="stack ev-page">
      <div className="row between">
        <Link className="ev-back" to={`/${portal}/dashboard`}><ArrowLeft size={16} aria-hidden="true" /> Back to dashboard</Link>
        <div className="row">
          <span className="small muted" aria-live="polite">Last refreshed: {refreshedAt ? ago(new Date(refreshedAt).toISOString(), now) : 'not yet'}</span>
          <button type="button" className="btn btn-small" onClick={() => refresh()} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'ev-spin' : ''} aria-hidden="true" /> {refreshing ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>

      <p className="ev-intro">
        Community reports stay <b>unverified</b> until you check them. <b>Verifying</b> makes a report count strongly in route recommendations, <b>rejecting</b> removes it, and <b>resolving</b> ends it.
        Every event expires, so nothing is blocked for ever. This page refreshes itself every minute while it is open.
      </p>

      <div className="stat-grid ev-stats">
        <Stat icon={ClipboardCheck} color="#f2b01e" label="Pending review" value={stats ? stats.review : '-'} hint={stats?.reviewExpired ? `${stats.reviewExpired} of them already expired` : 'Reports waiting for a decision'} />
        <Stat icon={OctagonX} color="#e0342f" label="Active blockages" value={stats ? stats.blocking : '-'} hint="Verified, in effect, routes avoid them" />
        <Stat icon={Siren} color="#d97706" label="Active events" value={stats ? stats.active : '-'} hint="Verified and in effect" />
        <Stat icon={CircleCheck} color="#4f6fe0" label="Resolved / expired" value={stats ? stats.closed30 : '-'} hint="Reported in the last 30 days" />
      </div>
      {data && data.total > items.length && <p className="small muted" style={{ margin: 0 }}>Showing the {items.length.toLocaleString()} newest of {data.total.toLocaleString()} events; the counts cover those.</p>}

      <CreateEventPanel types={data?.types} refreshKey={refreshedAt} onCreated={refresh} onUnauthorized={logout} />

      <div className="ev-toolbar">
        <div className="tabs ev-tabs" role="tablist" aria-label="Which events to show">
          {TABS.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
              {label}{count(key) != null ? <span className="ev-count">{count(key)}</span> : null}
            </button>
          ))}
        </div>
        <select className="ev-type-select" aria-label="Filter by event type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {typeOptions.map(([t, label]) => <option key={t} value={t}>{label}</option>)}
        </select>
      </div>

      {banner && (
        <div className="alert alert-ok ev-banner" role="status">
          <CircleCheck size={18} aria-hidden="true" style={{ flex: 'none' }} />
          <span>{banner}</span>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setBanner(null)} aria-label="Dismiss this message"><X size={16} aria-hidden="true" /></button>
        </div>
      )}
      <ErrorBox error={error} onRetry={() => refresh()} />
      {loading && <Spinner />}

      {!loading && data && (
        shown.length === 0 ? (
          <div className="card"><Empty icon={Siren}>{type ? 'No events of this type in this view.' : TABS.find((t) => t[0] === tab)[2]}</Empty></div>
        ) : (
          <div className="ev-list" role="list" aria-label="Road events">
            {shown.map((ev) => <EventCard key={ev.id} ev={ev} portal={portal} now={now} onDone={done} onUnauthorized={logout} />)}
          </div>
        )
      )}
    </div>
  )
}
