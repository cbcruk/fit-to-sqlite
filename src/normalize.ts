import type { Mesg } from '@garmin/fitsdk'

const SEMI_TO_DEG = 180 / 2 ** 31

/**
 * SDK 가 이미 처리하는 것: scale/offset, enum→문자열, invalid→필드 생략,
 * FIT epoch→Date, component 전개.
 *
 * 남는 것은 아래 두 가지뿐이다.
 *   1. position_lat/long 이 semicircles 라 degrees 로 바꿔야 한다.
 *   2. enhanced_* 가 있으면 그쪽이 정확하므로 우선한다.
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

/** 인덱싱용 unix epoch(초). timestamp 없는 메시지는 null. */
export function epochOf(m: Record<string, unknown>): number | null {
  const t = m.timestamp ?? m.startTime ?? m.timeCreated
  if (t instanceof Date) return Math.floor(t.getTime() / 1000)
  return null
}
