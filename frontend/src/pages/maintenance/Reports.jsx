import { FileText, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { Disclaimer, Empty, ErrorBox, SeverityBadge, Spinner } from '../../components'
import { fmtDate } from '../../format'
import './maintenance.css'

const PAGE = 25
const LEVELS = ['Critical', 'High', 'Moderate', 'Low']

/** Damage reports on your roads, newest first, 25 at a time. `?road=<id>` limits the list to one road. */
export default function Reports() {
  const { logout } = useAuth()
  const [params, setParams] = useSearchParams()
  const roadId = Number(params.get('road')) || null
  const [level, setLevel] = useState('')
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(null)
  const [tick, setTick] = useState(0)
  const generation = useRef(0) // a "load more" answer that arrives after the filters changed is dropped

  const pageUrl = useCallback((offset) => {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
    if (level) qs.set('level', level)
    if (roadId) qs.set('road_id', String(roadId))
    return `/staff/reports?${qs}`
  }, [level, roadId])

  // first page: on load, when a filter changes, and on "Try again"
  useEffect(() => {
    const ctl = new AbortController()
    generation.current += 1
    setLoading(true); setError(null); setMoreError(null); setItems([]); setTotal(0)
    api(pageUrl(0), { signal: ctl.signal })
      .then((d) => { setItems(d.items); setTotal(d.total); setLoading(false) })
      .catch((err) => {
        if (err.name === 'AbortError') return
        if (err.status === 401) logout()
        setError(err); setLoading(false)
      })
    return () => ctl.abort()
  }, [pageUrl, tick, logout])

  async function loadMore() {
    const mine = generation.current
    setLoadingMore(true); setMoreError(null)
    try {
      const d = await api(pageUrl(items.length))
      if (mine !== generation.current) return
      setItems((prev) => [...prev, ...d.items])
      setTotal(d.total)
    } catch (err) {
      if (err.status === 401) logout()
      if (mine === generation.current) setMoreError(err)
    } finally {
      setLoadingMore(false)
    }
  }

  const clearRoad = () => setParams({}, { replace: true })
  const roadName = items.find((r) => r.road_id === roadId)?.road_name
  const filtered = !!level || !!roadId

  return (
    <div className="stack">
      <div className="card">
        <div className="mt-toolbar">
          <div className="mt-filters">
            <select aria-label="Filter by severity level" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">All severities</option>
              {LEVELS.map((l) => <option key={l}>{l}</option>)}
            </select>
            {roadId && (
              <span className="mt-chip">
                {roadName || `Road #${roadId}`}
                <button type="button" className="btn btn-ghost" onClick={clearRoad} aria-label="Show reports for all roads"><X size={16} aria-hidden="true" /></button>
              </span>
            )}
          </div>
          <span className="small muted" aria-live="polite">{loading ? 'Loading…' : `Showing ${items.length.toLocaleString()} of ${total.toLocaleString()} reports`}</span>
        </div>
      </div>

      <ErrorBox error={error} onRetry={() => setTick((t) => t + 1)} />
      {loading && <Spinner />}

      {!loading && !error && (
        <section className="card card-flush" aria-label="Damage reports">
          {items.length === 0 ? (
            <Empty icon={FileText}>{filtered ? 'No damage reports match these filters.' : 'No damage reports on your roads yet.'}</Empty>
          ) : (
            <>
              <ul className="mt-reports">
                {items.map((r) => (
                  <li key={r.id} className="mt-report">
                    {r.annotated_url ? (
                      <a href={r.annotated_url} target="_blank" rel="noreferrer">
                        <img className="mt-thumb" src={r.annotated_url} loading="lazy" alt={`Annotated photo of report ${r.id}: ${r.damage_summary || 'damage'}`} />
                        <span className="sr-only"> (opens the full image in a new tab)</span>
                      </a>
                    ) : <span className="mt-nophoto">no photo</span>}
                    <div>
                      <div className="mt-report-title">
                        <strong>{r.damage_summary || 'Damage report'}</strong>
                        <SeverityBadge level={r.severity_level} />
                        {r.severity_score != null && <span className="small muted">{Math.round(r.severity_score)}/100</span>}
                      </div>
                      <div className="mt-report-meta">
                        <Link to={`/maintenance/roads?road=${r.road_id}`}>{r.road_name}</Link>
                        <span>Report #{r.id}</span>
                        <span>{fmtDate(r.reported_at, true)}</span>
                        {r.source === 'seed' && <span>simulated</span>}
                        {r.image_url && <a href={r.image_url} target="_blank" rel="noreferrer">Original photo<span className="sr-only"> of report {r.id} (opens in a new tab)</span></a>}
                      </div>
                      {r.description && <p className="mt-report-desc">{r.description}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              {items.length < total && (
                <div className="mt-more">
                  <button type="button" className="btn btn-soft mt-tap" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>
                  <ErrorBox error={moreError} />
                </div>
              )}
            </>
          )}
        </section>
      )}

      <Disclaimer>Severity values on reports are experimental AI estimates, not engineering assessments. Reports marked “simulated” are generated demo data.</Disclaimer>
    </div>
  )
}
