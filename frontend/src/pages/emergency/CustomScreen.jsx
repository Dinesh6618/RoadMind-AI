import PlaceField from '../routes/PlaceField'
import { ScreenHead } from './ui'

/** Custom Location: search any destination (hospital, clinic, station, an accident location, any place) or pick it on the map. */
export default function CustomScreen({ dest, onChoose, suggestions, picking, onPickToggle }) {
  return (
    <>
      <ScreenHead title="Custom Location" />
      <div className="em-card em-custom">
        <PlaceField label="Destination" tag="to" value={dest} onChange={onChoose} suggestions={suggestions} picking={picking} onPickToggle={onPickToggle} />
        <p className="small muted em-custom-hint">Search a hospital, clinic, station, an accident location or any place - or use the pin button to pick the spot on the map.</p>
        {picking && <p className="em-pickhint" role="status">Tap a point on the map to set the destination.</p>}
      </div>
    </>
  )
}
