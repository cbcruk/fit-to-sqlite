-- 적재 스키마는 느슨하게 두고, 안정된 질의 패턴만 뷰로 굳힌다.
-- 뷰는 언제든 DROP/재정의 가능하고 재적재가 필요 없다.

CREATE VIEW IF NOT EXISTS activity AS
SELECT
  m.file_id,
  m.seq,
  json_extract(m.data, '$.sport')            AS sport,
  json_extract(m.data, '$.subSport')         AS sub_sport,
  unixepoch(json_extract(m.data, '$.startTime')) AS start_ts,
  json_extract(m.data, '$.totalTimerTime')   AS timer_s,
  json_extract(m.data, '$.totalElapsedTime') AS elapsed_s,
  json_extract(m.data, '$.totalDistance')    AS distance_m,
  json_extract(m.data, '$.avgSpeed')         AS avg_speed,
  json_extract(m.data, '$.avgHeartRate')     AS avg_hr,
  json_extract(m.data, '$.maxHeartRate')     AS max_hr,
  json_extract(m.data, '$.totalAscent')      AS ascent_m,
  json_extract(m.data, '$.totalDescent')     AS descent_m
FROM message m
WHERE m.kind = 'session';

CREATE VIEW IF NOT EXISTS trackpoint AS
SELECT
  m.file_id,
  m.seq,
  m.ts,
  json_extract(m.data, '$.lat')        AS lat,
  json_extract(m.data, '$.lon')        AS lon,
  json_extract(m.data, '$.altitude')   AS altitude,
  json_extract(m.data, '$.distance')   AS distance,
  json_extract(m.data, '$.speed')      AS speed,
  json_extract(m.data, '$.heartRate')  AS hr,
  json_extract(m.data, '$.cadence')    AS cadence,
  json_extract(m.data, '$.power')      AS power
FROM message m
WHERE m.kind = 'record';

-- lap 은 FIT 규약상 자기 session 앞에 온다. seq 로 그 관계를 복원한다.
CREATE VIEW IF NOT EXISTS lap AS
SELECT
  l.file_id,
  l.seq,
  (SELECT min(s.seq) FROM message s
    WHERE s.file_id = l.file_id AND s.kind = 'session' AND s.seq > l.seq) AS session_seq,
  json_extract(l.data, '$.messageIndex')     AS lap_index,
  unixepoch(json_extract(l.data, '$.startTime')) AS start_ts,
  json_extract(l.data, '$.totalTimerTime')   AS timer_s,
  json_extract(l.data, '$.totalDistance')    AS distance_m,
  json_extract(l.data, '$.avgHeartRate')     AS avg_hr
FROM message l
WHERE l.kind = 'lap';
