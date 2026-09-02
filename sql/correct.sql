-- GPS 재락 아티팩트 보정.
--
-- 원본은 message 에 손대지 않고 파생값만 record_geo 에 쌓는다. 판정 기준이
-- 바뀌면 이 파일만 다시 실행하면 되고, 재적재는 필요 없다.
--
-- 배경: 코스에 상공이 가리는 지점(교량 하부 등)이 있으면 GPS 가 끊겼다가
-- 복귀하면서 기기 오도미터가 20~30m 를 한 번에 더한다. 그 순간 속도와
-- 케이던스는 전혀 변하지 않으므로 실제로 뛴 거리가 아니다.
--
-- 판정: 오도미터 증분이 GPS 이동거리의 2배를 넘고, 초과분이 5m 이상.
-- 둘 중 하나라도 없으면(GPS 결측, 첫 레코드) 판정하지 않고 오도미터를 쓴다.
--
-- 선행: sql/views.sql (trackpoint, activity 뷰에 의존)

DROP VIEW  IF EXISTS activity_fix;
DROP VIEW  IF EXISTS trackpoint_fix;
DROP TABLE IF EXISTS record_geo;

CREATE TABLE record_geo (
  file_id     INTEGER NOT NULL REFERENCES fit_file(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  gps_m       REAL,              -- 직전 record 좌표로부터의 하버사인 이동거리
  odo_m       REAL,              -- 기기 오도미터 증분
  is_artifact INTEGER NOT NULL,  -- 1 = GPS 재락 점프로 판정
  step_m      REAL NOT NULL,     -- 채택한 증분 (아티팩트면 gps_m, 아니면 odo_m)
  dist_fix    REAL NOT NULL,     -- 보정 누적거리
  PRIMARY KEY (file_id, seq)
) WITHOUT ROWID;

INSERT INTO record_geo (file_id, seq, gps_m, odo_m, is_artifact, step_m, dist_fix)
WITH r AS (
  SELECT file_id, seq,
         json_extract(data, '$.lat')      AS lat,
         json_extract(data, '$.lon')      AS lon,
         json_extract(data, '$.distance') AS dist
  FROM message WHERE kind = 'record'
),
d AS (
  SELECT file_id, seq, lat, lon, dist,
         lag(lat)  OVER w AS plat,
         lag(lon)  OVER w AS plon,
         dist - lag(dist) OVER w AS odo_m
  FROM r WINDOW w AS (PARTITION BY file_id ORDER BY seq)
),
g AS (
  SELECT file_id, seq, dist, odo_m,
         2 * 6371000 * asin(sqrt(
           power(sin(radians(lat - plat) / 2), 2)
           + cos(radians(plat)) * cos(radians(lat))
             * power(sin(radians(lon - plon) / 2), 2)
         )) AS gps_m
  FROM d
),
f AS (
  SELECT file_id, seq, gps_m, odo_m,
         CASE WHEN gps_m IS NOT NULL AND odo_m IS NOT NULL
                   AND odo_m > 2.0 * gps_m
                   AND odo_m - gps_m > 5.0
              THEN 1 ELSE 0 END AS is_artifact,
         -- 첫 레코드는 증분이 없으므로 오도미터 시작값을 그대로 쓴다.
         CASE WHEN odo_m IS NULL THEN ifnull(dist, 0.0) END AS seed
  FROM g
),
s AS (
  SELECT *, CASE WHEN seed IS NOT NULL THEN seed
                 WHEN is_artifact = 1  THEN gps_m
                 ELSE odo_m END AS step_m
  FROM f
)
SELECT file_id, seq, gps_m, odo_m, is_artifact, step_m,
       sum(step_m) OVER (PARTITION BY file_id ORDER BY seq)
FROM s;

-- 원본 trackpoint 에 보정 컬럼을 덧붙인다. distance 는 기기 값 그대로,
-- dist_fix 가 보정값이다. 둘 다 남겨서 질의 쪽에서 고를 수 있게 한다.
CREATE VIEW trackpoint_fix AS
SELECT t.*, g.gps_m, g.odo_m, g.step_m, g.is_artifact, g.dist_fix
FROM trackpoint t
JOIN record_geo g ON g.file_id = t.file_id AND g.seq = t.seq;

CREATE VIEW activity_fix AS
SELECT a.file_id, a.seq, a.sport, a.start_ts, a.timer_s,
       a.distance_m                        AS distance_raw,
       r.dist_fix                          AS distance_fix,
       r.artifacts,
       round(a.distance_m - r.dist_fix, 1) AS inflated_m,
       a.timer_s / (a.distance_m / 1000.0) AS pace_raw_s,
       a.timer_s / (r.dist_fix  / 1000.0)  AS pace_fix_s
FROM activity a
JOIN (SELECT file_id, max(dist_fix) AS dist_fix, sum(is_artifact) AS artifacts
      FROM record_geo GROUP BY file_id) r ON r.file_id = a.file_id;
