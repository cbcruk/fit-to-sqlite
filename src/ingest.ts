/**
 * Decodes a FIT file and stores each of its messages as a row in SQLite.
 *
 * @example
 * ```ts
 * import { readFile } from 'node:fs/promises'
 * import { openDb, ingest } from 'fit-to-sqlite'
 *
 * const db = openDb('activities.db')
 * ingest(db, await readFile('run.fit'), 'run.fit')
 * db.close()
 * ```
 *
 * @module
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Decoder, Stream, Profile } from '@garmin/fitsdk'
import { tx } from './db.ts'
import { normalize, epochOf } from './normalize.ts'

const MESG_NAME: Record<number, string> = Profile.types.mesgNum

/** Outcome of an {@linkcode ingest} call, discriminated by `status`. */
export type IngestResult =
  | {
      /** The file was decoded and stored. */
      status: 'imported'
      /** The new `fit_file.id`. */
      fileId: number
      /** Number of rows written to `message`. */
      messages: number
      /** `false` when the CRC did not match; the file is stored regardless. */
      integrityOk: boolean
      /** Decode warnings from the SDK. Empty for a clean file. */
      errors: string[]
    }
  | {
      /** A file with the same SHA-256 was already stored; nothing was written. */
      status: 'skipped'
      /** The `fit_file.id` of the existing file. */
      fileId: number
    }

/**
 * Decodes a FIT file and stores it in one transaction, skipping files already stored.
 *
 * Files are identified by the SHA-256 of `buf`. A CRC mismatch or SDK decode
 * warning does not stop ingestion; both are reported in the result instead.
 * When this throws, nothing is left in the database, so retrying the same
 * file is safe.
 *
 * @param db A connection from {@linkcode openDb}, which creates the schema.
 * @param buf The complete contents of a `.fit` file.
 * @param filename Recorded in `fit_file.filename` only; nothing is read from disk.
 * @throws {Error} When `buf` is not a FIT file, or when writing a message fails.
 *
 * @example Import a directory
 * ```ts
 * import { readdir, readFile } from 'node:fs/promises'
 * import { join } from 'node:path'
 * import { openDb, ingest } from 'fit-to-sqlite'
 *
 * const db = openDb('activities.db')
 * for (const name of await readdir('fit')) {
 *   const r = ingest(db, await readFile(join('fit', name)), name)
 *   if (r.status === 'imported' && !r.integrityOk) console.warn(`${name}: CRC mismatch`)
 * }
 * db.close()
 * ```
 */
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

  return tx(db, (): IngestResult => {
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
