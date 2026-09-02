import { writeFileSync } from 'node:fs'
import { Encoder, Profile } from '@garmin/fitsdk'
import type {
  Encodable,
  FileIdMesg,
  RecordMesg,
  LapMesg,
  SessionMesg,
  ActivityMesg,
} from '@garmin/fitsdk'

// .fit 파일 없이 파이프라인을 확인하기 위한 합성 활동.
// 30분 러닝, 후반부에 4.0 -> 3.4 m/s 로 15% 감속.
const enc = new Encoder()
const t0 = new Date('2026-03-01T07:00:00Z')
const at = (s: number) => new Date(+t0 + s * 1000)

const fileId: Encodable<FileIdMesg> = {
  mesgNum: Profile.MesgNum.FILE_ID,
  type: 'activity',
  manufacturer: 'garmin',
  product: 3843,
  serialNumber: 12345,
  timeCreated: t0,
}
enc.writeMesg(fileId)

let dist = 0
for (let i = 0; i < 1800; i++) {
  const speed = i < 900 ? 4.0 : 3.4
  dist += speed
  const rec: Encodable<RecordMesg> = {
    mesgNum: Profile.MesgNum.RECORD,
    timestamp: at(i),
    positionLat: 447512345 + i * 40,
    positionLong: 1512345678 + i * 40,
    heartRate: 140 + Math.floor(i / 200),
    cadence: 84,
    distance: dist,
    enhancedSpeed: speed,
    enhancedAltitude: 40 + Math.sin(i / 100) * 5,
  }
  enc.writeMesg(rec)
}

for (const [idx, lo, hi] of [
  [0, 0, 900],
  [1, 900, 1800],
] as const) {
  const lap: Encodable<LapMesg> = {
    mesgNum: Profile.MesgNum.LAP,
    messageIndex: idx,
    timestamp: at(hi),
    startTime: at(lo),
    totalTimerTime: hi - lo,
    totalDistance: (hi - lo) * (idx ? 3.4 : 4.0),
    avgHeartRate: 145 + idx * 5,
  }
  enc.writeMesg(lap)
}

const session: Encodable<SessionMesg> = {
  mesgNum: Profile.MesgNum.SESSION,
  messageIndex: 0,
  timestamp: at(1800),
  sport: 'running',
  subSport: 'road',
  startTime: t0,
  totalTimerTime: 1800,
  totalElapsedTime: 1800,
  totalDistance: dist,
  avgHeartRate: 148,
  maxHeartRate: 165,
  totalAscent: 12,
  totalDescent: 12,
  enhancedAvgSpeed: dist / 1800,
}
enc.writeMesg(session)

const activity: Encodable<ActivityMesg> = {
  mesgNum: Profile.MesgNum.ACTIVITY,
  timestamp: at(1800),
  numSessions: 1,
  type: 'manual',
  totalTimerTime: 1800,
}
enc.writeMesg(activity)

writeFileSync('fixture.fit', enc.close())
console.log('fixture.fit 생성 (record 1800, lap 2, session 1)')
