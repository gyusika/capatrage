-- 패키지(PKG) 예약타입 관측.
--
-- 왜 필요한가: 같은 상품이 시간제(TIME)와 패키지(PKG) 두 가지로 팔린다.
-- 서울에서 TIME 예약타입 10,373개 중 4,961개 상품에 PKG 가 같이 붙어 있다.
-- 그리고 패키지가 싸다. 표본 10곳에서 같은 구간을 시간제로 살 때의 합계 대비
-- 56~92% (중앙값 약 73%) 였다. 예: 종일 9-18 이 시간제 합계 1,386,000 인데 패키지가 770,000.
--
-- 그래서 예약된 시간을 전부 시간제 단가로 곱하면 매출이 과대계상된다.
-- 인원 미상 때와 같은 방식으로 구간을 낸다 —
--   하한: 그 시간 덩어리가 패키지로 팔렸다고 보고 패키지가
--   상한: 시간제로 팔렸다고 보고 시간별 단가 합계
-- 둘 다 실측 가격이고 새 가정은 들어가지 않는다.
--
-- 못 하는 것: 패키지의 available=false 는 "팔렸다"가 아니다. 그 구간이 통째로 비어야
-- 패키지가 열리는 구조라, 6시간 중 1시간만 시간제로 팔려도 패키지는 닫힌다.
-- (공간 79796 에서 확인: 패키지 13-18 이 막힌 날 그 구간 시간제 예약은 5시간 중 2시간)
-- 그래서 판매 신호로는 쓰지 않고, 가격표로만 쓴다.

create table if not exists booking_package (
  space_id      bigint not null,
  product_id    bigint not null,
  rsv_type_id   bigint not null,   -- PKG 예약타입. 같은 상품의 TIME 타입과 다른 id 다.
  package_id    bigint not null,
  observed_date date   not null,
  target_date   date   not null,
  name          text,
  shour         int    not null,   -- 시작 시각 (포함)
  ehour         int    not null,   -- 끝 시각 (제외). shour > ehour 면 자정을 넘는 창이다.
  price         int,
  available     boolean,           -- 그 구간이 통째로 비어 있는가. 판매 여부가 아니다.
  primary key (space_id, product_id, rsv_type_id, package_id, observed_date, target_date)
);
create index if not exists bp_obs_idx    on booking_package (observed_date);
create index if not exists bp_target_idx on booking_package (space_id, product_id, target_date);

-- 패키지 반영으로 하한에서 깎인 금액과 그 대상이 된 예약 덩어리 수.
-- 얼마나 큰 보정인지 그대로 드러내려고 따로 적는다.
alter table space_revenue add column if not exists n_pkg_blocks int;
alter table space_revenue add column if not exists pkg_cut_short numeric(14,0);
alter table space_revenue add column if not exists pkg_cut_all   numeric(14,0);

comment on column space_revenue.n_pkg_blocks  is '패키지 창과 정확히 일치해 패키지가로 다시 잡은 예약 덩어리 수';
comment on column space_revenue.pkg_cut_short is '그 보정으로 rev_month_short 에서 깎인 월환산 금액';
comment on column space_revenue.pkg_cut_all   is '그 보정으로 rev_month_all 에서 깎인 월환산 금액';
