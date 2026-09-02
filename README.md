# fit-to-sqlite

`.fit` 파일(Garmin/Wahoo/Suunto/Zwift)을 SQLite 하나에 적재한다. 적재까지가 이 저장소의 책임이고, 분석은 만들어진 `.db` 를 입력으로 받는 쪽에서 한다.

```bash
bun install
bun src/cli.ts activities.db ~/Garmin/*.fit
sqlite3 activities.db < sql/views.sql
sqlite3 activities.db < sql/correct.sql   # 선택: GPS 아티팩트 보정
```

런타임은 Bun 이다. `.ts` 를 그대로 실행하므로 빌드 단계가 없고, SQLite 는 내장 `bun:sqlite` 를 쓰므로 네이티브 모듈 컴파일도 없다 — 의존성은 `@garmin/fitsdk` 하나뿐이다.

## 스키마

테이블은 둘뿐이다.

```
fit_file(id, sha256 UNIQUE, filename, bytes, profile_version, integrity_ok, imported_at)
message(file_id, seq, kind, ts, data JSON)  -- PK (file_id, seq), WITHOUT ROWID
```

메시지 하나가 row 하나고, 본문은 FIT 프로파일 필드명 그대로의 JSON이다. 어떤 필드를 컬럼으로 승격할지 미리 정하지 않는다. 질의를 몇 번 돌려서 실제 쓰는 필드가 드러난 다음 `sql/views.sql` 에 뷰로 굳히고, 그래도 느리면 생성 컬럼으로 승격한다. 셋 다 재적재가 필요 없다.

```sql
ALTER TABLE message ADD COLUMN hr INTEGER
  GENERATED ALWAYS AS (json_extract(data, '$.heartRate')) VIRTUAL;
CREATE INDEX message_hr ON message(kind, hr) WHERE kind = 'record';
```

### `seq` 가 하는 일

SDK가 돌려주는 `messages` 트리는 타입별로 묶여 있어서 파일 내 상대 순서를 잃는다. 이 구현은 `mesgListener` 로 받아 타입 무관 등장 순서를 `seq` 에 남긴다. FIT은 lap 을 자기 session 앞에 쓰므로, 이 순서만 있으면 lap↔session 관계를 적재 시점에 FK로 풀지 않고 나중에 뷰에서 복원할 수 있다.

```sql
SELECT (SELECT min(s.seq) FROM message s
         WHERE s.file_id = l.file_id AND s.kind='session' AND s.seq > l.seq) AS session_seq
FROM message l WHERE l.kind='lap';
```

`kind` 는 FIT 프로파일 이름 그대로 camelCase다 — `record`, `session`, `lap`, `fileId`, `deviceInfo`. 스네이크로 바꾸지 않았다. 프로파일 문서를 그대로 조회 키로 쓸 수 있는 편이 낫다.

## 정규화 범위

`@garmin/fitsdk` 의 `Decoder.read()` 기본 옵션이 scale/offset 적용, enum→문자열, invalid→필드 생략, FIT epoch→`Date`, component 전개를 이미 처리한다. 직접 손대는 건 `src/normalize.ts` 의 두 가지뿐이다.

1. `positionLat`/`positionLong` 은 semicircles → `lat`/`lon` (degrees) 추가
2. `enhancedSpeed`/`enhancedAltitude` 등이 있으면 `speed`/`altitude` 로 덮어씀

원본 키는 지우지 않는다. 파생 키만 추가한다.

`invalid→필드 생략` 은 스칼라 필드에만 해당한다. 배열 필드는 슬롯이 `null` 로 남는다.

```json
{"time":[0.774,0.809,0.77,null,null]}   // hrv 메시지
```

`json_each` 로 펼칠 때 `WHERE value IS NOT NULL` 을 빠뜨리면 개수가 부풀려진다.

## GPS 아티팩트 보정

`sql/correct.sql` 은 선택 단계다. 코스에 상공이 가리는 지점(교량 하부 등)이 있으면 GPS 가 끊겼다 복귀하면서 기기 오도미터가 20~30m 를 한 번에 더한다. 그 순간 속도와 케이던스는 전혀 변하지 않으므로 실제로 뛴 거리가 아니다.

```
seq 68  21:10:39  GPS 없음       오도 3.3m   속도 2.21  케이던스 85
seq 69  21:10:41  GPS 복귀       오도 4.4m   속도 2.21  케이던스 85
seq 70  21:10:42  GPS 3.1m      오도 2.2m   속도 2.21  케이던스 85
seq 71  21:10:44  GPS 4.1m      오도 20.6m  속도 2.21  케이던스 85   <- 점프
```

20.6m 를 2초에 갔다면 10.3 m/s 다. 케이던스가 85 에서 미동도 않는다.

판정 기준은 `오도미터 증분 > GPS 이동거리 × 2` 이면서 `초과분 > 5m` 다. 판정된 구간만 GPS 이동거리로 대체하고 나머지는 오도미터를 그대로 쓴다 — 정상 구간에서는 둘이 이미 일치하기 때문이다. GPS 가 없는 레코드나 첫 레코드는 판정하지 않는다.

