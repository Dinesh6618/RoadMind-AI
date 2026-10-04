import { Check, MailPlus, Send, UserCheck, UserX, X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api'
import { useAdminApi, useAuth } from '../../auth'
import { Badge, ErrorBox, Notice, Spinner, Stat } from '../../components'
import { fmtDate, initials } from '../../format'

const ROLE = {
  admin: ['Administrator', '#5b3df5', '#3c24b8'],
  maintenance: ['Maintenance staff', '#d97706', '#8a4a00'],
  user: ['Normal user', '#17a673', '#0b6e4b'],
}
const STATUS = {
  ACTIVE: ['Active', '#17a673', '#0b6e4b'],
  PENDING_EMAIL_VERIFICATION: ['Pending email verification', '#f2b01e', '#8a5a00'],
  PENDING_ADMIN_APPROVAL: ['Pending approval', '#4f6fe0', '#2c47b5'],
  REJECTED: ['Rejected', '#e5484d', '#a3181d'],
  SUSPENDED: ['Suspended', '#94a3b8', '#475569'],
}
const ROLE_NAMES = { admin: 'administrator', maintenance: 'maintenance staff', user: 'normal user' }
const ASKED = { admin: 'Administrator', maintenance: 'Road Maintenance Staff' }

const isRequest = (u) => !!u.requested_role && (u.status === 'PENDING_EMAIL_VERIFICATION' || u.status === 'PENDING_ADMIN_APPROVAL')

/**
 * Accounts and access. Administrators and maintenance staff come from two places only: an invitation sent from here
 * (the person verifies the address and chooses their own password) or a request made at /admin/register that an
 * administrator approves below. Nobody becomes staff by asking - the role is granted here, by an administrator.
 */
export default function Users() {
  const { user: me } = useAuth()
  const { data, loading, error, reload } = useAdminApi('/admin/users')
  const [busy, setBusy] = useState(null)
  const [problem, setProblem] = useState(null)
  const [result, setResult] = useState(null) // outcome of the last invite / resend / decision
  const [form, setForm] = useState({ full_name: '', email: '', role: 'maintenance' })
  const [sending, setSending] = useState(false)
  const [grant, setGrant] = useState({}) // user id -> role chosen for an approval (defaults to the requested one)

  async function act(u, call, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(u.id); setProblem(null); setResult(null)
    try {
      const res = await call()
      if (res?.delivery) setResult({ ...res, kind: 'resent' })
      reload()
      return res
    } catch (err) {
      setProblem(err)
    } finally {
      setBusy(null)
    }
  }

  const name = (u) => u.full_name || u.username
  const patch = (u, body, confirmText) => act(u, () => api(`/admin/users/${u.id}`, { method: 'PATCH', json: body }), confirmText)
  const resend = (u) => act(u, () => api(`/admin/users/${u.id}/resend`, { method: 'POST' }))

  async function approve(u) {
    const role = grant[u.id] || u.requested_role
    const ok = window.confirm(`Approve ${name(u)} as ${ROLE_NAMES[role]}? They will be able to log in to the Admin Portal${role === 'admin' ? ' with full administrator access' : ''}.`)
    if (!ok) return
    const res = await act(u, () => api(`/admin/users/${u.id}/approve`, { method: 'POST', json: { role } }))
    if (res) setResult({ kind: 'decision', text: `${name(u)} was approved as ${ROLE_NAMES[role]}. They can log in now and are told by email.` })
  }

  async function reject(u) {
    const reason = window.prompt(`Reject ${name(u)}'s request? You can add a short reason that is sent to them (optional).`, '')
    if (reason === null) return
    const res = await act(u, () => api(`/admin/users/${u.id}/reject`, { method: 'POST', json: { reason: reason.trim() || null } }))
    if (res) setResult({ kind: 'decision', text: `${name(u)}'s request was rejected. They are told by email.` })
  }

  async function invite(e) {
    e.preventDefault()
    setSending(true); setProblem(null); setResult(null)
    try {
      const res = await api('/admin/users', { method: 'POST', json: { ...form, email: form.email.trim() } })
      setResult({ ...res, kind: 'invited' })
      setForm({ full_name: '', email: '', role: form.role })
      reload()
    } catch (err) {
      setProblem(err)
    } finally {
      setSending(false)
    }
  }

  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} onRetry={reload} />
  const count = (role) => data.filter((u) => u.role === role && u.status === 'ACTIVE').length
  const requests = data.filter(isRequest)
  const waitingApproval = requests.filter((u) => u.status === 'PENDING_ADMIN_APPROVAL').length
  const rest = data.filter((u) => !isRequest(u))
  return (
    <>
      <div className="stat-grid four">
        <Stat label="Administrators" value={count('admin')} color="#5b3df5" hint="active" />
        <Stat label="Maintenance staff" value={count('maintenance')} color="#d97706" hint="active" />
        <Stat label="Normal users" value={count('user')} color="#17a673" hint="registered citizens" />
        <Stat label="Waiting for approval" value={waitingApproval} color="#4f6fe0" hint="verified requests to review" />
      </div>

      <ErrorBox error={problem} />
      {result && result.kind === 'decision' && <Notice kind="ok">{result.text}</Notice>}
      {result && result.kind !== 'decision' && (
        <Notice kind={result.delivery === 'outbox' ? 'warn' : 'ok'}>
          {result.kind === 'invited' ? `Invitation created for ${result.email}.` : `A new link was prepared for ${result.email}.`}{' '}
          {result.delivery === 'outbox'
            ? <>{result.delivery_error ? <>Sending failed: {result.delivery_error} </> : <>No email server is configured. </>}The message was saved on the server instead of being sent: <code>{result.outbox_dir}</code>. To send real email, copy <code>.env.example</code> to <code>.env</code>, add your Gmail address and App Password, and restart.</>
            : 'The email has been sent.'}
        </Notice>
      )}

      {requests.length > 0 && (
        <section className="card approvals" aria-labelledby="pending-title">
          <h2 id="pending-title" style={{ marginBottom: 4 }}>Pending approvals <span className="muted small">({requests.length})</span></h2>
          <p className="muted small" style={{ margin: '0 0 6px' }}>
            People who asked for an account at the Admin Portal. They have no access yet. Only a request whose email address is verified can be approved.
          </p>
          {requests.map((u) => {
            const verified = u.status === 'PENDING_ADMIN_APPROVAL'
            const [statusLabel, sc, si] = STATUS[u.status]
            return (
              <div className="approval-row" key={u.id}>
                <span className="avatar" style={{ width: 40, height: 40 }} aria-hidden="true">{initials(name(u))}</span>
                <div className="approval-who">
                  <b>{name(u)}</b>
                  <div className="small muted">{u.email} · asked for <b>{ASKED[u.requested_role]}</b> · {fmtDate(u.created_at)}</div>
                  <div style={{ marginTop: 6 }}><Badge dot color={sc} ink={si}>{statusLabel}</Badge></div>
                </div>
                <div className="approval-actions">
                  {verified ? (
                    <>
                      <select aria-label={`Role to grant ${name(u)}`} value={grant[u.id] || u.requested_role} disabled={busy === u.id}
                        onChange={(e) => setGrant({ ...grant, [u.id]: e.target.value })}>
                        <option value="maintenance">Road maintenance staff</option>
                        <option value="admin">Administrator</option>
                      </select>
                      <button className="btn btn-small btn-primary" disabled={busy === u.id} onClick={() => approve(u)}><Check size={15} aria-hidden="true" /> Approve</button>
                    </>
                  ) : (
                    <>
                      <span className="muted small">Waiting for them to open the verification link</span>
                      <button className="btn btn-small" disabled={busy === u.id} onClick={() => resend(u)}><MailPlus size={15} aria-hidden="true" /> Resend link</button>
                    </>
                  )}
                  <button className="btn btn-small btn-danger" disabled={busy === u.id} onClick={() => reject(u)}><X size={15} aria-hidden="true" /> Reject</button>
                </div>
              </div>
            )
          })}
        </section>
      )}

      <form className="card stack" onSubmit={invite}>
        <div>
          <h2 style={{ marginBottom: 4 }}><MailPlus size={20} aria-hidden="true" style={{ verticalAlign: '-3px' }} /> Create a maintenance or administrator account</h2>
          <p className="muted small" style={{ margin: 0 }}>The person receives an email, verifies their address and sets their own password - you never see it. They can sign in right after that; no further approval is needed because you are creating the account.</p>
        </div>
        <div className="grid cols-3" style={{ gap: 14 }}>
          <div className="field"><label htmlFor="nf">Full name</label><input id="nf" className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} minLength={2} maxLength={120} required /></div>
          <div className="field"><label htmlFor="ne">Authorized email</label><input id="ne" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
          <div className="field">
            <label htmlFor="nr">Role</label>
            <select id="nr" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="maintenance">Road maintenance staff</option>
              <option value="admin">Administrator</option>
            </select>
          </div>
        </div>
        <div className="row"><button className="btn btn-primary" disabled={sending}><Send size={17} aria-hidden="true" /> {sending ? 'Sending…' : 'Send invitation'}</button></div>
      </form>

      <section className="card card-flush">
        <div className="table-wrap">
          <table className="data wide">
            <thead><tr><th>User</th><th>Role</th><th>Status</th><th className="num">Roads</th><th className="num">Reports</th><th>Last login</th><th className="right">Actions</th></tr></thead>
            <tbody>
              {rest.map((u) => {
                const self = u.id === me.id
                const [roleLabel, rc, ri] = ROLE[u.role] || ROLE.user
                const [statusLabel, sc, si] = STATUS[u.status] || STATUS.ACTIVE
                const staff = u.role !== 'user'
                const active = u.status === 'ACTIVE'
                const unverifiedStaff = staff && u.status === 'PENDING_EMAIL_VERIFICATION'
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="row nowrap-row" style={{ gap: 12 }}>
                        <span className="avatar" style={{ width: 38, height: 38 }} aria-hidden="true">{initials(name(u))}</span>
                        <div><b>{name(u)}</b>{self && <span className="muted small"> (you)</span>}<div className="small muted">{u.email || 'no email'}</div></div>
                      </div>
                    </td>
                    <td><Badge dot color={rc} ink={ri}>{roleLabel}</Badge></td>
                    <td>
                      <Badge dot color={sc} ink={si}>{statusLabel}</Badge>
                      {u.status === 'REJECTED' && u.requested_role && <div className="small muted" style={{ marginTop: 4 }}>asked for {ASKED[u.requested_role]}</div>}
                    </td>
                    <td className="num">{u.role === 'maintenance' ? u.assigned_roads : <span className="muted">—</span>}</td>
                    <td className="num">{u.reports}</td>
                    <td className="nowrap">{fmtDate(u.last_login_at)}</td>
                    <td className="right">
                      {self ? <span className="muted small">—</span> : (
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          {unverifiedStaff && (
                            <button className="btn btn-small" disabled={busy === u.id} onClick={() => resend(u)}><MailPlus size={15} aria-hidden="true" /> Resend link</button>
                          )}
                          {u.status === 'REJECTED' && u.requested_role && u.email_verified && (
                            <button className="btn btn-small btn-soft" disabled={busy === u.id} onClick={() => approve(u)}><Check size={15} aria-hidden="true" /> Approve instead</button>
                          )}
                          {active && (
                            <select aria-label={`Role of ${name(u)}`} value={u.role} disabled={busy === u.id || !u.email} style={{ width: 'auto', minHeight: 36, padding: '4px 10px' }}
                              onChange={(e) => patch(u, { role: e.target.value }, `Change ${name(u)} to ${ROLE_NAMES[e.target.value]}? ${e.target.value !== 'user' && !u.email_verified ? 'They must verify their email before the account works. ' : ''}They will be signed out.`)}>
                              <option value="user">Normal user</option>
                              <option value="maintenance">Maintenance staff</option>
                              <option value="admin">Administrator</option>
                            </select>
                          )}
                          {u.status === 'SUSPENDED'
                            ? <button className="btn btn-small btn-soft" disabled={busy === u.id} onClick={() => patch(u, { is_active: true })}><UserCheck size={15} aria-hidden="true" /> Reactivate</button>
                            : u.status !== 'REJECTED' && <button className="btn btn-small btn-danger" disabled={busy === u.id} onClick={() => patch(u, { is_active: false }, `Suspend ${name(u)}? They will be signed out and unable to log in until you reactivate the account.`)}><UserX size={15} aria-hidden="true" /> Suspend</button>}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
