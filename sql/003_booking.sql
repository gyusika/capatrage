-- 실제 예약 현황. 추정·환산 없이 관측값만 넣는다.
-- 한 행 = (공간, 상품, 예약타입, 관측일, 대상일)
-- booked_hours 는 실제로 예약이 잡힌 시각들이다.

create table if not exists booking_day (
  space_id      bigint   not null,
  product_id    bigint   not null,
  rsv_type_id   bigint   not null,
  observed_date date     not null,          -- 언제 관측했는가
  target_date   date     not null,          -- 어느 날짜의 예약 현황인가
  wday          text,
  is_holiday    boolean,
  n_slots       int      not null,          -- 응답에 실린 시간 슬롯 수 (보통 24)
  booked_hours  smallint[] not null default '{}',
  n_booked      int      not null,
  price         int,
  primary key (space_id, product_id, rsv_type_id, observed_date, target_date)
);
create index if not exists bk_target_idx on booking_day (target_date);
create index if not exists bk_space_idx  on booking_day (space_id, target_date);
create index if not exists bk_obs_idx    on booking_day (observed_date);

-- 휴무 정보. "예약 불가"가 실제 예약인지 휴무인지 가르는 데 쓴다.
create table if not exists space_hours (
  space_id       bigint primary key,
  observed_date  date not null,
  break_times    jsonb,      -- [{start_time, end_time}] 영업하지 않는 시간대
  break_days     jsonb,      -- 정기 휴무 요일
  break_holidays jsonb
);

-- ── 공간 단위 예약률 ──────────────────────────────────────────────
-- 관측 시점 기준 '미래' 날짜만 쓴다. 과거는 응답에 슬롯이 없거나 의미가 다르다.
create or replace view v_booking_space as
select
  b.space_id,
  b.observed_date,
  count(*)                                   as n_daysproducts,
  count(distinct b.target_date)              as n_days,
  count(distinct b.product_id)               as n_products,
  sum(b.n_booked)                            as booked_hours_total,
  sum(b.n_slots)                             as slot_hours_total,
  round(sum(b.n_booked)::numeric / nullif(sum(b.n_slots), 0), 4) as fill_rate_raw,
  -- 향후 14일만 따로 (예약은 가까운 날짜부터 찬다)
  sum(b.n_booked) filter (where b.target_date <= b.observed_date + 14)  as booked_14d,
  sum(b.n_slots)  filter (where b.target_date <= b.observed_date + 14)  as slots_14d,
  round(
    sum(b.n_booked) filter (where b.target_date <= b.observed_date + 14)::numeric
    / nullif(sum(b.n_slots) filter (where b.target_date <= b.observed_date + 14), 0), 4
  ) as fill_rate_14d
from booking_day b
where b.target_date >= b.observed_date
group by b.space_id, b.observed_date;

-- ── 시장(동×업종) 단위 예약률 ─────────────────────────────────────
-- 중앙값을 쓴다. 한두 곳이 몰아서 잘되는 걸 평균이 가려버리기 때문이다.
create or replace view v_booking_market as
select
  s.category, s.sido, s.sigungu, s.eupmyeondong, s.dong_code,
  v.observed_date,
  count(*)                                                          as n_spaces,
  count(*) filter (where v.booked_hours_total > 0)                  as n_with_booking,
  round(percentile_cont(0.5) within group (order by v.fill_rate_14d)::numeric, 4) as median_fill_14d,
  round(percentile_cont(0.25) within group (order by v.fill_rate_14d)::numeric, 4) as p25_fill_14d,
  round(percentile_cont(0.75) within group (order by v.fill_rate_14d)::numeric, 4) as p75_fill_14d,
  round(percentile_cont(0.5) within group (order by v.fill_rate_raw)::numeric, 4)  as median_fill_all,
  round(percentile_cont(0.5) within group (order by ss.median_price)::numeric, 0)  as median_price,
  round(percentile_cont(0.5) within group (order by ss.total_pyeong)::numeric, 1)  as median_pyeong
from v_booking_space v
join space s on s.space_id = v.space_id
left join space_snapshot ss
  on ss.space_id = v.space_id and ss.snapshot_date = v.observed_date
where s.category <> '기타'
group by s.category, s.sido, s.sigungu, s.eupmyeondong, s.dong_code, v.observed_date;

-- ── 요일×시간 히트맵 ──────────────────────────────────────────────
-- booked_hours 배열을 펼쳐서 언제 차는지 본다.
create or replace view v_booking_heatmap as
select
  s.category, s.sigungu, s.dong_code, b.observed_date,
  b.wday,
  h.hour,
  count(*)                                        as n_observations,
  sum(case when h.hour = any(b.booked_hours) then 1 else 0 end) as n_booked,
  round(
    sum(case when h.hour = any(b.booked_hours) then 1 else 0 end)::numeric
    / nullif(count(*), 0), 4
  ) as fill_rate
from booking_day b
join space s on s.space_id = b.space_id
cross join generate_series(0, 23) as h(hour)
where b.target_date >= b.observed_date
  and s.category <> '기타'
group by s.category, s.sigungu, s.dong_code, b.observed_date, b.wday, h.hour;
