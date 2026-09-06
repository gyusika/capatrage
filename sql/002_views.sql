-- 과수요 판정 로직 v2
-- "여기에 새로운 공급을 하나 더 넣었을 때 시장이 바로 흡수하는가?"
-- 세 갈래로 쪼개서 각각 수치로 만들고 곱한다. 하나라도 0이면 탈락이어야 하므로.
--
-- v1 에서 고친 두 가지
--  1) 방치된 매물이 중앙값을 0으로 끌어내린다
--     -> 기존업체 기준선은 '최근 90일 내 리뷰가 있는 곳'만으로 계산한다.
--  2) 신규 흡수율에서 실패한 신규를 빼면 선택편향이 생긴다
--     -> 신규는 리뷰 0건짜리까지 전부 포함한다.
--        "여기 새로 열면 어떻게 되는가"의 답에는 망한 신규가 반드시 들어가야 한다.
--
-- 알려진 한계: 기존업체의 reviews_per_month 는 생애 평균이라 초기 램프업 구간과
-- 플랫폼이 작던 시절이 섞여 과소평가된다. 그만큼 newcomer_absorption 이 낙관적으로 나온다.
-- 일별 스냅샷이 4주쯤 쌓이면 Δreview 로 모든 업체의 '현재' 속도를 쓸 수 있고 이 편향은 사라진다.

drop function if exists market_at(double precision, double precision, int, text);
drop view if exists v_overdemand_dong;
drop view if exists v_market_dong;
drop view if exists v_category_baseline;
drop view if exists v_demand_trend;
drop view if exists v_space_base;

create view v_space_base as
select
  s.space_id, s.name, s.category, s.sido, s.sigungu, s.eupmyeondong,
  s.sido_code, s.sigungu_code, s.dong_code,
  s.lat, s.lng, s.geom, s.vintage_month, s.host_id, s.is_gone,
  greatest(1, (date_part('year', age(current_date, s.vintage_month)) * 12
     + date_part('month', age(current_date, s.vintage_month)))::int) as months_open,
  ss.snapshot_date, ss.review_total, ss.review_avg_rate, ss.zzim_cnt,
  ss.median_price, ss.total_pyeong, ss.max_capacity, ss.latest_review_at,
  round(ss.review_total::numeric / greatest(1,
      (date_part('year', age(current_date, s.vintage_month)) * 12
       + date_part('month', age(current_date, s.vintage_month)))::int), 3) as reviews_per_month,
  coalesce(ss.latest_review_at > current_date - interval '90 days', false) as active_90d,
  (greatest(1, (date_part('year', age(current_date, s.vintage_month)) * 12
     + date_part('month', age(current_date, s.vintage_month)))::int) <= 18) as is_newcomer
from space s
join space_snapshot ss
  on ss.space_id = s.space_id
 and ss.snapshot_date = (select max(snapshot_date) from space_snapshot where space_id = s.space_id)
where s.is_gone = false and s.vintage_month is not null;

-- 지역 점수를 정규화할 전국 기준선
create view v_category_baseline as
select category,
  count(*) as n_spaces,
  count(*) filter (where active_90d)::numeric / nullif(count(*),0) as nat_operating_rate,
  percentile_cont(0.5) within group (
    order by case when active_90d and not is_newcomer then reviews_per_month end) as nat_median_rate,
  percentile_cont(0.5) within group (order by median_price) as nat_median_price
from v_space_base where category <> '기타' group by category;

