import { LogOut } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { ErrorBox, Notice, PasswordInput } from '../components'

/**
 * Account settings for whoever is signed in (administrator or normal user): update profile, change username / email
 * / password, sign out. Sensitive changes need the current password; the server enforces that.
 */
export default function AccountSettings() {
  const { user, setUser, adopt, logout } = useAuth()
  const [p, setP] = useState({ full_name: user.full_name || '', username: user.username, email: user.email || '', current_password: '' })
  const [pErr, setPErr] = useState(null)
  const [pOk, setPOk] = useState(null)
  const [pBusy, setPBusy] = useState(false)

  const [w, setW] = useState({ current_password: '', new_password: '', confirm_password: '' })
  const [wErr, setWErr] = useState(null)
  const [wOk, setWOk] = useState(null)
  const [wBusy, setWBusy] = useState(false)

  const staff = user.role === 'admin' || user.role === 'maintenance' // their email is the verified identity they sign in with
  const sensitive = p.username.trim() !== user.username || (!staff && p.email.trim().toLowerCase() !== (user.email || ''))

  async function saveProfile(e) {
    e.preventDefault()
    setPErr(null); setPOk(null)
    if (sensitive && !p.current_password) return setPErr(new Error('Enter your current password to change your username or email.'))
    setPBusy(true)
    try {
      const body = { full_name: p.full_name.trim() }
      if (p.username.trim() !== user.username) body.username = p.username.trim()
      if (!staff && p.email.trim().toLowerCase() !== (user.email || '')) body.email = p.email.trim()
      if (sensitive) body.current_password = p.current_password
      const updated = await api('/auth/profile', { method: 'PATCH', json: body })
      setUser(updated)
      setP({ full_name: updated.full_name, username: updated.username, email: updated.email || '', current_password: '' })
      setPOk('Profile updated.')
    } catch (err) {
      setPErr(err)
    } finally {
      setPBusy(false)
    }
  }

  async function savePassword(e) {
    e.preventDefault()
    setWErr(null); setWOk(null)
    if (w.new_password.length < 10) return setWErr(new Error('The new password must be at least 10 characters long.'))
    if (w.new_password !== w.confirm_password) return setWErr(new Error('New Password and Confirm New Password do not match.'))
    setWBusy(true)
    try {
      const res = await api('/auth/change-password', { method: 'POST', json: w })
      adopt(res) // this browser gets a fresh session; other devices are signed out
      setW({ current_password: '', new_password: '', confirm_password: '' })
      setWOk(res.message)
    } catch (err) {
      setWErr(err)
    } finally {
      setWBusy(false)
    }
  }

  async function signOutEverywhere() {
    if (!window.confirm('Sign out of every device, including this one?')) return
    try { await api('/auth/logout-all', { method: 'POST' }) } finally { logout() }
  }

  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <form className="card stack" onSubmit={saveProfile} autoComplete="off">
        <div><h2 style={{ marginBottom: 4 }}>Profile</h2><p className="muted small" style={{ margin: 0 }}>Your name and contact details.</p></div>
        <div className="field">
          <label htmlFor="afn">Full name</label>
          <input id="afn" className="input" value={p.full_name} onChange={(e) => setP({ ...p, full_name: e.target.value })} minLength={2} maxLength={120} required />
        </div>
        <div className="field">
          <label htmlFor="aun">Username</label>
          <input id="aun" className="input" value={p.username} onChange={(e) => setP({ ...p, username: e.target.value })} pattern="[A-Za-z0-9._\-]{3,32}" title="3-32 letters, digits, dot, underscore or hyphen" required />
        </div>
        <div className="field">
          <label htmlFor="aem">Email address</label>
          <input id="aem" className="input" type="email" value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} required readOnly={staff} aria-readonly={staff} />
          <div className="hint">{staff ? 'This verified address is how you sign in and where reset links go. It can only be changed by an administrator.' : 'Password-reset links are sent here.'}</div>
        </div>
        {sensitive && (
          <div className="field">
            <label htmlFor="acp">Current password</label>
            <PasswordInput id="acp" value={p.current_password} onChange={(e) => setP({ ...p, current_password: e.target.value })} />
            <div className="hint">Needed because you are changing your username or email.</div>
          </div>
        )}
        <ErrorBox error={pErr} />
        {pOk && <Notice kind="ok">{pOk}</Notice>}
        <button className="btn btn-primary" disabled={pBusy}>{pBusy ? 'Saving…' : 'Save profile'}</button>
      </form>

      <div className="stack">
        <form className="card stack" onSubmit={savePassword} autoComplete="off">
          <div><h2 style={{ marginBottom: 4 }}>Change password</h2><p className="muted small" style={{ margin: 0 }}>You will stay signed in here; other devices are signed out.</p></div>
          <div className="field">
            <label htmlFor="wc">Current password</label>
            <PasswordInput id="wc" value={w.current_password} onChange={(e) => setW({ ...w, current_password: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="wn">New password</label>
            <PasswordInput id="wn" value={w.new_password} onChange={(e) => setW({ ...w, new_password: e.target.value })} autoComplete="new-password" meter />
          </div>
          <div className="field">
            <label htmlFor="wf">Confirm new password</label>
            <PasswordInput id="wf" value={w.confirm_password} onChange={(e) => setW({ ...w, confirm_password: e.target.value })} autoComplete="new-password" />
          </div>
          <ErrorBox error={wErr} />
          {wOk && <Notice kind="ok">{wOk}</Notice>}
          <button className="btn btn-primary" disabled={wBusy}>{wBusy ? 'Saving…' : 'Change password'}</button>
        </form>

        <div className="card stack-sm">
          <h3 style={{ marginBottom: 2 }}>Sessions</h3>
          <p className="muted small" style={{ margin: 0 }}>Passwords are stored only as salted Argon2 hashes - nobody, including RoadMind, can read them.</p>
          <div className="row">
            <button className="btn" onClick={logout}><LogOut size={16} /> Log out</button>
            <button className="btn btn-danger" onClick={signOutEverywhere}>Sign out everywhere</button>
          </div>
        </div>
      </div>
    </div>
  )
}
