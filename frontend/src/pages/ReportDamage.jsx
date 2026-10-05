import { ArrowLeft, ArrowRight, Camera, Check, ImagePlus, MapPin, Send, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, useApi } from '../api'
import { useAuth } from '../auth'
import { ErrorBox, Notice, SeverityBadge, StateBadge } from '../components'
import { highwayLabel } from '../format'
import EventConfirmation from './report/EventConfirmation'
import PointPicker, { validPoint } from './report/PointPicker'
import TypePicker from './report/TypePicker'
import { TYPE_BY_VALUE, isDamageType, photoRequired } from './report/reportTypes'
import ReportResult from './ReportResult'
import './events.css'

const MAX_BYTES = 8 * 1024 * 1024
const TYPES = ['image/jpeg', 'image/png', 'image/webp']
const STEPS = ['What', 'Photo', 'Location', 'Details']

// What the person has entered so far. It survives a trip to the login page (guests must log in before a report is
// stored) and back, but not a page reload - the photo is only ever held in memory.
let draft = null

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
  const samples = useApi('/samples')
  const [params] = useSearchParams()
  const typeParam = (params.get('type') || '').toUpperCase()
  const startType = TYPE_BY_VALUE[typeParam] ? typeParam : null

  const [step, setStep] = useState(draft?.step ?? (startType ? 1 : 0)) // ?type=BLOCKED_ROAD skips the choice
  const [type, setType] = useState(draft?.type ?? startType)
  const [file, setFile] = useState(draft?.file ?? null)
  const [preview, setPreview] = useState(null)
  const [ai, setAi] = useState(null) // the detector's preview for guests, who cannot store a report yet
  const [sampleName, setSampleName] = useState(draft?.sampleName ?? null)
  const [loc, setLoc] = useState(() => {
    if (draft?.loc) return draft.loc
    const lat = parseFloat(params.get('lat')), lng = parseFloat(params.get('lng')) // a "report here" link from the map
    return validPoint({ lat, lng }) ? { lat, lng } : null
  })
  const [match, setMatch] = useState(null) // the RoadMind road near the point, if there is one
  const [roadName, setRoadName] = useState(draft?.roadName ?? (params.get('road') || ''))
  const [nameTouched, setNameTouched] = useState(draft?.nameTouched ?? !!params.get('road'))
  const [description, setDescription] = useState(draft?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [over, setOver] = useState(false)
  const gallery = useRef(null)
  const camera = useRef(null)
  const top = useRef(null)

  const cfg = type ? TYPE_BY_VALUE[type] : null
  const damage = isDamageType(type)

  // Tell the person which RoadMind road is near the point (RoadMind's own records are only an overlay on the real map).
  useEffect(() => {
    if (!validPoint(loc)) { setMatch(null); return }
    let cancelled = false
    const t = setTimeout(() => api(`/network/match?lat=${loc.lat}&lng=${loc.lng}`).then((m) => !cancelled && setMatch(m)).catch(() => !cancelled && setMatch(null)), 200)
    return () => { cancelled = true; clearTimeout(t) }
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
  useEffect(() => { draft = { step, type, file, sampleName, loc, roadName, nameTouched, description } }, [step, type, file, sampleName, loc, roadName, nameTouched, description])

  // Guests can still see what the AI finds in a damage photo: the preview endpoint stores nothing.
  useEffect(() => {
    if (user || !file || !damage) { setAi(null); return }
    let cancelled = false
    setAi({ loading: true })
    const form = new FormData()
    form.append('image', file)
    api('/detect', { method: 'POST', form }).then((data) => !cancelled && setAi({ data })).catch((error) => !cancelled && setAi({ error }))
    return () => { cancelled = true }
  }, [file, user, damage])
  useEffect(() => { top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [step, result])
  // a message about a missing choice goes away as soon as the choice is made
  useEffect(() => { setError(null) }, [type, file, loc?.lat, loc?.lng])

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

  function removePhoto() { setFile(null); setSampleName(null); setError(null) }

  function next() {
    setError(null)
    if (step === 0 && !type) return setError(new Error('Choose what you are reporting first.'))
    if (step === 1 && photoRequired(type) && !file) return setError(new Error(`Add a photo of the ${cfg.label.toLowerCase()} first - RoadMind's AI needs it to check the damage.`))
    if (step === 2 && !validPoint(loc)) return setError(new Error('Choose where it is - use your location, click the spot on the map or type the coordinates.'))
    setStep((s) => s + 1)
  }

  async function submit() {
    setError(null)
    const form = new FormData()
    form.append('report_type', type)
    form.append('lat', String(loc.lat))
    form.append('lng', String(loc.lng))
    form.append('road_name', roadName)
    form.append('description', description)
    if (file) form.append('image', file)
    setBusy(true)
    try {
      setResult(await api('/road-reports', { method: 'POST', form }))
      draft = null
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  function another() {
    draft = null
    setResult(null); setStep(0); setType(null); setFile(null); setSampleName(null); setDescription(''); setNameTouched(false); setRoadName(''); setMatch(null); setLoc(null); setError(null)
  }

  if (result) {
    return (
      <div className="container page" ref={top}>
        {result.kind === 'damage' && result.damage ? (
          <ReportResult
            r={result.damage} onAnother={another}
            notice={result.event && (
              <Notice icon={MapPin}>
                You reported a dangerous road condition, so it was also sent to authorised staff as a <strong>severe damage report waiting for verification</strong>.
                Until it is verified it is shown as unverified and only slightly affects route suggestions.
              </Notice>
            )}
          />
        ) : <EventConfirmation result={result} onAnother={another} />}
      </div>
    )
  }

  const unauthorised = error?.status === 401

  return (
    <div className="container page" ref={top}>
      <div className="wizard">
        <div className="page-head">
          <h1>Report a Road Problem</h1>
          <p>Potholes, cracks, flooding, accidents, blocked roads, construction or dangerous conditions. Potholes and cracks are checked by RoadMind's AI; everything else is verified by authorised staff.</p>
        </div>
        <Stepper step={step} />
        {!user && (
          <Notice kind="info">
            You are browsing as a guest. You can try the AI detector on a photo below, but you need a free account to submit a report -
            <Link to="/user/login" state={{ from: '/user/report' }}> log in</Link> or <Link to="/user/register" state={{ from: '/user/report' }}>create an account</Link> whenever you are ready; what you entered here is kept.
          </Notice>
        )}

        <div className="card wizard-card">
          {step === 0 && (
            <>
              <h2>What are you reporting?</h2>
              <p className="muted">Pick the closest match.</p>
              <TypePicker value={type} onChange={(v) => { setType(v); setError(null) }} />
              <p className="note">If someone is in immediate danger, call your local emergency number first. RoadMind reports and AI results are estimates and do not guarantee the safety of a road.</p>
            </>
          )}

          {step === 1 && (
            <>
              <h2>Photo{photoRequired(type) ? '' : ' (optional)'}</h2>
              <p className="muted">
                {photoRequired(type) && `A clear photo of the ${cfg.label.toLowerCase()} is required - RoadMind's AI checks it and rates how severe it is.`}
                {!photoRequired(type) && type === 'DANGEROUS_CONDITION' && "A photo is optional. If you add one, RoadMind's AI will analyse it and the condition is also sent to staff for review."}
                {!photoRequired(type) && type !== 'DANGEROUS_CONDITION' && 'A photo is optional, but it helps staff verify your report.'}
              </p>
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
              <input ref={gallery} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = '' }} />
              <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = '' }} />
              <div className="row" style={{ marginTop: 16 }}>
                <button type="button" className="btn btn-soft" onClick={() => camera.current?.click()}><Camera size={18} aria-hidden="true" /> Take a photo</button>
                <button type="button" className="btn" onClick={() => gallery.current?.click()}><ImagePlus size={18} aria-hidden="true" /> Choose from gallery</button>
                {file && !photoRequired(type) && <button type="button" className="btn btn-ghost" onClick={removePhoto}>Remove photo</button>}
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
              {damage && samples.data?.length > 0 && (
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

          {step === 2 && (
            <>
              <h2>Location</h2>
              <p className="muted">Where is it? Click the exact spot on the map, or use your position.</p>
              <PointPicker value={loc} onChange={setLoc} emoji={cfg?.emoji} color={cfg?.color} idPrefix="report" />
              {validPoint(loc) && match && (
                <div className="match-box" role="status">
                  <MapPin size={20} aria-hidden="true" />
                  {match.matched ? (
                    <div>
                      RoadMind has a record of <b>{match.name}</b> <span className="muted">({highwayLabel(match.highway)})</span> <StateBadge state={match.state} />
                      {damage && match.state === 'UNKNOWN' && <div className="small muted" style={{ marginTop: 4 }}>RoadMind has no condition data for this road yet - your report will be its first.</div>}
                    </div>
                  ) : damage ? (
                    <div>RoadMind has no record of this road yet - your report will start one.</div>
                  ) : (
                    <div>Location noted. Staff will see it on the map.</div>
                  )}
                </div>
              )}
              <div className="field" style={{ marginTop: 18 }}>
                <label htmlFor="road">Road name</label>
                <input id="road" className="input" maxLength={160} value={roadName} onChange={(e) => { setRoadName(e.target.value); setNameTouched(true) }} placeholder="e.g. Poonamallee High Road" />
                <div className="hint">Optional. We fill it in when RoadMind knows the road; correct it if the sign says something else.</div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h2>Details</h2>
              <p className="muted">
                {damage ? 'Anything that helps the repair crew - near a junction, school or bus stop? How long has it been there?' : 'What is happening? For example how much of the road is affected and how long it has been like this.'}
              </p>
              <div className="field">
                <label htmlFor="desc">Description</label>
                <textarea id="desc" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What did you see?" />
                <div className="hint">{description.length}/1000 · optional</div>
              </div>
              <div className="match-box" style={{ marginTop: 4 }}>
                {preview ? <img src={preview} alt="" style={{ width: 64, height: 64, borderRadius: 14, objectFit: 'cover' }} /> : <span className="ev-summary-emoji" aria-hidden="true">{cfg?.emoji}</span>}
                <div className="small"><b>{cfg?.label}</b> · {roadName || match?.name || 'Reported location'}<br /><span className="muted">{validPoint(loc) ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : ''}</span></div>
              </div>
              {!damage && <Notice kind="info">After you submit, authorised staff verify this report. Until then it is shown as <strong>unverified</strong> and only slightly affects route suggestions.</Notice>}
              {type === 'DANGEROUS_CONDITION' && <Notice kind="info">{file ? "Your photo will be analysed by RoadMind's AI, and the condition is also sent to staff for review." : 'Without a photo this is sent to staff for review only.'}</Notice>}
              <Notice kind="info">Photos are stored without location or device metadata, and reports are shown without any personal information.</Notice>
            </>
          )}

          <div style={{ marginTop: 18 }}>
            <ErrorBox error={error} />
            {unauthorised && <Link className="btn btn-primary" to="/user/login" state={{ from: '/user/report' }}>Log in again</Link>}
          </div>
          <div className="wizard-nav">
            {step > 0 ? <button type="button" className="btn" onClick={() => { setError(null); setStep(step - 1) }}><ArrowLeft size={18} aria-hidden="true" /> Back</button> : <span />}
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn btn-primary" onClick={next}>Next <ArrowRight size={18} aria-hidden="true" /></button>
            ) : user ? (
              <button type="button" className="btn btn-primary btn-lg" onClick={submit} disabled={busy}><Send size={18} aria-hidden="true" /> {busy ? (file && damage ? 'Analysing photo…' : 'Sending…') : 'Submit Report'}</button>
            ) : (
              <Link className="btn btn-primary btn-lg" to="/user/login" state={{ from: '/user/report' }}><Send size={18} aria-hidden="true" /> Log in to submit</Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