원본은 `message` 에 손대지 않고 파생값만 `record_geo` 에 쌓는다. 기준이 바뀌면 `correct.sql` 만 다시 실행하면 되고 재적재는 필요 없다.

```
record_geo(file_id, seq, gps_m, odo_m, is_artifact, step_m, dist_fix)  -- PK (file_id, seq)
```

`trackpoint_fix` 는 `trackpoint` 에 위 컬럼을 덧붙인 것이고, `activity_fix` 는 원본/보정 거리와 페이스를 나란히 낸다. 어느 쪽을 쓸지는 질의에서 고른다.

보정은 보수적이다. 판정된 점프만 걷어내므로 GPS 잡음으로 인한 일반적인 과대계상은 남는다. 실측에서 보정값은 원본과 GPS 경로합 사이에 위치했다.

합성 픽스처는 아티팩트 0건으로 거리가 원본과 완전히 같다. 깨끗한 데이터를 건드리지 않는지 확인하는 회귀 가드로 쓴다.

## 멱등성

`sha256` UNIQUE 가 기준이다. 같은 파일을 다시 넣으면 조용히 건너뛴다. 파일 하나의 적재 전체가 한 트랜잭션이라 중간에 실패해도 반쪽 데이터가 남지 않는다.

CRC 실패는 적재를 막지 않는다. 실제 기기 파일 중 CRC가 어긋나도 내용은 멀쩡한 경우가 있어서, `integrity_ok` 에 기록만 하고 넣는다. 걸러내려면 질의에서 배제하면 된다.

## 저장 비용

30분 1Hz 러닝(record 1,800개) 기준 record JSON이 평균 273바이트, 원본 `.fit` 48KB → `.db` 680KB. 대략 14배다. 키 문자열이 row마다 반복되는 값이고, 연 300개 활동이면 200MB 안쪽이라 로컬 분석용으로는 문제되지 않는다. 이 비율이 부담스러워지는 시점이면 이미 어떤 필드를 승격할지 알고 있을 것이다.

## 예시 질의

`sql/views.sql` 적용 후, 전/후반 평균 속도 차이:

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

## 테스트 픽스처

`.fit` 없이 확인하려면 SDK의 `Encoder` 로 합성 파일을 만든다. `make-fixture.ts` 가 후반 15% 감속이 들어간 30분 러닝을 생성한다.

```bash
bun make-fixture.ts && bun src/cli.ts test.db fixture.fit
```

## tsconfig 주의

SDK의 `.d.ts` 가 확장자 없는 상대 import(`export * from './types/decoder'`)를 쓴다. `moduleResolution: "nodenext"` 는 이걸 해석하지 못해 `Decoder`, `Profile` 등이 전부 미해결로 뜬다. `"bundler"` 로 두면 된다 — 런타임은 Bun 의 트랜스파일러가 처리하므로 영향이 없다.

## bun:sqlite 주의

`better-sqlite3` 에서 옮겨올 때 걸리는 곳이 둘 있다.

`.pragma()` 헬퍼가 없다. `db.exec('PRAGMA journal_mode = WAL')` 로 직접 건다. `synchronous` 는 연결별 설정이라 `sqlite3` CLI 로 확인하면 CLI 자신의 기본값이 보인다 — 검증하려면 같은 연결 안에서 읽어야 한다. `journal_mode` 만 파일 헤더에 남는다.

`prepare` 의 제네릭 순서가 반대다. better-sqlite3 는 `<Params, Result>`, bun 은 `<Result, Params>` 다.

```ts
// better-sqlite3
db.prepare<[string], { id: number }>('SELECT id FROM fit_file WHERE sha256 = ?')
// bun:sqlite
db.prepare<{ id: number }, [string]>('SELECT id FROM fit_file WHERE sha256 = ?')
```

`transaction()` 과 `run()` 의 `{ changes, lastInsertRowid }` 는 동일하게 동작하므로 `src/ingest.ts` 는 손대지 않아도 된다.

## 범위에 대한 미결

`sql/correct.sql` 은 이 저장소의 책임 경계에 걸쳐 있다. 적재가 아니라 해석이기 때문이다. 지금은 선택 단계이자 별도 파일로 두고 원본을 건드리지 않는 형태로 분리해 두었지만, 경계를 어디에 그을지는 정하지 않았다.

미뤄둔 것들:

- `cli.ts` 에 `--correct` 플래그를 두어 적재와 동시에 보정하는 안. 편하지만 적재와 해석을 한 명령에 묶게 되므로 보류한다.
- 다리별 아티팩트 발생률(A 21~41%, B 0~16%)이 시간대나 날씨와 상관있는지. 파일이 더 쌓여야 볼 수 있고, 이건 명백히 `.db` 를 입력으로 받는 쪽의 일이다.

판단이 서기 전까지 `correct.sql` 은 수동 단계로 남긴다. 돌리지 않으면 `record_geo` 가 없을 뿐 나머지는 그대로 동작한다.
