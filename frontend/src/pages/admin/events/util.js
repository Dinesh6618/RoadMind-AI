// Small helpers shared by the staff Road events page and its parts.

/** What the server does when the account is not allowed: say it in words. (401 is handled by logging out, see RoadEvents.) */
export function explain(err) {
  if (err?.status === 403) {
    const e = new Error('Your account is not authorised to review road events. Only administrators and road-maintenance staff can.')
    e.status = 403
    return e
  }
  return err
}

export const HOURS_MIN = 1
export const HOURS_MAX = 720
export const RADIUS_MIN = 10
export const RADIUS_MAX = 500

/** A blank field means "use the default" -> { value: undefined }. Anything else must be a number inside the limits. */
export function parseNumber(text, { min, max, label, unit }) {
  const t = String(text ?? '').trim()
  if (t === '') return { value: undefined }
  const n = Number(t)
  if (!Number.isFinite(n) || n < min || n > max) return { error: `${label} must be between ${min} and ${max}${unit ? ` ${unit}` : ''}.` }
  return { value: n }
}

// How long each kind of event lasts when the staff member does not say (the server's defaults, config/roadmind.yaml).
export const DEFAULT_HOURS = { ROAD_BLOCKED: 6, ROAD_CLOSED: 12, TEMPORARY_CLOSURE: 6, CONSTRUCTION: 24, ACCIDENT: 3, FLOODED: 12, SEVERE_DAMAGE: 72 }
export const DEFAULT_RADIUS_M = 50
export const BLOCKING_TYPES = ['ROAD_BLOCKED', 'ROAD_CLOSED', 'TEMPORARY_CLOSURE']

export const EVENT_TYPE_ORDER = ['ROAD_BLOCKED', 'ROAD_CLOSED', 'TEMPORARY_CLOSURE', 'CONSTRUCTION', 'ACCIDENT', 'FLOODED', 'SEVERE_DAMAGE', 'ROAD_REOPENED']

/** The lifecycle bucket of an event, one per event, so the tabs and the counts always add up. */
export function bucketOf(ev) {
  if (ev.verification_status === 'REJECTED') return 'rejected'
  if (ev.verification_status === 'PENDING' && ev.display_status === 'PENDING') return 'review' // still live and unverified
  if (ev.display_status === 'ACTIVE') return 'active'
  return 'closed' // resolved, or its time is up (an unverified report nobody confirmed in time lands here; staff can still verify it)
}

/** The image types the server accepts for evidence photos. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export function checkImage(file) {
  if (!file) return 'Choose a photo first.'
  if (!IMAGE_TYPES.includes(file.type)) return 'Please choose a JPEG, PNG or WebP image.'
  if (file.size > MAX_IMAGE_BYTES) return 'That image is larger than 8 MB.'
  return null
}
