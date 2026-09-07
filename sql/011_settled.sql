-- 실측 월매출.
--
-- rev_month_short 는 D+1~3 사흘치를 30.4로 곱한 환산값이다. 근거는 있지만 곱셈이다.
-- 같은 날짜를 여러 날 반복 관측하면 곱하지 않고 실제로 센 값을 낼 수 있다.
--
-- 방법은 달력이 쓰는 것과 같다 — 날짜마다 그 날짜를 가장 늦게 본 관측을 고른다.
-- 예약 API 는 지난 날짜의 시간표를 주지 않으므로, 그 날이 오기 전 마지막으로 봐둔
-- 값이 그 날의 최종 상태에 가장 가깝다.
--
-- 확정도를 같이 적는다. 관측이 그 날 또는 하루 전이면 사실상 최종값이고,
-- 며칠 전이면 그 사이 더 찼을 수 있어 과소다. 실측으로 08-26 관측분과 09-07 관측분을
-- 짝지어 보니 같은 날짜가 D+13 에서 D+1 로 오는 동안 예약이 33.7% 늘었다.
-- 그래서 n_days 만 쓰면 안 되고 n_days_final 을 같이 봐야 한다.
--
-- 관측이 30일 쌓이기 전까지 이 값은 "한 달치"가 아니다. 며칠을 실제로 셌는지
-- (n_days) 를 반드시 같이 노출해야 하고, 화면에서 환산값과 섞으면 안 된다.

create table if not exists space_settled (
  space_id      bigint not null,
  as_of         date   not null,   -- 이 집계를 돌린 시점의 최신 관측일
  from_date     date,              -- 실측한 지난 날짜의 처음
  to_date       date,              -- 마지막
  n_days        int,               -- 실측한 지난 날짜 수
  n_days_final  int,               -- 그중 그 날 또는 하루 전에 본 것 (확정)
  open_h        int,
  booked_h      int,
  fill_rate     numeric(6,4),
  rev           numeric(14,0),     -- 그 날짜들의 실제 매출 합 (하한)
  rev_ceil      numeric(14,0),     -- 상한 (만석 가정)
  rev_day       numeric(12,1),     -- 하루 평균 하한
  rev_day_final numeric(12,1),     -- 확정된 날짜만으로 낸 하루 평균 하한
  n_days_pkg    int,               -- 패키지가로 다시 잡은 예약 덩어리 수
  primary key (space_id, as_of)
);
create index if not exists ss_asof_idx on space_settled (as_of);

comment on table  space_settled            is '지나간 날짜를 실제로 세서 낸 매출. 곱셈이 없다';
comment on column space_settled.n_days     is '실측한 날 수. 30 미만이면 월매출이 아니다';
comment on column space_settled.n_days_final is 'D-1 이내 관측이라 사실상 최종인 날 수';
