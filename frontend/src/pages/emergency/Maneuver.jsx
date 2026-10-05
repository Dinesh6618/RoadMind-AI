import {
  ArrowUp, ArrowUpLeft, ArrowUpRight, CornerDownLeft, CornerDownRight, CornerUpLeft, CornerUpRight, Flag, GitMerge, RotateCcw, RotateCw, Undo2, Redo2,
} from 'lucide-react'

/**
 * The arrow for a step's `maneuver` (Google's Maneuver enum names). Anything unknown or missing is a plain "straight on" arrow.
 */
export function maneuverIcon(maneuver) {
  const m = String(maneuver || '').toUpperCase()
  if (!m) return ArrowUp
  if (m.includes('DESTINATION') || m === 'ARRIVE') return Flag
  if (m.includes('UTURN')) return m.includes('RIGHT') ? Redo2 : Undo2
  if (m.includes('ROUNDABOUT')) return m.includes('LEFT') ? RotateCcw : RotateCw
  if (m.includes('MERGE')) return GitMerge
  if (m.includes('SHARP')) return m.includes('LEFT') ? CornerDownLeft : CornerDownRight
  if (m.includes('SLIGHT') || m.includes('FORK') || m.includes('RAMP')) return m.includes('LEFT') ? ArrowUpLeft : m.includes('RIGHT') ? ArrowUpRight : ArrowUp
  if (m.includes('LEFT')) return CornerUpLeft
  if (m.includes('RIGHT')) return CornerUpRight
  return ArrowUp
}

export default function Maneuver({ maneuver, size = 34 }) {
  const Icon = maneuverIcon(maneuver)
  return <Icon size={size} strokeWidth={2.6} aria-hidden="true" />
}
