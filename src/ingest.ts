import { createHash } from 'node:crypto'
import { Decoder, Stream, Profile } from '@garmin/fitsdk'
import type { Database as DB } from 'bun:sqlite'
import { normalize, epochOf } from './normalize.ts'

const MESG_NAME: Record<number, string> = Profile.types.mesgNum

export type IngestResult =
  | { status: 'imported'; fileId: number; messages: number; integrityOk: boolean; errors: string[] }
  | { status: 'skipped'; fileId: number }

export function ingest(db: DB, buf: Uint8Array, filename: string): IngestResult {
  const sha256 = createHash('sha256').update(buf).digest('hex')

  const existing = db
    .prepare<{ id: number }, [string]>('SELECT id FROM fit_file WHERE sha256 = ?')
    .get(sha256)
  if (existing) return { status: 'skipped', fileId: existing.id }

  if (!Decoder.isFIT(Stream.fromBuffer(buf))) {
    throw new Error(`FIT 파일이 아님: ${filename}`)
  }
  // checkIntegrity 는 스트림을 소비하므로 read 용 Decoder 는 따로 만든다.
  const integrityOk = new Decoder(Stream.fromBuffer(buf)).checkIntegrity()

  const insertFile = db.prepare(`
    INSERT INTO fit_file (sha256, filename, bytes, profile_version, integrity_ok)
    VALUES (?, ?, ?, ?, ?)
  `)
  const insertMesg = db.prepare(`
    INSERT INTO message (file_id, seq, kind, ts, data) VALUES (?, ?, ?, ?, ?)
  `)

  const run = db.transaction((): IngestResult => {
    // profile_version 은 read 이후에 알 수 있으므로 일단 NULL 로 넣고 갱신한다.
    const fileId = Number(
      insertFile.run(sha256, filename, buf.length, null, integrityOk ? 1 : 0).lastInsertRowid,
    )

    let seq = 0
    const decoder = new Decoder(Stream.fromBuffer(buf))
    const { profileVersion, errors } = decoder.read({
      // 타입별로 묶인 messages 트리는 파일 내 상대 순서를 잃는다.
      // listener 로 받으면 lap→session 같은 원래 순서가 seq 에 보존된다.
      mesgListener: (mesgNum, mesg) => {
        const kind = MESG_NAME[mesgNum] ?? `unknown_${mesgNum}`
        const data = normalize(kind, mesg)
        insertMesg.run(fileId, seq++, kind, epochOf(data), JSON.stringify(data))
      },
    })

    db.prepare('UPDATE fit_file SET profile_version = ? WHERE id = ?').run(
      `${profileVersion.major}.${profileVersion.minor}`,
      fileId,
    )

    return {
      status: 'imported',
      fileId,
      messages: seq,
      integrityOk,
      errors: errors.map((e) => e.message),
    }
  })

  return run()
}
