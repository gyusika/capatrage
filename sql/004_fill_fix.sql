-- 예약률 계산 수정.
--
-- 문제: API 의 available=false 는 "예약됨"과 "영업시간 밖"을 구분하지 않는다.
--       break_times 가 24시~9시인 공간은 0~8시가 매일 false 로 나온다.
--       이걸 예약으로 세면 예약률이 통째로 부풀려진다 (실측: 5.18h 중 4.60h 가 휴무였다).
--
-- 해법: break_times 를 해석하는 대신 데이터에서 직접 판정한다.
--       관측된 모든 미래 날짜(14일 이상)에서 한 번도 열린 적 없는 시각 = 영업시간 밖.
--       가끔 막히는 시각 = 실제 예약.
--       35일 넘게 매일 같은 시각이 예약되는 경우는 사실상 없으므로 안전한 판정이다.
--
-- 뷰로 두면 페이지를 열 때마다 24배 cross join 이 돌아 느리다. 적재 때 한 번 계산해 테이블에 넣는다.

drop view if exists v_booking_market;
drop view if exists v_booking_space;
drop view if exists v_booking_heatmap;

-- 시각별 판정 결과
create table if not exists booking_hour_class (
  space_id      bigint not null,
  product_id    bigint not null,
  rsv_type_id   bigint not null,
  observed_date date   not null,
  hour          smallint not null,
  n_days        int    not null,
  n_blocked     int    not null,
  is_closed     boolean not null,   -- 영업시간 밖
  primary key (space_id, product_id, rsv_type_id, observed_date, hour)
);

-- 공간 단위 집계 (영업시간만 분모로)
create table if not exists booking_space_fill (
  space_id        bigint not null,
  observed_date   date   not null,
  n_products      int    not null,
  n_days          int    not null,
  open_hours_day  numeric(5,2),     -- 하루 평균 영업시간
  closed_hours    int,              -- 영업시간 밖으로 판정된 시각 수 (상품 합계)
  open_slot_hours int    not null,  -- 분모: 영업시간 × 일수
  booked_hours    int    not null,  -- 분자: 실제 예약
  fill_rate       numeric(6,4),
  open_14d        int,
  booked_14d      int,
  fill_rate_14d   numeric(6,4),
  primary key (space_id, observed_date)
);
create index if not exists bsf_obs_idx on booking_space_fill (observed_date);

-- 요일×시간 히트맵도 영업시간만 센다
create table if not exists booking_heat (
  category      text   not null,
  sigungu       text,
  observed_date date   not null,
  wday          text   not null,
  hour          smallint not null,
  n_open        int    not null,    -- 영업 중인 (공간,상품,날짜) 수
  n_booked      int    not null,
  fill_rate     numeric(6,4),
  primary key (category, sigungu, observed_date, wday, hour)
);

-- ── 시장 단위 뷰 ─────────────────────────────────────────────────
create or replace view v_booking_market as
select
  s.category, s.sido, s.sigungu, s.eupmyeondong, s.dong_code, f.observed_date,
  count(*)                                          as n_spaces,
  count(*) filter (where f.booked_hours > 0)        as n_with_booking,
  round(percentile_cont(0.5)  within group (order by f.fill_rate_14d)::numeric, 4) as median_fill_14d,
  round(percentile_cont(0.25) within group (order by f.fill_rate_14d)::numeric, 4) as p25_fill_14d,
  round(percentile_cont(0.75) within group (order by f.fill_rate_14d)::numeric, 4) as p75_fill_14d,
  round(percentile_cont(0.5)  within group (order by f.fill_rate)::numeric, 4)     as median_fill_all,
  round(percentile_cont(0.5)  within group (order by f.open_hours_day)::numeric, 1) as median_open_hours,
  round(percentile_cont(0.5)  within group (order by ss.median_price)::numeric, 0)  as median_price,
  round(percentile_cont(0.5)  within group (order by ss.total_pyeong)::numeric, 1)  as median_pyeong
from booking_space_fill f
join space s on s.space_id = f.space_id
left join space_snapshot ss
  on ss.space_id = f.space_id and ss.snapshot_date = f.observed_date
where s.category <> '기타'
group by s.category, s.sido, s.sigungu, s.eupmyeondong, s.dong_code, f.observed_date;
