import { useEffect, useRef } from 'react'

/**
 * The props every map engine reacts to the same way: `fit` (by value), `pan` (by lat/lng) and the overlay list.
 * `live` is the map instance once it exists (a state value, so the effects re-run for a new instance);
 * `handle.current` is { fitTo(bounds), panTo(point), mgr } of the engine. With `restore` (an engine switch that keeps the
 * user's current view) the first fit/pan is skipped so the view does not jump back to where the page once asked.
 */
export function useEngineSync(live, handle, { fit, pan, overlays, restore }) {
  const skip = useRef({ fit: !!restore, pan: !!restore })
  const fitKey = fit ? JSON.stringify(fit) : ''

  useEffect(() => {
    if (!live) return
    const skipped = skip.current.fit
    skip.current.fit = false
    if (fitKey && !skipped) handle.current.fitTo(JSON.parse(fitKey))
  }, [live, fitKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!live) return
    const skipped = skip.current.pan
    skip.current.pan = false
    if (pan && Number.isFinite(pan.lat) && Number.isFinite(pan.lng) && !skipped) handle.current.panTo(pan)
  }, [live, pan?.lat, pan?.lng]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (live) handle.current.mgr.sync(overlays)
  }, [live, overlays]) // eslint-disable-line react-hooks/exhaustive-deps
}
