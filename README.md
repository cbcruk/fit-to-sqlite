# fit-to-sqlite

A Node library that loads `.fit` files (Garmin/Wahoo/Suunto/Zwift) into a single SQLite database. It takes the raw bytes, decodes them, and stores each message as one row. It does no analysis — that is the job of whatever reads the resulting `.db`.

```ts
import { readFile } from 'node:fs/promises'
import { openDb, ingest } from 'fit-to-sqlite'

const db = openDb('activities.db')
const r = ingest(db, await readFile('run.fit'), 'run.fit')
// { status: 'imported', fileId: 1, messages: 1843, integrityOk: true, errors: [] }
db.close()
```

- Requires Node 24 or later. SQLite comes from the built-in `node:sqlite`.
- The only dependency is `@garmin/fitsdk`; there are no native modules to compile.
- Ingesting the same file twice skips it. Each file is loaded in a single transaction.

> Distribution status: not yet published to npm, and `package.json` has no `exports`. Node also does not type-strip `.ts` files inside `node_modules`, so consuming this as a package requires build output (`.js` + `.d.ts`). Until then, import `./src/db.ts` and `./src/ingest.ts` directly from within the repo.

## API

### `openDb(path: string): DatabaseSync`

Opens a `node:sqlite` `DatabaseSync` and creates the schema (`CREATE ... IF NOT EXISTS`, so calling it on an existing file is safe). Sets `journal_mode = WAL` and `synchronous = NORMAL`. The return value is a plain `DatabaseSync`, so you can query it directly; closing it is the caller's responsibility.

You can pass a `DatabaseSync` you opened yourself to `ingest`, but only `openDb` creates the schema.

### `ingest(db, buf, filename): IngestResult`

Synchronous. `buf` is the full contents of a `.fit` file (`Uint8Array`, including `Buffer`). `filename` is only recorded in `fit_file.filename`; nothing is read from disk.

```ts
type IngestResult =
  | { status: 'imported'; fileId: number; messages: number; integrityOk: boolean; errors: string[] }
  | { status: 'skipped'; fileId: number }
```

- `skipped` — a file with the same `sha256` already exists. `fileId` is the existing row's id.
- `imported` — `messages` is the number of messages stored; `errors` are the SDK's decode warnings as strings.
- `integrityOk: false` — the CRC did not match, but the file was loaded anyway. Some real device files have a bad CRC with perfectly intact content, so this does not block ingestion. Exclude `integrity_ok = 0` in your queries if you want to filter them out.

It throws in two cases: before decoding if the input is not a FIT file, and after rolling back if a write (INSERT) fails. Either way nothing is left in `fit_file`, so the next call will retry. Decode warnings do not throw; they are returned in `errors`.

### `tx(db, fn)`

Wraps `fn` in `BEGIN`/`COMMIT`, rolling back and rethrowing on error. It exists because `node:sqlite` has no `.transaction()` helper. Nesting is not supported — `ingest` already uses it internally, so wrapping an `ingest` call in `tx` issues `BEGIN` twice and fails.

### CLI

`src/cli.ts` is a thin wrapper around the API above. It prints a result per file plus totals, and keeps going when an individual file fails.

```bash
node src/cli.ts activities.db ~/Garmin/*.fit
```

## Output schema

These two tables are what the library guarantees.

```
fit_file(id, sha256 UNIQUE, filename, bytes, profile_version, integrity_ok, imported_at)
message(file_id, seq, kind, ts, data JSON)  -- PK (file_id, seq), WITHOUT ROWID
```

| Column | Meaning |
| --- | --- |
| `message.seq` | Order of appearance within the file, regardless of message type (starting at 0) |
| `message.kind` | The FIT profile message name as-is, in camelCase — `record`, `session`, `lap`, `fileId`, `deviceInfo`. Numbers missing from the profile become `unknown_<number>` |
| `message.ts` | Unix epoch (seconds) taken from `timestamp`, then `startTime`, then `timeCreated`. `NULL` if none exists |
| `message.data` | The message body as JSON, keyed by FIT profile field names |

No fields are promoted to columns up front. Once real queries reveal which fields matter, freeze them into views; if that is still too slow, promote them to generated columns. Neither requires re-ingesting.

```sql
ALTER TABLE message ADD COLUMN hr INTEGER
  GENERATED ALWAYS AS (json_extract(data, '$.heartRate')) VIRTUAL;
CREATE INDEX message_hr ON message(kind, hr) WHERE kind = 'record';
```

