/**
 * Fills the few gaps the FIT SDK's decoder leaves before a message is stored as JSON.
 *
 * @example
 * ```ts
 * import type { Mesg } from '@garmin/fitsdk'
 * import { normalize, epochOf } from 'fit-to-sqlite'
 *
 * const mesg = {
 *   timestamp: new Date('2026-03-01T07:00:00Z'),
 *   positionLat: 448185803,
 *   positionLong: 1514906548,
 *   enhancedSpeed: 3.412,
 * } as Mesg
 *
 * const data = normalize('record', mesg)
 * // data.lat ≈ 37.5665, data.lon ≈ 126.978, data.speed === 3.412
 * epochOf(data) // 1772348400
 * ```
 *
 * @module
 */
import type { Mesg } from '@garmin/fitsdk'

const SEMI_TO_DEG = 180 / 2 ** 31

/**
 * Returns a copy of a decoded message with degree coordinates added and enhanced values preferred.
 *
 * The SDK's `Decoder.read()` already applies scale/offset, maps enums to
 * strings, omits invalid fields, converts FIT epochs to `Date`, and expands
 * components. This handles the rest:
 *
 * - Adds `lat`/`lon` in degrees from `positionLat`/`positionLong` (semicircles).
 * - Overwrites `speed`, `altitude`, `avgSpeed`, and `maxSpeed` with their
 *   `enhanced*` counterparts when present, since those are more precise.
 *
 * Original keys are kept, except `mesgNum`, which is dropped.
 *
 * @param kind The FIT profile message name, such as `record`. Currently unused.
 */
export function normalize(kind: string, mesg: Mesg): Record<string, unknown> {
  const m = { ...mesg } as Record<string, unknown>
  delete m.mesgNum

  if (typeof m.positionLat === 'number') m.lat = m.positionLat * SEMI_TO_DEG
  if (typeof m.positionLong === 'number') m.lon = m.positionLong * SEMI_TO_DEG

  if (typeof m.enhancedSpeed === 'number') m.speed = m.enhancedSpeed
  if (typeof m.enhancedAltitude === 'number') m.altitude = m.enhancedAltitude
  if (typeof m.enhancedAvgSpeed === 'number') m.avgSpeed = m.enhancedAvgSpeed
  if (typeof m.enhancedMaxSpeed === 'number') m.maxSpeed = m.enhancedMaxSpeed

  return m
}

/**
 * Picks the message's timestamp as Unix seconds, for the indexed `message.ts` column.
 *
 * Tries `timestamp`, then `startTime`, then `timeCreated`.
 *
 * @param m A message returned by {@linkcode normalize}.
 * @returns Seconds since the Unix epoch, or `null` when the message has no timestamp.
 */
export function epochOf(m: Record<string, unknown>): number | null {
  const t = m.timestamp ?? m.startTime ?? m.timeCreated
  if (t instanceof Date) return Math.floor(t.getTime() / 1000)
  return null
}
