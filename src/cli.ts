#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { openDb } from './db.ts'
import { ingest } from './ingest.ts'

const [dbPath, ...files] = process.argv.slice(2)

if (!dbPath || files.length === 0) {
  console.error('usage: fit-to-sqlite <db.sqlite> <file.fit...>')
  process.exit(1)
}

const db = openDb(dbPath)
let imported = 0
let skipped = 0
let failed = 0

for (const path of files) {
  try {
    const buf = await readFile(path)
    const r = ingest(db, buf, basename(path))
    if (r.status === 'skipped') {
      skipped++
      continue
    }
    imported++
    const warn = [
      r.integrityOk ? null : 'CRC 불일치',
      r.errors.length ? `디코드 경고 ${r.errors.length}건` : null,
    ].filter(Boolean)
    console.log(
      `${basename(path)}  #${r.fileId}  메시지 ${r.messages}` +
        (warn.length ? `  [${warn.join(', ')}]` : ''),
    )
  } catch (err) {
    failed++
    console.error(`${basename(path)}  실패: ${(err as Error).message}`)
  }
}

db.close()
console.log(`\n적재 ${imported} / 중복 건너뜀 ${skipped} / 실패 ${failed}`)
