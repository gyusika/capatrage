-- 매출 추산.
--
-- 매출 = 예약된 시간 × 그 시간의 가격. 둘 다 실측값이라 곱하면 나온다.
-- 시간별 가격이 다른 공간이 표본 12개 중 5개였고 최대 5배 차이였다. 그래서 시간별로 저장한다.
--
-- 문제: 향후 예약은 아직 덜 찼다. 3주 뒤 예약률 1%는 "인기 없다"가 아니라 "아직 예약 시기가 아니다".
--       리드타임 곡선이 D+1 5.0% → D+21 0.8% 로 떨어지는 게 그 증거다.
--
-- 그래서 두 가지를 따로 낸다.
--   1) rev_short  — D+1~3 기준. 내일·모레 예약은 사실상 확정이라 운영 상황에 가깝다.
--                   지금 당장 나오지만 근사치다.
--   2) rev_settled — 같은 날짜를 여러 날 반복 관측해 "그 날이 오기까지 최종 얼마나 찼는지"를 실측.
--                   정확하지만 스냅샷이 며칠 쌓여야 채워진다.

alter table booking_day add column if not exists hour_prices int[];

-- 공간별 매출 추산
create table if not exists space_revenue (
  space_id        bigint not null,
  observed_date   date   not null,
  -- D+1~3 실측 (지금 바로 나오는 값)
  short_days      int,
  short_open_h    int,
  short_booked_h  int,
  short_fill      numeric(6,4),
  short_rev_day   numeric(12,1),   -- 하루 평균 예약 매출
  rev_month_short numeric(14,0),   -- × 30.4
  -- 관측 창 전체 (확실히 과소추정, 하한선으로 쓴다)
  all_days        int,
  all_booked_h    int,
  all_fill        numeric(6,4),
  rev_month_all   numeric(14,0),
  -- 잠재 매출: 영업시간이 100% 찼을 때
  rev_month_max   numeric(14,0),
  adr             numeric(10,1),   -- 예약된 시간의 평균 단가
  primary key (space_id, observed_date)
);
create index if not exists sr_obs_idx on space_revenue (observed_date);

-- 시장(동×업종) 단위 매출 분포 — AirDNA 식으로 중앙값과 상위 10%를 같이 본다
create or replace view v_market_revenue as
select
  s.category, s.sido, s.sigungu, s.eupmyeondong, s.dong_code, r.observed_date,
  count(*)                                                     as n_spaces,
  count(*) filter (where f.is_blocked_suspect)                 as n_blocked,
  count(*) filter (where not f.is_blocked_suspect)             as n_clean,
  count(*) filter (where not f.is_blocked_suspect and r.short_booked_h > 0) as n_active,
  round(percentile_cont(0.5) within group (
    order by case when not f.is_blocked_suspect then r.rev_month_short end)::numeric, 0) as rev_median,
  round(percentile_cont(0.9) within group (
    order by case when not f.is_blocked_suspect then r.rev_month_short end)::numeric, 0) as rev_p90,
  round(percentile_cont(0.25) within group (
    order by case when not f.is_blocked_suspect then r.rev_month_short end)::numeric, 0) as rev_p25,
  round(percentile_cont(0.5) within group (
    order by case when not f.is_blocked_suspect then r.short_fill end)::numeric, 4)      as fill_median,
  round(percentile_cont(0.5) within group (
    order by case when not f.is_blocked_suspect then r.adr end)::numeric, 0)             as adr_median,
  round(percentile_cont(0.5) within group (
    order by case when not f.is_blocked_suspect then r.rev_month_max end)::numeric, 0)   as rev_max_median,
  round(percentile_cont(0.5) within group (order by ss.total_pyeong)::numeric, 1)        as pyeong_median,
  round(percentile_cont(0.5) within group (order by ss.median_price)::numeric, 0)        as price_median,
  -- 평당 월매출: 필요 면적을 역산하는 데 쓴다
  round(percentile_cont(0.5) within group (
    order by case when not f.is_blocked_suspect and ss.total_pyeong > 0
                  then r.rev_month_short / ss.total_pyeong end)::numeric, 0)             as rev_per_pyeong
from space_revenue r
join booking_space_fill f on f.space_id = r.space_id and f.observed_date = r.observed_date
join space s on s.space_id = r.space_id
left join space_snapshot ss on ss.space_id = r.space_id and ss.snapshot_date = r.observed_date
where s.category <> '기타'
group by s.category, s.sido, s.sigungu, s.eupmyeondong, s.dong_code, r.observed_date;