-- 행정동(법정동코드) 단위 시장
create view v_market_dong as
with base as (
  select b.*, c.nat_median_rate, c.nat_operating_rate
  from v_space_base b join v_category_baseline c using (category)
  where b.category <> '기타' and b.dong_code is not null
), agg as (
  select
    category, sido, sigungu, eupmyeondong, sido_code, sigungu_code, dong_code,
    count(*)                                              as n_spaces,
    count(*) filter (where active_90d)                    as n_active,
    count(distinct host_id)                               as n_hosts,
    percentile_cont(0.5) within group (
      order by case when active_90d and not is_newcomer then reviews_per_month end) as median_rate,
    percentile_cont(0.25) within group (
      order by case when active_90d and not is_newcomer then reviews_per_month end) as p25_rate,
    percentile_cont(0.75) within group (
      order by case when active_90d and not is_newcomer then reviews_per_month end) as p75_rate,
    count(*) filter (where active_90d and not is_newcomer) as n_incumbent_active,
    count(*) filter (where is_newcomer)                    as n_newcomers,
    count(*) filter (where is_newcomer and review_total = 0) as n_newcomers_zero,
    percentile_cont(0.5) within group (
      order by case when is_newcomer then reviews_per_month end) as newcomer_median_rate,
    percentile_cont(0.5) within group (order by median_price) as median_price,
    percentile_cont(0.5) within group (order by total_pyeong) as median_pyeong,
    max(nat_median_rate)     as nat_median_rate,
    max(nat_operating_rate)  as nat_operating_rate
  from base
  group by category, sido, sigungu, eupmyeondong, sido_code, sigungu_code, dong_code
)
select *,
  round((n_active::numeric / nullif(n_spaces,0)), 3)                       as operating_rate,
  round((n_newcomers_zero::numeric / nullif(n_newcomers,0)), 3)            as newcomer_fail_rate,
  round((median_rate / nullif(nat_median_rate,0))::numeric, 3)             as demand_index,
  round(least(1.0, (p25_rate / nullif(median_rate,0)))::numeric, 3)        as homogeneity,
  round(least(1.5, (newcomer_median_rate / nullif(median_rate,0)))::numeric, 3) as newcomer_absorption
from agg;

create view v_overdemand_dong as
select
  category, sido, sigungu, eupmyeondong, dong_code,
  n_spaces, n_active, n_hosts, n_incumbent_active, n_newcomers, n_newcomers_zero,
  operating_rate, newcomer_fail_rate,
  median_rate, p25_rate, p75_rate, median_price, median_pyeong,
  demand_index, homogeneity, newcomer_absorption,
  round((demand_index * homogeneity * coalesce(newcomer_absorption,0))::numeric, 4) as score
from v_market_dong
where n_spaces >= 5
  and n_incumbent_active >= 4          -- 기준선을 세울 만큼 살아있는 기존 업체가 있어야 한다
  and n_newcomers >= 3                 -- 신규 흡수율을 볼 표본
  and n_hosts >= 4                     -- 한 호스트가 여러 개 돌리면 동질성이 위조된다
  and operating_rate >= nat_operating_rate   -- 방치 매물 천지인 시장은 제외
order by score desc nulls last;

create view v_demand_trend as
select s.category, s.sigungu, s.dong_code,
  date_trunc('month', r.review_date)::date as month, count(*) as reviews
from review r join space s using (space_id)
where s.category <> '기타' group by 1,2,3,4;

-- 경매 물건 좌표를 넣으면 그 자리의 경쟁군과 예상 실적이 나온다.
-- 행정경계에 안 끊기는 실제 상권 단위.
create function market_at(
  p_lat double precision, p_lng double precision,
  p_radius_m int default 1000, p_category text default null)
returns table (category text, n_spaces bigint, n_active bigint, n_hosts bigint,
  median_rate numeric, p25_rate numeric, median_price numeric, median_pyeong numeric,
  n_newcomers bigint, n_newcomers_zero bigint, newcomer_median_rate numeric, operating_rate numeric)
language sql stable as $$
  select b.category, count(*), count(*) filter (where b.active_90d), count(distinct b.host_id),
    percentile_cont(0.5) within group (
      order by case when b.active_90d and not b.is_newcomer then b.reviews_per_month end)::numeric,
    percentile_cont(0.25) within group (
      order by case when b.active_90d and not b.is_newcomer then b.reviews_per_month end)::numeric,
    percentile_cont(0.5) within group (order by b.median_price)::numeric,
    percentile_cont(0.5) within group (order by b.total_pyeong)::numeric,
    count(*) filter (where b.is_newcomer),
    count(*) filter (where b.is_newcomer and b.review_total = 0),
    percentile_cont(0.5) within group (
      order by case when b.is_newcomer then b.reviews_per_month end)::numeric,
    round(count(*) filter (where b.active_90d)::numeric / nullif(count(*),0), 3)
  from v_space_base b
  where b.geom is not null
    and st_dwithin(b.geom, st_makepoint(p_lng, p_lat)::geography, p_radius_m)
    and (p_category is null or b.category = p_category)
  group by b.category order by count(*) desc;
$$;
