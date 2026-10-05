import { CircleCheck, ChevronRight, LocateFixed, Pencil, RefreshCw } from 'lucide-react'
import PlaceField from '../routes/PlaceField'
import { TEXT } from './emergencyFormat'
import { Dots } from './ui'

/**
 * Where the person is starting from. GPS is asked for ONLY when "Use My Location" / "Update my location" is tapped, once per tap.
 * If it is refused or fails, the exact owner-approved sentence is shown and the manual start search opens.
 *
 * `compact` = a one-line "Starting from ..." row (used once a start exists); otherwise the large light-blue card of the options screen.
 */
export default function StartPanel({ start, locating, gpsError, onLocate, manualOpen, onManual, onPlace, suggestions, picking, onPickToggle, compact = false }) {
  const showManual = manualOpen || !!gpsError
  return (
    <section className={`em-loc${compact ? ' is-compact' : ''}`} aria-label="Starting point">
      {!start ? (
        <button type="button" className="em-loccard" onClick={onLocate} disabled={locating} aria-label="Use my location">
          <span className="em-loccard-ico" aria-hidden="true"><LocateFixed size={26} /></span>
          <span className="em-loccard-txt"><b>Use My Location</b><small>{locating ? 'Finding your location…' : 'Use your current location as starting point'}</small></span>
          {locating ? <Dots /> : <ChevronRight size={20} aria-hidden="true" />}
        </button>
      ) : (
        <div className="em-loccard is-set">
          <span className="em-loccard-ico is-ok" aria-hidden="true"><CircleCheck size={24} /></span>
          <span className="em-loccard-txt"><small>Starting from</small><b>{start.name}</b></span>
          <span className="em-loc-actions">
            {start.source === 'gps' && (
              <button type="button" className="em-mini" onClick={onLocate} disabled={locating}><RefreshCw size={15} aria-hidden="true" className={locating ? 'em-rot' : ''} /> {locating ? 'Updating…' : 'Update my location'}</button>
            )}
            <button type="button" className="em-mini" onClick={onManual} aria-expanded={showManual}><Pencil size={15} aria-hidden="true" /> Change</button>
          </span>
        </div>
      )}

      {gpsError && (
        <div className="em-gpserr" role="alert">
          {gpsError === 'denied' ? TEXT.gpsDenied : TEXT.gpsFailed}
          <small>You can type or pick your starting place below instead.</small>
        </div>
      )}

      {showManual ? (
        <div className="em-manual">
          <PlaceField label="Starting place" tag="from" value={start && start.source !== 'gps' ? start : null} onChange={onPlace} suggestions={suggestions} picking={picking} onPickToggle={onPickToggle} />
        </div>
      ) : !start && (
        <button type="button" className="em-link" onClick={onManual}>Or enter a starting place instead</button>
      )}
    </section>
  )
}