`kind` is kept in camelCase rather than converted to snake_case so the FIT profile documentation can be used directly as a lookup key.

### Recovering message relationships with `seq`

The `messages` tree returned by the SDK is grouped by type, which loses the relative order within the file. This library receives messages through `mesgListener` and records their order of appearance in `seq`. Since FIT writes each lap before its session, the lap↔session relationship can be recovered at query time instead of being resolved into a foreign key during ingestion.

```sql
SELECT (SELECT min(s.seq) FROM message s
         WHERE s.file_id = l.file_id AND s.kind = 'session' AND s.seq > l.seq) AS session_seq
FROM message l WHERE l.kind = 'lap';
```

### What `data` normalizes

With its default options, `@garmin/fitsdk`'s `Decoder.read()` already applies scale/offset, converts enums to strings, omits invalid fields, converts FIT epochs to `Date`, and expands components. The library adds only two things:

1. Adds `lat`/`lon` (degrees) from `positionLat`/`positionLong` (semicircles)
2. When `enhancedSpeed`/`enhancedAltitude`/`enhancedAvgSpeed`/`enhancedMaxSpeed` are present, overwrites `speed`/`altitude`/`avgSpeed`/`maxSpeed` with them

Original keys are never removed; only derived keys are added. `Date` values go through `JSON.stringify` and are stored as ISO strings.

"Invalid fields are omitted" applies only to scalar fields. Array fields keep `null` in invalid slots.

```json
{"time":[0.774,0.809,0.77,null,null]}   // hrv message
```

If you expand them with `json_each`, forgetting `WHERE value IS NOT NULL` inflates counts.

### Storage cost

For a 30-minute 1 Hz run (1,800 records), record JSON averages 273 bytes, and a 48 KB `.fit` becomes a 680 KB `.db` — roughly 14×, because key strings repeat on every row. At 300 activities a year that stays under 200 MB, which is fine for local analysis. By the time the ratio becomes a problem, you will already know which fields to promote.

## Ingestion guarantees and implementation notes

Idempotency is keyed on the `sha256` UNIQUE constraint, and each file is loaded in a single transaction, so a mid-load failure never leaves partial data behind.

This guarantee needed explicit handling. The SDK's `read()` wraps the entire decode in one `try/catch`, collects whatever it catches into `errors`, and returns normally from `finally`.

```js
catch (error) { errors.push(error); }
finally { return { messages, profileVersion, errors }; }
```

Anything thrown from `mesgListener` is swallowed in the same place. Left alone, an INSERT failure would masquerade as "1 decode warning" and the transaction would commit — a partial file would be recorded as `imported`, and because of `sha256` it would be skipped on every rerun and never recovered. So `src/ingest.ts` catches its own exceptions inside the listener and rethrows them after `read()` returns.

## Optional: SQL extensions

The two files in `sql/` sit outside the library API. Run them directly against an ingested `.db`.

```bash
sqlite3 activities.db < sql/views.sql
sqlite3 activities.db < sql/correct.sql   # requires views.sql first
```

### `views.sql`

Common query patterns frozen into views. They can be dropped or redefined at any time.

- `activity` — `session` messages: sport, start time, duration, distance, average speed/heart rate, ascent
- `trackpoint` — `record` messages: position, altitude, distance, speed, heart rate, cadence, power
- `lap` — `lap` messages with their owning `session_seq`

First-half vs. second-half average speed:

```sql
WITH a AS (SELECT file_id, seq, start_ts, timer_s FROM activity),
     h AS (SELECT a.seq AS sid, t.ts < a.start_ts + a.timer_s/2 AS front, t.speed
           FROM a JOIN trackpoint t ON t.file_id = a.file_id
           WHERE t.speed IS NOT NULL)
SELECT sid,
       round(avg(CASE WHEN front THEN speed END), 3)     AS front_mps,
       round(avg(CASE WHEN NOT front THEN speed END), 3) AS back_mps,
       round(100 * (1 - avg(CASE WHEN NOT front THEN speed END)
                      / avg(CASE WHEN front THEN speed END)), 1) AS fade_pct
FROM h GROUP BY sid ORDER BY fade_pct DESC;
```

### `correct.sql` — GPS artifact correction

When a course passes under something that blocks the sky (such as the underside of a bridge), GPS drops out and then reacquires, and the device odometer adds 20–30 m in a single step. Speed and cadence don't change at all at that moment, so it is not distance actually covered.

