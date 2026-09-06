-- 인원 요금 구조. 매출을 값 하나가 아니라 [하한, 상한] 구간으로 내기 위한 것.
--
-- 스페이스클라우드 요금은 이렇게 짜여 있다.
--   요금 = 기본가(기준인원 person_ceiling 까지) + 초과인원 × extra_person_price
--   charging_per_person = 'Y' 인 상품은 기본가 자체가 1인당 단가다.
--
-- 실측 규모 (2026-08-26, 시간제 예약타입 16,419개):
--   인원 추가금이 붙는 상품        12,508개 (76%)
--   기준인원 중앙값                 5명
--   최대인원 중앙값                12명
--   추가금 중앙값               5,000원/인
--   기본가 중앙값              20,000원
--   만석 시 기본가 대비 배수    p50 2.54배 · p75 4.33배 · p90 7.86배
--
-- 우리가 API 에서 관측하는 price 는 기본가다. 예약 인원은 어디에도
-- 노출되지 않아 관측할 수 없다. 그래서:
--   하한 = 관측한 그대로 (기준인원 이하로 예약한 건은 오차 0)
--   상한 = 기본가 + (최대인원 - 기준인원) × 추가금   ← 전부 실측 필드
-- 평균 인원을 가정하지 않는다. 정원은 수용 한계지 통상 이용 인원이 아니고,
-- 인원 분포에 대한 근거가 하나도 없기 때문이다.

-- 예약타입 단위 요금 구조. booking_day 가 rsv_type_id 로 키를 잡으므로 같은 단위로 둔다.
create table if not exists rsv_type_snapshot (
  space_id            bigint not null,
  product_id          bigint not null,
  rsv_type_id         bigint not null,
  snapshot_date       date   not null,
  rsv_tp_cd           text,
  price               int,
  charging_per_person text,   -- 'Y' 면 price 가 1인당 단가
  person_ceiling      int,    -- 기준 인원. 여기까지는 기본가
  extra_person_price  int,    -- 초과 1인당 추가금
  extra_per_hour      text,   -- 'Y' 면 추가금이 시간당, 'N' 이면 예약 건당
  primary key (space_id, product_id, rsv_type_id, snapshot_date)
);
create index if not exists rts_snap_idx on rsv_type_snapshot (snapshot_date);

alter table product_snapshot add column if not exists min_guest_policy int;

-- 매출 상한. 하한은 기존 rev_month_short / rev_month_all 이 그대로다.
alter table space_revenue add column if not exists rev_month_short_ceil numeric(14,0);
alter table space_revenue add column if not exists rev_month_all_ceil   numeric(14,0);
alter table space_revenue add column if not exists n_rsv_blocks         int;

comment on column space_revenue.rev_month_short_ceil is '만석 가정 상한 (D+1~3 기준). 하한은 rev_month_short';
comment on column space_revenue.rev_month_all_ceil   is '만석 가정 상한 (관측 창 전체). 하한은 rev_month_all';
comment on column space_revenue.n_rsv_blocks         is '연속된 예약 시간 덩어리 수. 건당 추가금을 몇 번 붙일지의 근거';
