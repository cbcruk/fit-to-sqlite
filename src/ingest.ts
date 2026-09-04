import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Decoder, Stream, Profile } from '@garmin/fitsdk'
import { normalize, epochOf } from './normalize.ts'

const MESG_NAME: Record<number, string> = Profile.types.mesgNum

export type IngestResult =
  | { status: 'imported'; fileId: number; messages: number; integrityOk: boolean; errors: string[] }
  | { status: 'skipped'; fileId: number }

/** node:sqlite 에는 better-sqlite3/bun 의 .transaction() 헬퍼가 없다. */
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function ingest(db: DatabaseSync, buf: Uint8Array, filename: string): IngestResult {
  const sha256 = createHash('sha256').update(buf).digest('hex')

  const existing = db.prepare('SELECT id FROM fit_file WHERE sha256 = ?').get(sha256) as
    | { id: number }
    | undefined
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

  return transaction(db, (): IngestResult => {
    // profile_version 은 read 이후에 알 수 있으므로 일단 NULL 로 넣고 갱신한다.
    const fileId = Number(
      insertFile.run(sha256, filename, buf.length, null, integrityOk ? 1 : 0).lastInsertRowid,
    )

    let seq = 0
    // SDK 의 read() 는 디코드 전체를 try/catch 로 감싸고 잡은 걸 errors 에
    // 담은 뒤 finally 에서 정상 반환한다. 리스너에서 던진 것도 똑같이 삼켜
    // 지므로, INSERT 실패가 '디코드 경고' 로 둔갑해 반쪽 파일이 커밋된다.
    // 우리 예외는 우리가 잡아 두고 read() 가 끝난 뒤 다시 던진다.
    let writeError: unknown
    const decoder = new Decoder(Stream.fromBuffer(buf))
    const { profileVersion, errors } = decoder.read({
      // 타입별로 묶인 messages 트리는 파일 내 상대 순서를 잃는다.
      // listener 로 받으면 lap→session 같은 원래 순서가 seq 에 보존된다.
      mesgListener: (mesgNum, mesg) => {
        // 한 번 실패하면 남은 메시지는 어차피 롤백되므로 건너뛴다.
        if (writeError !== undefined) return
        try {
          const kind = MESG_NAME[mesgNum] ?? `unknown_${mesgNum}`
          const data = normalize(kind, mesg)
          insertMesg.run(fileId, seq++, kind, epochOf(data), JSON.stringify(data))
        } catch (err) {
          writeError = err ?? new Error('알 수 없는 적재 실패')
        }
      },
    })
    if (writeError !== undefined) throw writeError

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
}
