import { AlertTriangle, ArrowLeft, CheckCircle2, Eye, EyeOff, Info } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isContentPath, previousPath } from './navHistory'
import {
  CONDITION_LABELS, LEVEL_COLORS, LEVEL_INK, PRIORITY_COLORS, PRIORITY_INK, PRIORITY_SHORT, RISK_COLORS, RISK_INK, STATE_COLORS, STATE_INK,
  STATE_MEANING, STATE_ORDER, STATUS_LABELS,
} from './format'

/** The RoadMind AI mark: an "R" whose slanted stem is a road with a dashed centre line (read together with the "A" of "AI"). */
export function Logo({ size = 38, wordmark = true, dark = false }) {
  return (
    <span className={`brand ${dark ? 'on-dark' : ''}`}>
      <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="RoadMind AI">
        <defs>
          <linearGradient id="rm-logo" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8f72ff" />
            <stop offset="1" stopColor="#4527d8" />
          </linearGradient>
        </defs>
        <rect width="48" height="48" rx="14" fill="url(#rm-logo)" />
        <path d="M14 38 21.4 10.5H28a7.6 7.6 0 0 1 0 15.2H19.2" fill="none" stroke="#fff" strokeWidth="3.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M27.2 25.7 34.6 38" fill="none" stroke="#fff" strokeWidth="3.8" strokeLinecap="round" />
        <path d="M15.6 32.2 20 15.6" fill="none" stroke="#6a4bff" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2.6 3.2" />
        <circle cx="35.5" cy="12.5" r="3.1" fill="#7df0c3" />
      </svg>
      {wordmark && <span>RoadMind <span className="ai">AI</span></span>}
    </span>
  )
}

/**
 * "Back" - goes to the page the visitor really came from (real history: navigate(-1)) when this tab's own history says that page is a
 * content page. Otherwise - a bookmark, a typed address, a fresh tab, or a previous page that was only a login / welcome screen - it goes
 * to the page's logical parent `fallback`, so Back never throws a signed-in person back to a login screen. `to` is for pages whose "back"
 * is one fixed place (login -> welcome, register -> login): it always goes there.
 */
export function BackButton({ fallback = '/', to, label = 'Back', tone = 'light' }) {
  const navigate = useNavigate()
  const goBack = () => {
    if (to) return navigate(to)
    const prev = previousPath()
    return prev && isContentPath(prev) ? navigate(-1) : navigate(fallback, { replace: true })
  }
  return (
    <button type="button" className={`back-btn back-${tone}`} onClick={goBack} aria-label={label}>
      <ArrowLeft size={18} aria-hidden="true" /> <span>{label}</span>
    </button>
  )
}

export function Badge({ color = '#64748b', ink, children, title, dot = false }) {
  return (
    <span className="badge" style={{ '--c': color, '--ink-c': ink || color }} title={title}>
      {dot && <i />}
      {children}
    </span>
  )
}

export const StateBadge = ({ state }) => <Badge dot color={STATE_COLORS[state]} ink={STATE_INK[state]} title={STATE_MEANING[state]}>{CONDITION_LABELS[state]}</Badge>
export const SeverityBadge = ({ level }) => <Badge dot color={LEVEL_COLORS[level]} ink={LEVEL_INK[level]}>{level}</Badge>
export const RiskBadge = ({ level, percent }) =>
  level ? <Badge dot color={RISK_COLORS[level]} ink={RISK_INK[level]}>{percent != null ? `${percent}% · ` : ''}{level[0] + level.slice(1).toLowerCase()}</Badge> : <span className="muted">—</span>
export const PriorityBadge = ({ category }) => (
  <span className="priority" style={{ '--c': PRIORITY_COLORS[category], '--ink-c': PRIORITY_INK[category] }}>{PRIORITY_SHORT[category] || category}</span>
)
export const StatusBadge = ({ status }) => (
  <Badge color={status === 'repair_completed' ? STATE_COLORS.GOOD : status === 'pending' ? '#8b94b8' : '#4f6fe0'} ink={status === 'repair_completed' ? STATE_INK.GOOD : status === 'pending' ? '#4a5580' : '#2c47b5'}>
    {STATUS_LABELS[status] || status}
  </Badge>
)

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null
  return (
    <div className="alert alert-error" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <span>
        <strong>{error.message}</strong>
        {error.info?.request_id && <small className="request-id">Request ID: {error.info.request_id}</small>}
      </span>
      {onRetry && <button className="btn btn-small" onClick={onRetry}>Try again</button>}
    </div>
  )
}

export function Notice({ kind = 'info', children, icon }) {
  const Icon = icon || (kind === 'ok' ? CheckCircle2 : kind === 'warn' || kind === 'error' ? AlertTriangle : Info)
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={18} aria-hidden="true" style={{ flex: 'none' }} />
      <span>{children}</span>
    </div>
  )
}

export function Disclaimer({ children, kind = 'info' }) {
  return <p className={`note note-${kind}`}>{children}</p>
}

