import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fit_file (
  id              INTEGER PRIMARY KEY,
  sha256          TEXT    NOT NULL UNIQUE,
  filename        TEXT    NOT NULL,
  bytes           INTEGER NOT NULL,
  profile_version TEXT,
  integrity_ok    INTEGER NOT NULL,
  imported_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 메시지 하나 = row 하나. 본문은 FIT 프로파일 이름 그대로의 JSON.
-- seq 는 타입 무관 파일 전체 등장 순서라, lap 이 session 앞에 온다는
-- FIT 의 순서 규약을 나중에도 복원할 수 있다.
CREATE TABLE IF NOT EXISTS message (
  file_id INTEGER NOT NULL REFERENCES fit_file(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  ts      INTEGER,
  data    TEXT    NOT NULL,
  PRIMARY KEY (file_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS message_kind_ts ON message(kind, ts);
CREATE INDEX IF NOT EXISTS message_file_kind ON message(file_id, kind, seq);
`

export function openDb(path: string): DatabaseSync {
  // node:sqlite 에는 better-sqlite3 의 .pragma() 헬퍼가 없다. exec 로 직접 건다.
  // foreign_keys 는 DatabaseSync 가 기본으로 켜므로 다시 걸지 않는다.
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  return db
}

/**
 * node:sqlite 에는 bun:sqlite / better-sqlite3 의 db.transaction() 헬퍼가
 * 없다. BEGIN/COMMIT 을 직접 건다. 예외가 나면 ROLLBACK 하고 다시 던진다.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
