import { CircleDot, Construction, OctagonX, ShieldAlert, TriangleAlert, Waves, Zap } from 'lucide-react'

/**
 * What a person can report (the `report_type` of POST /api/road-reports).
 *   photo: 'required' | 'optional'      damage: the photo goes through the AI damage detector
 *   emoji: what the map marker shows     event: the kind of road event it becomes (when it is one)
 */
export const REPORT_TYPES = [
  { value: 'POTHOLE', label: 'Pothole', help: 'A hole or broken patch in the road surface.', icon: CircleDot, emoji: '🕳️', color: '#e0342f', photo: 'required', damage: true },
  { value: 'CRACK', label: 'Crack', help: 'Long, cross or interlinked (alligator) cracks in the surface.', icon: Zap, emoji: '⚡', color: '#f7762c', photo: 'required', damage: true },
  { value: 'FLOODING', label: 'Flooding', help: 'Water standing on or running across the road.', icon: Waves, emoji: '🌊', color: '#2563eb', photo: 'optional', event: 'FLOODED' },
  { value: 'ACCIDENT', label: 'Accident', help: 'A crash or a broken-down vehicle that is in the way.', icon: TriangleAlert, emoji: '⚠️', color: '#d97706', photo: 'optional', event: 'ACCIDENT' },
  { value: 'BLOCKED_ROAD', label: 'Blocked road', help: 'The road cannot be passed - a fallen tree, a barrier, a protest.', icon: OctagonX, emoji: '🚧', color: '#e0342f', photo: 'optional', event: 'ROAD_BLOCKED' },
  { value: 'CONSTRUCTION', label: 'Construction', help: 'Roadworks, or a lane closed for work.', icon: Construction, emoji: '🚧', color: '#f2b01e', photo: 'optional', event: 'CONSTRUCTION' },
  { value: 'DANGEROUS_CONDITION', label: 'Dangerous road condition', help: 'Anything else that makes the road dangerous - an open manhole, a collapsed edge.', icon: ShieldAlert, emoji: '🕳️', color: '#a3191a', photo: 'optional', damage: true, event: 'SEVERE_DAMAGE' },
]

export const TYPE_BY_VALUE = Object.fromEntries(REPORT_TYPES.map((t) => [t.value, t]))

/** Reports whose photo is run through the AI damage detector (a dangerous condition only when it has a photo). */
export const isDamageType = (value) => !!TYPE_BY_VALUE[value]?.damage
export const photoRequired = (value) => TYPE_BY_VALUE[value]?.photo === 'required'