export function Stat({ label, value, hint, color, icon: Icon }) {
  return (
    <div className="stat card" style={color ? { '--accent': color } : undefined}>
      {Icon && <div className="stat-icon"><Icon size={21} aria-hidden="true" /></div>}
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  )
}

/** 0-100 meter with the four severity bands and a marker for the score. */
export function SeverityMeter({ score, level }) {
  const s = Math.max(0, Math.min(100, score ?? 0))
  return (
    <div className="meter" role="img" aria-label={`Severity ${s} out of 100, ${level}`}>
      <div className="meter-head">
        <span className="meter-score" style={{ color: LEVEL_INK[level] }}>{Math.round(s)}<small>/100</small></span>
        {level && <SeverityBadge level={level} />}
      </div>
      <div className="meter-track">
        <i style={{ width: '30%', background: LEVEL_COLORS.Low }} />
        <i style={{ width: '30%', background: LEVEL_COLORS.Moderate }} />
        <i style={{ width: '20%', background: LEVEL_COLORS.High }} />
        <i style={{ width: '20%', background: LEVEL_COLORS.Critical }} />
        <b style={{ left: `${s}%` }} />
      </div>
      <div className="meter-scale"><span>0</span><span>30</span><span>60</span><span>80</span><span>100</span></div>
    </div>
  )
}

/** Large circular score for the AI result screen. */
export function SeverityRing({ score, size = 168 }) {
  const r = 70, c = 2 * Math.PI * r
  const s = Math.max(0, Math.min(100, score ?? 0))
  return (
    <div className="sev-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 168 168" aria-hidden="true">
        <circle cx="84" cy="84" r={r} fill="none" stroke="rgba(255,255,255,.22)" strokeWidth="13" />
        <circle cx="84" cy="84" r={r} fill="none" stroke="#fff" strokeWidth="13" strokeLinecap="round" strokeDasharray={`${(c * s) / 100} ${c}`} />
      </svg>
      <div className="num"><b>{Math.round(s)}</b><span>/ 100</span></div>
    </div>
  )
}

export function Legend({ items }) {
  return (
    <ul className="legend">
      {items.map(([label, color]) => (
        <li key={label}><i style={{ background: color }} />{label}</li>
      ))}
    </ul>
  )
}

/** Legend for the five road states. `counts` (optional) adds how many segments are in each state. */
export function ConditionLegend({ counts }) {
  return (
    <ul className="legend">
      {STATE_ORDER.slice().reverse().map((s) => (
        <li key={s} title={STATE_MEANING[s]}>
          <i style={{ background: STATE_COLORS[s] }} />
          {CONDITION_LABELS[s]}
          {counts && counts[s] != null ? <span className="muted"> ({counts[s]})</span> : null}
        </li>
      ))}
    </ul>
  )
}

export const SEVERITY_LEGEND = [['Critical', LEVEL_COLORS.Critical], ['High', LEVEL_COLORS.High], ['Moderate', LEVEL_COLORS.Moderate], ['Low', LEVEL_COLORS.Low]]

export function Empty({ children, icon: Icon }) {
  return <div className="empty">{Icon && <Icon size={34} aria-hidden="true" style={{ opacity: 0.45, marginBottom: 8 }} />}<div>{children}</div></div>
}

/** Stacked bar showing how much each factor contributes (values are 0-100). */
export function FactorBars({ items }) {
  return (
    <div className="factor-bars">
      {items.map(({ label, value, hint }) => (
        <div key={label} className="factor" title={hint}>
          <span>{label}</span>
          <div className="factor-track"><i style={{ width: `${Math.max(2, Math.min(100, value))}%` }} /></div>
          <em>{Math.round(value)}</em>
        </div>
      ))}
    </div>
  )
}

/** Rough strength hint shown while typing. It is only advice - the server enforces the real rules. */
export function passwordStrength(pw) {
  if (!pw) return { score: 0, label: '' }
  let s = 0
  if (pw.length >= 10) s++
  if (pw.length >= 14) s++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++
  if (/\d/.test(pw)) s++
  if (/[^A-Za-z0-9]/.test(pw)) s++
  if (new Set(pw).size < 5 || /^\d+$/.test(pw)) s = Math.min(s, 1)
  const score = Math.min(4, s)
  return { score, label: ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][score] }
}

export function PasswordInput({ id, value, onChange, autoComplete = 'current-password', placeholder, required = true, meter = false, ...rest }) {
  const [show, setShow] = useState(false)
  const st = passwordStrength(value)
  const colors = ['#e0342f', '#e0342f', '#f2b01e', '#17a673', '#0e8f61']
  return (
    <>
      <div className="input-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
        <input id={id} className="input" type={show ? 'text' : 'password'} value={value} onChange={onChange} autoComplete={autoComplete} placeholder={placeholder} required={required} maxLength={128} {...rest} />
        <button type="button" className="reveal" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>
          {show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {meter && value && (
        <div aria-live="polite">
          <div className="pw-meter"><i style={{ width: `${(st.score + 1) * 20}%`, background: colors[st.score] }} /></div>
          <div className="hint" style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 4 }}>Strength: {st.label}</div>
        </div>
      )}
    </>
  )
}