```
seq 68  21:10:39  no GPS        odo 3.3m   speed 2.21  cadence 85
seq 69  21:10:41  GPS back      odo 4.4m   speed 2.21  cadence 85
seq 70  21:10:42  GPS 3.1m      odo 2.2m   speed 2.21  cadence 85
seq 71  21:10:44  GPS 4.1m      odo 20.6m  speed 2.21  cadence 85   <- jump
```

A step is flagged when `odometer delta > GPS distance × 2` and `excess > 5 m`. Only flagged steps are replaced with the GPS distance; everything else keeps the odometer value. Records without GPS and the first record are never flagged.

The original `message` table is untouched; derived values go into `record_geo`. If the criteria change, just rerun `correct.sql`.

```
record_geo(file_id, seq, gps_m, odo_m, is_artifact, step_m, dist_fix)  -- PK (file_id, seq)
```

- `trackpoint_fix` — `trackpoint` with the columns above appended
- `activity_fix` — raw and corrected distance and pace side by side

The correction is conservative. It only removes flagged jumps, so ordinary overcounting from GPS noise remains. In real data, corrected values fell between the raw value and the summed GPS track.

## Reading the `.db` with `node:sqlite`

Things that trip up anyone used to `bun:sqlite` / `better-sqlite3`. Some of these were first hit by [github-stars-to-sqlite](https://github.com/cbcruk/github-stars-to-sqlite) on the same bindings.

- There are no `.transaction()` or `.pragma()` helpers. Use `tx()` for transactions and `db.exec()` for PRAGMAs. `DatabaseSync` enables `foreign_keys` by default.
- `synchronous` is a per-connection setting, so checking it with the `sqlite3` CLI shows the CLI's own default. Only `journal_mode` persists in the file header.
- `prepare` has no generics. `get()` returns `unknown`, so cast at the call site. Returned rows are `null`-prototype objects, and a missing row is `undefined`.

  ```ts
  db.prepare('SELECT id FROM fit_file WHERE sha256 = ?').get(sha) as { id: number } | undefined
  ```

- Only `null`/number/bigint/string/`Uint8Array` can be bound. Booleans throw — which is why `integrity_ok` is stored as `1`/`0`. `run()` returns `{ changes, lastInsertRowid }` as numbers.
- Use single quotes for string literals in SQL. Double quotes are parsed as identifiers — JSON paths (`'$.heartRate'`) included.
- `null`-prototype objects can't cross serialization boundaries. When passing rows from RSC to a client component, convert them with `.map((r) => ({ ...r }))`.
- On read-only filesystems (such as Vercel functions), open with `` new DatabaseSync(`file:${path}?immutable=1`, { readOnly: true }) ``. Otherwise SQLite fails trying to create `-shm`/`-wal`. This mode does not read `-wal`, so folding it in with `PRAGMA wal_checkpoint(TRUNCATE)` after ingestion becomes a correctness requirement.

## Development

```bash
pnpm install
pnpm typecheck
node make-fixture.ts && node src/cli.ts test.db fixture.fit
```

`make-fixture.ts` uses the SDK's `Encoder` to synthesize a 30-minute run with a 15% slowdown in the second half. It contains zero artifacts, so running `correct.sql` on it must leave the distance identical to the original — a regression guard that clean data stays untouched.

`.ts` files run directly through Node's type stripping with no build step, which puts three requirements on the tsconfig:

- `moduleResolution: "bundler"` — the SDK's `.d.ts` uses extensionless relative imports (`export * from './types/decoder'`), which `"nodenext"` cannot resolve, leaving `Decoder`, `Profile`, etc. unresolved. Runtime resolution is done by Node, so this has no runtime effect.
- `erasableSyntaxOnly: true` — type stripping only blanks out types, so syntax that generates code, such as `enum` or parameter properties, won't run. This flag rejects it at `tsc` time.
- Relative imports keep their `.ts` extension. Drop it and Node can't find the file.

## Open question: scope boundary

`correct.sql` is interpretation, not ingestion, so it straddles this library's boundary. For now it is an optional step outside the API, kept separate and non-destructive to the original data.

- Coupling ingestion and correction via an `ingest` option or a CLI `--correct` flag is on hold. It would be convenient, but it mixes ingestion and interpretation in a single call.
- Whether per-bridge artifact rates (A 21–41%, B 0–16%) correlate with time of day or weather needs more files to tell, and is clearly the job of whatever consumes the `.db`.

If `correct.sql` is never run, `record_geo` simply doesn't exist and everything else works as before.
