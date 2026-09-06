-- 캘린더 차단 판별.
--
-- 문제: 예약을 안 받으려고 캘린더를 통째로 막아둔 공간이 "예약률 90%"로 잡힌다.
--       실측하니 예약률 30% 이상 상위 15곳 중 14곳이 차단이었다. 순위표 상단이 오염된다.
--
-- 판별: 실제 예약은 날짜마다 시각 조합이 다르다. 차단은 매일 똑같다.
--       mode_share = 가장 흔한 "예약된 시각 집합"이 예약 있는 날 중 차지하는 비율.
--       1.0 이면 매일 완전히 동일 = 차단. 0.8 이상을 의심으로 본다.
--
-- 차단 의심은 지우지 않고 표시만 한다 (판단은 사람이). 다만 시장 중앙값·히트맵·리드타임에서는 뺀다.

alter table booking_space_fill add column if not exists days_with_booking int;
alter table booking_space_fill add column if not exists n_pattern         int;
alter table booking_space_fill add column if not exists mode_share        numeric(5,3);
alter table booking_space_fill add column if not exists is_blocked_suspect boolean not null default false;

create index if not exists bsf_suspect_idx on booking_space_fill (observed_date, is_blocked_suspect);

drop view if exists v_booking_market;

create view v_booking_market as
select
  s.category, s.sido, s.sigungu, s.eupmyeondong, s.dong_code, f.observed_date,
  count(*)                                                as n_spaces,
  count(*) filter (where f.booked_hours > 0)              as n_with_booking,
  count(*) filter (where f.is_blocked_suspect)            as n_blocked_suspect,
  -- 중앙값은 차단 의심을 뺀 모집단에서 계산한다
  count(*) filter (where not f.is_blocked_suspect)        as n_clean,
  round(percentile_cont(0.5) within group (
    order by case when not f.is_blocked_suspect then f.fill_rate end)::numeric, 4) as median_fill_all,
  round(percentile_cont(0.25) within group (
    order by case when not f.is_blocked_suspect then f.fill_rate end)::numeric, 4) as p25_fill_all,
  round(percentile_cont(0.75) within group (
    order by case when not f.is_blocked_suspect then f.fill_rate end)::numeric, 4) as p75_fill_all,
  round(percentile_cont(0.5) within group (
    order by case when not f.is_blocked_suspect then f.fill_rate_14d end)::numeric, 4) as median_fill_14d,
  round(percentile_cont(0.25) within group (
    order by case when not f.is_blocked_suspect then f.fill_rate_14d end)::numeric, 4) as p25_fill_14d,
  round(percentile_cont(0.75) within group (
    order by case when not f.is_blocked_suspect then f.fill_rate_14d end)::numeric, 4) as p75_fill_14d,
  -- 예약이 실제로 있는 곳의 비율 (차단 제외)
  round(
    count(*) filter (where not f.is_blocked_suspect and f.booked_hours > 0)::numeric
    / nullif(count(*) filter (where not f.is_blocked_suspect), 0), 3) as share_with_booking,
  round(percentile_cont(0.5) within group (order by f.open_hours_day)::numeric, 1) as median_open_hours,
  round(percentile_cont(0.5) within group (order by ss.median_price)::numeric, 0)  as median_price,
  round(percentile_cont(0.5) within group (order by ss.total_pyeong)::numeric, 1)  as median_pyeong
from booking_space_fill f
join space s on s.space_id = f.space_id
left join space_snapshot ss
  on ss.space_id = f.space_id and ss.snapshot_date = f.observed_date
where s.category <> '기타'
group by s.category, s.sido, s.sigungu, s.eupmyeondong, s.dong_code, f.observed_date;
