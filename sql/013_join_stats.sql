-- ── 플래너에게 컬럼 상관관계를 알려준다 ──────────────────────────
--
-- 매출 집계 한 관측일이 5시간 24분 걸렸다. 계획을 떠보니 원인이 추정 오류였다.
--
--   Nested Loop Left Join (rows=1)
--     -> Merge Join (rows=1)        ← booking_day × booking_hour_class, 실제 수백만 행
--     -> CTE Scan on guest (rows=24201)
--
-- (space_id, product_id, rsv_type_id) 는 사실상 한 덩어리다 — 상품은 공간에
-- 종속되고 예약타입은 상품에 종속된다. 그런데 플래너는 세 컬럼을 독립으로 보고
-- 선택도를 곱해서 조인 결과를 1행으로 추정한다. 1행이라고 믿으니 24,201행짜리
-- guest 를 매 행마다 다시 훑는 Nested Loop 을 고르고, 그게 다섯 시간이 된다.
--
-- 확장 통계는 이 종속성을 실제로 재서 저장한다. 계획이 해시 조인으로 바뀐다.
create statistics if not exists bd_key_stats (dependencies, ndistinct)
  on space_id, product_id, rsv_type_id from booking_day;

create statistics if not exists bhc_key_stats (dependencies, ndistinct)
  on space_id, product_id, rsv_type_id from booking_hour_class;

create statistics if not exists bpk_key_stats (dependencies, ndistinct)
  on space_id, product_id, rsv_type_id from booking_package;

create statistics if not exists rts_key_stats (dependencies, ndistinct)
  on space_id, product_id, rsv_type_id from rsv_type_snapshot;

analyze booking_day;
analyze booking_hour_class;
analyze booking_package;
analyze rsv_type_snapshot;
