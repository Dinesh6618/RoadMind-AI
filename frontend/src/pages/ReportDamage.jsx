import { ArrowLeft, ArrowRight, Camera, Check, ImagePlus, LocateFixed, MapPin, MousePointerClick, Send, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CircleMarker } from 'react-leaflet'
import { Link, useSearchParams } from 'react-router-dom'
import { api, useApi } from '../api'
import { useAuth } from '../auth'
import { ErrorBox, Notice, SeverityBadge, StateBadge } from '../components'
import { highwayLabel } from '../format'
import NetworkMap, { ROUTE_PANE } from '../NetworkMap'
import ReportResult from './ReportResult'

const MAX_BYTES = 8 * 1024 * 1024
const TYPES = ['image/jpeg', 'image/png', 'image/webp']
const STEPS = ['Upload Image', 'Location', 'Road Name', 'Description']

// What the person has entered so far. It survives a trip to the login page (guests must log in before a report is
// stored) and back, but not a page reload - the photo is only ever held in memory.
let draft = null

function localNow() {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

function Stepper({ step }) {
  return (
    <ol className="stepper" aria-label="Progress" style={{ listStyle: 'none', padding: 0 }}>
      {STEPS.map((name, i) => (
        <li key={name} className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`} aria-current={i === step ? 'step' : undefined}>
          <span className="dot">{i < step ? <Check size={18} aria-hidden="true" /> : i + 1}</span>
          <span className="name">{name}</span>
          {i < STEPS.length - 1 && <span className="bar" />}
        </li>
      ))}
    </ol>
  )
}

export default function ReportDamage() {
  const { user } = useAuth()
  const places = useApi('/routes/places')
  const samples = useApi('/samples')
  const [params] = useSearchParams()

  const [step, setStep] = useState(draft?.step ?? 0)
  const [file, setFile] = useState(draft?.file ?? null)
  const [preview, setPreview] = useState(null)
  const [ai, setAi] = useState(null) // the detector's preview for guests, who cannot store a report yet
  const [sampleName, setSampleName] = useState(draft?.sampleName ?? null)
  const [loc, setLoc] = useState(draft?.loc ?? null)
  const [panTo, setPanTo] = useState(null) // only for programmatic moves, so clicking the map never re-centres it
  const [match, setMatch] = useState(null) // the road segment the report would be attached to
  const [reloadKey, setReloadKey] = useState(0)
  const [roadName, setRoadName] = useState(draft?.roadName ?? (params.get('road') || ''))
  const [nameTouched, setNameTouched] = useState(draft?.nameTouched ?? !!params.get('road'))
  const [description, setDescription] = useState(draft?.description ?? '')
  const [when, setWhen] = useState(draft?.when ?? localNow())
  const [confirm, setConfirm] = useState(draft?.confirm ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [over, setOver] = useState(false)
  const gallery = useRef(null)
  const camera = useRef(null)
  const top = useRef(null)

  // Start on a road: the location from a map card (?lat=&lng=), else a road near the middle of the loaded network.
  useEffect(() => {
    if (loc) return
    const lat = parseFloat(params.get('lat')), lng = parseFloat(params.get('lng'))
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      setLoc({ lat, lng }); setPanTo({ lat, lng, zoom: 17 })
    } else if (places.data) {
      const c = places.data.center
      api(`/network/match?lat=${c.lat}&lng=${c.lng}&radius=500`).then((m) => {
        const p = m.matched ? m.midpoint : c
        setLoc({ lat: p.lat, lng: p.lng }); setPanTo({ lat: p.lat, lng: p.lng, zoom: 16 })
      }).catch(() => setLoc({ lat: c.lat, lng: c.lng }))
    }
  }, [places.data]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the user which road the report will be attached to, and whether RoadMind has any data for it yet.
  useEffect(() => {
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) { setMatch(null); return }
    const t = setTimeout(() => api(`/network/match?lat=${loc.lat}&lng=${loc.lng}`).then(setMatch).catch(() => setMatch(null)), 200)
    return () => clearTimeout(t)
  }, [loc?.lat, loc?.lng]) // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill the road name from the matched road (unless the person typed their own).
  useEffect(() => {
    if (!nameTouched && match?.matched && !/^Unnamed/.test(match.name)) setRoadName(match.name)
  }, [match, nameTouched])

  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  useEffect(() => { draft = { step, file, sampleName, loc, roadName, nameTouched, description, when, confirm } }, [step, file, sampleName, loc, roadName, nameTouched, description, when, confirm])

  // Guests can still see what the AI finds: the preview endpoint stores nothing.
  useEffect(() => {
    if (user || !file) { setAi(null); return }
    let cancelled = false
    setAi({ loading: true })
    const form = new FormData()
    form.append('image', file)
    api('/detect', { method: 'POST', form }).then((data) => !cancelled && setAi({ data })).catch((error) => !cancelled && setAi({ error }))
    return () => { cancelled = true }
  }, [file, user])
  useEffect(() => { top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [step, result])

  function choose(f, sample = null) {
    setError(null)
    if (!f) return
    if (!TYPES.includes(f.type)) return setError(new Error('Please choose a JPEG, PNG or WebP image.'))
    if (f.size > MAX_BYTES) return setError(new Error('That image is larger than 8 MB.'))
    setFile(f)
    setSampleName(sample)
  }

  async function pickSample(s) {
    try {
      const blob = await (await fetch(s.url)).blob()
      choose(new File([blob], `${s.name}.jpg`, { type: 'image/jpeg' }), s.name)
    } catch {
      setError(new Error('Could not load that sample image.'))
    }
  }

  function useMyLocation() {
    setError(null)
    if (!navigator.geolocation) return setError(new Error('Your browser does not support location. Select the spot on the map instead.'))
    navigator.geolocation.getCurrentPosition(
      (pos) => { const p = { lat: pos.coords.latitude, lng: pos.coords.longitude }; setLoc(p); setPanTo({ ...p, zoom: 17 }) },
      () => setError(new Error('Could not get your location. Allow location access, or select the spot on the map instead.')),
      { timeout: 10000, enableHighAccuracy: true },
    )
  }

  function next() {
    setError(null)
    if (step === 0 && !file) return setError(new Error('Add a photo of the damaged road first.'))
    if (step === 1 && (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng))) return setError(new Error('Choose where the damage is - use your location or click a road on the map.'))
    setStep((s) => s + 1)
  }

  async function submit() {
    setError(null)
    const form = new FormData()
    form.append('image', file)
    form.append('lat', String(loc.lat))
    form.append('lng', String(loc.lng))
    form.append('road_name', roadName)
    form.append('description', description)
    if (when) form.append('reported_at', new Date(when).toISOString())
    if (confirm) form.append('severity_confirmation', confirm)
    setBusy(true)
    try {
      setResult(await api('/reports', { method: 'POST', form }))
      draft = null
      setReloadKey((k) => k + 1)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  function another() {
    draft = null
    setResult(null); setStep(0); setFile(null); setSampleName(null); setDescription(''); setConfirm(''); setWhen(localNow()); setNameTouched(false); setRoadName(''); setMatch(null)
  }

  if (result) {
    return <div className="container page" ref={top}><ReportResult r={result} onAnother={another} /></div>
  }

  return (
    <div className="container page" ref={top}>
      <div className="wizard">
        <div className="page-head">
          <h1>Report Road Damage</h1>
          <p>Add a photo and a location. The AI detects potholes and cracks, estimates how severe they are and updates the road's record.</p>
        </div>
        <Stepper step={step} />
        {!user && (
          <Notice kind="info">
            You are browsing as a guest. You can try the AI detector below, but you need a free account to submit a report -
            <Link to="/user/login" state={{ from: '/user/report' }}> log in</Link> or <Link to="/user/register" state={{ from: '/user/report' }}>create an account</Link> whenever you are ready; what you entered here is kept.
          </Notice>
        )}

        <div className="card wizard-card">
          {step === 0 && (
            <>
              <h2>Upload Image</h2>
              <p className="muted">A clear photo of the damaged road surface works best.</p>
              <div
                className={`dropzone ${over ? 'over' : ''}`} role="button" tabIndex={0} aria-label="Choose a road photo"
                onClick={() => gallery.current?.click()}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && gallery.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files?.[0]) }}
              >
                {preview ? <img src={preview} alt="Selected road" /> : <div className="big-ico"><Upload size={34} aria-hidden="true" /></div>}
                <strong>{file ? file.name : 'Drag and drop a photo here'}</strong>
                <span className="muted small">{file ? 'Click to replace' : 'or click to browse · JPEG, PNG or WebP · up to 8 MB'}</span>
              </div>
              <input ref={gallery} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => choose(e.target.files?.[0])} />
              <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => choose(e.target.files?.[0])} />
              <div className="row" style={{ marginTop: 16 }}>
                <button type="button" className="btn btn-soft" onClick={() => camera.current?.click()}><Camera size={18} aria-hidden="true" /> Take a photo</button>
                <button type="button" className="btn" onClick={() => gallery.current?.click()}><ImagePlus size={18} aria-hidden="true" /> Choose from gallery</button>
              </div>
              {!user && ai && (
                <div className="match-box" role="status" style={{ marginTop: 16 }}>
                  {ai.loading && <span>Analysing the photo…</span>}
                  {ai.error && <span>{ai.error.message}</span>}
                  {ai.data && (
                    <>
                      {ai.data.annotated_image && <img src={ai.data.annotated_image} alt="Photo with detected damage outlined" style={{ width: 120, height: 84, borderRadius: 12, objectFit: 'cover' }} />}
                      <div>
                        <b>AI preview (nothing is stored)</b> <SeverityBadge level={ai.data.severity.level} />
                        <div className="small">{ai.data.severity.description}</div>
                        <div className="small muted">{ai.data.detector}</div>
                      </div>
                    </>
                  )}
                </div>
              )}
              {samples.data?.length > 0 && (
                <div style={{ marginTop: 22 }}>
                  <div className="small muted" style={{ fontWeight: 650 }}>No photo handy? Try a generated sample</div>
                  <div className="samples">
                    {samples.data.map((s) => (
                      <button type="button" key={s.url} className={sampleName === s.name ? 'on' : ''} onClick={() => pickSample(s)} title={s.name}>
                        <img src={s.url} alt={s.name} loading="lazy" /><span>{s.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <h2>Location</h2>
              <p className="muted">Where is the damage? Use your position, or click the road on the map.</p>
              <div className="loc-actions">
                <button type="button" className="btn btn-primary" onClick={useMyLocation}><LocateFixed size={18} aria-hidden="true" /> Use Current Location</button>
                <button type="button" className="btn btn-soft" onClick={() => document.getElementById('report-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><MousePointerClick size={18} aria-hidden="true" /> Select on Map</button>
              </div>
              <div id="report-map">
                <NetworkMap height={340} hideBadge onPick={(ll) => setLoc({ lat: ll.lat, lng: ll.lng })} pan={panTo} reloadKey={reloadKey}>
                  {loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) && (
                    <>
                      <CircleMarker center={[loc.lat, loc.lng]} radius={16} pane={ROUTE_PANE} pathOptions={{ weight: 0, fillColor: '#5b3df5', fillOpacity: 0.18 }} />
                      <CircleMarker center={[loc.lat, loc.lng]} radius={9} pane={ROUTE_PANE} pathOptions={{ color: '#fff', weight: 3.5, fillColor: '#5b3df5', fillOpacity: 1 }} />
                    </>
                  )}
                </NetworkMap>
              </div>
              {loc && <div className="small muted" style={{ marginTop: 8 }}><MapPin size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}</div>}
              {match && (
                <div className="match-box" role="status">
                  <MapPin size={20} aria-hidden="true" />
                  {match.matched ? (
                    <div>
                      The report will be attached to <b>{match.name}</b> <span className="muted">({highwayLabel(match.highway)})</span> <StateBadge state={match.state} />
                      {match.state === 'UNKNOWN' && <div className="small muted" style={{ marginTop: 4 }}>RoadMind has no condition data for this road yet - your report will be its first.</div>}
                    </div>
                  ) : (
                    <div>No road within a few metres of the pin. Click directly on a road, or use <em>Load missing roads here</em> on the map. If none can be found, a short placeholder road is created.</div>
                  )}
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <h2>Road Name</h2>
              <p className="muted">We filled this in from the road you selected. Correct it if the sign says something else.</p>
              <div className="field">
                <label htmlFor="road">Road name</label>
                <input id="road" className="input" maxLength={160} value={roadName} onChange={(e) => { setRoadName(e.target.value); setNameTouched(true) }} placeholder="e.g. Poonamallee High Road" />
                <div className="hint">Optional. Used only if no known road is near the pin.</div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h2>Description</h2>
              <p className="muted">Anything that helps the repair crew - near a junction, school or bus stop? How long has it been there?</p>
              <div className="field">
                <label htmlFor="desc">Description</label>
                <textarea id="desc" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What did you see?" />
              </div>
              <div className="grid cols-2" style={{ gap: 14 }}>
                <div className="field">
                  <label htmlFor="when">Date and time</label>
                  <input id="when" type="datetime-local" className="input" value={when} max={localNow()} onChange={(e) => setWhen(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="sev">How serious does it look?</label>
                  <select id="sev" value={confirm} onChange={(e) => setConfirm(e.target.value)}>
                    <option value="">Skip</option><option value="low">Low</option><option value="moderate">Moderate</option>
                    <option value="high">High</option><option value="critical">Critical</option><option value="not_sure">Not sure</option>
                  </select>
                  <div className="hint">Saved for reviewers. It does not change the AI score.</div>
                </div>
              </div>
              <div className="match-box" style={{ marginTop: 4 }}>
                {preview && <img src={preview} alt="" style={{ width: 64, height: 64, borderRadius: 14, objectFit: 'cover' }} />}
                <div className="small"><b>{roadName || match?.name || 'Selected road'}</b><br /><span className="muted">{loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : ''}</span></div>
              </div>
              <Notice kind="info">Photos are stored without location or device metadata, and reports are shown without any personal information.</Notice>
            </>
          )}

          <div style={{ marginTop: 18 }}><ErrorBox error={error} /></div>
          <div className="wizard-nav">
            {step > 0 ? <button type="button" className="btn" onClick={() => { setError(null); setStep(step - 1) }}><ArrowLeft size={18} aria-hidden="true" /> Back</button> : <span />}
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn btn-primary" onClick={next}>Next <ArrowRight size={18} aria-hidden="true" /></button>
            ) : user ? (
              <button type="button" className="btn btn-primary btn-lg" onClick={submit} disabled={busy}><Send size={18} aria-hidden="true" /> {busy ? 'Analysing photo…' : 'Submit Report'}</button>
            ) : (
              <Link className="btn btn-primary btn-lg" to="/user/login" state={{ from: '/user/report' }}><Send size={18} aria-hidden="true" /> Log in to submit</Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
