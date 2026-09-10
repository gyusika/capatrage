-- ── 수집 현황 화면이 booking_day 를 통째로 훑던 것을 인덱스로 덮는다 ──────
--
-- /status 가 배포본에서 500 이 났다. 원인은 이 두 쿼리다.
--
--   getRunDays      관측일별 행수·공간수·달력 끝     로컬 5,786ms
--   getDayCoverage  지난 날짜별 마지막 관측·관측횟수  로컬 2,143ms
--
-- 계획을 떠보면 bk_obs_idx 로 들어가지만 space_id 와 target_date 가 인덱스에
-- 없어서 힙을 다 읽는다 — shared read 86,663 블록(677MB), 거기에
-- count(distinct space_id) 때문에 external merge sort 가 16MB 를 디스크로 흘린다.
-- 결과는 6행이다. 6행 내려고 970MB 를 읽고 있었다.
--
-- 그동안 세션 모드 풀러의 15 연결 중 하나를 잡고 있다. 한 요청이 9초, 여섯이
-- 겹치면 21초다. 수집이 도는 시간대와 겹치면 화면이 연결을 못 잡고 통째로 죽는다.
--
-- 두 쿼리가 읽는 컬럼은 셋뿐이다. 인덱스에 다 넣으면 index-only scan 이 되고,
-- 정렬 순서도 그룹 키와 같아서 sort 자체가 사라진다.
--
--   getRunDays      group by observed_date, count(distinct space_id), max(target_date)
--   getDayCoverage  group by target_date, min(target_date-observed_date), count(distinct ...)
--
-- 기존 bk_obs_idx(observed_date) 와 bk_target_idx(target_date) 는 새 인덱스의
-- 접두사라 하는 일이 없어진다. 그래서 지운다 — 합쳐서 40MB 이고, 매 적재마다
-- 갱신 비용을 물던 것들이다.
--
-- concurrently 를 안 쓴다. apply_sql.js 가 파일 하나를 한 번에 보내서 암묵적
-- 트랜잭션이 되기 때문이다. booking_day 에 쓰기 잠금이 1분 안팎 걸리므로
-- 수집(04:00 KST)과 겹치지 않을 때 돌린다.

create index if not exists bk_obs_cover    on booking_day (observed_date, space_id, target_date);
create index if not exists bk_target_cover on booking_day (target_date, observed_date, space_id);

drop index if exists bk_obs_idx;
drop index if exists bk_target_idx;
