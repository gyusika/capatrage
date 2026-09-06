// 매출 추산. 예약된 시간 × 그 시간의 가격 — 둘 다 실측값이다.
//
// D+1~3 을 따로 내는 이유: 향후 예약은 아직 덜 찼다.
// 리드타임 곡선이 D+1 5.0% → D+21 0.8% 로 떨어진다. 3주 뒤 예약률은 수요가 아니라 시기의 문제다.
// 내일·모레 예약은 사실상 확정이므로 그걸 운영 상황의 근사로 쓴다.
import { pool } from './lib/db.js';
import { today } from './lib/util.js';

const date = process.env.LOAD_DATE ?? today();
const SHORT_DAYS = Number(process.env.SHORT_LEAD_DAYS ?? 3); // D+1 ~ D+3
const DAYS_PER_MONTH = 30.4;
// 더미 가격 경계. 그 상품 통상 단가의 몇 배부터 "팔 생각이 없는 값"으로 볼지.
// 배수 분포가 이봉이고 10~20배 구간이 골짜기다. 근거는 sql/008_dummy_price.sql 참고.
const DUMMY_MULT = Number(process.env.DUMMY_PRICE_MULT ?? 10);

const db = pool();
const c = await db.connect();
// 전수 재계산은 2분(서버 기본값)을 넘긴다. 배치 잡이므로 푼다.
await c.query(`set statement_timeout = 0`);

console.log(`관측일 ${date} | 단기 기준 D+1~D+${SHORT_DAYS} | 더미 가격 경계 통상단가의 ${DUMMY_MULT}배`);

await c.query('begin');
await c.query(`delete from space_revenue where observed_date = $1`, [date]);

const r = await c.query(
  `insert into space_revenue
     (space_id, observed_date, short_days, short_open_h, short_booked_h, short_fill,
      short_rev_day, rev_month_short, all_days, all_booked_h, all_fill, rev_month_all,
      rev_month_max, adr, dummy_h, dummy_rev)
   with ex as (
     select b.space_id, b.product_id, b.rsv_type_id, b.observed_date, b.target_date,
            (b.target_date - b.observed_date) as lead_days,
            h.hour,
            (h.hour = any(b.booked_hours)) as booked,
            -- hour_prices 가 없던 예전 수집분은 일 단가로 대체한다
            coalesce(b.hour_prices[h.hour + 1], b.price) as price,
            k.is_closed
       from booking_day b
       cross join generate_series(0, 23) as h(hour)
       join booking_hour_class k
         on k.space_id = b.space_id and k.product_id = b.product_id
        and k.rsv_type_id = b.rsv_type_id and k.observed_date = b.observed_date
        and k.hour = h.hour
      where b.observed_date = $1 and b.target_date > b.observed_date
        and not k.is_closed          -- 영업시간만 센다
   ),
   -- 그 상품의 통상 단가. 더미 판정의 기준선이다.
   -- 절대 금액으로 자르면 업종별 정상 단가 차이(연습실 9천 ~ 숙박 7만)에 걸린다.
   -- ex 가 아니라 booking_day 에서 직접 뽑는다. ex 를 두 번 훑으면 2분을 넘긴다.
   base as (
     select b.space_id, b.product_id, b.rsv_type_id,
            percentile_cont(0.5) within group (order by p) as med_price
       from booking_day b, unnest(b.hour_prices) p
      where b.observed_date = $1 and p is not null and p > 0
      group by b.space_id, b.product_id, b.rsv_type_id
   ),
   flagged as (
     select e.*,
            -- 통상 단가의 N배 이상이면 팔 생각이 없는 값으로 본다.
            -- 예약(분자)에서도 영업시간(분모)에서도 뺀다. 휴무와 같은 취급이다.
            (b.med_price > 0 and e.price >= b.med_price * $4) as dummy
       from ex e
       left join base b on b.space_id = e.space_id and b.product_id = e.product_id
                       and b.rsv_type_id = e.rsv_type_id
   ),
   agg as (
     select space_id, observed_date,
       count(distinct target_date) filter (where lead_days <= $2 and not coalesce(dummy, false)) as short_days,
       count(*) filter (where lead_days <= $2 and not coalesce(dummy, false))                    as short_open_h,
       count(*) filter (where lead_days <= $2 and booked and not coalesce(dummy, false))         as short_booked_h,
       coalesce(sum(price) filter (where lead_days <= $2 and booked and not coalesce(dummy, false)), 0) as short_rev,
       count(distinct target_date) filter (where not coalesce(dummy, false))                     as all_days,
       count(*) filter (where not coalesce(dummy, false))                                        as all_open_h,
       count(*) filter (where booked and not coalesce(dummy, false))                             as all_booked_h,
       coalesce(sum(price) filter (where booked and not coalesce(dummy, false)), 0)              as all_rev,
       coalesce(sum(price) filter (where not coalesce(dummy, false)), 0)                         as max_rev,
       avg(price) filter (where booked and not coalesce(dummy, false))                           as adr,
       count(*) filter (where booked and coalesce(dummy, false))                                 as dummy_h,
       coalesce(sum(price) filter (where booked and coalesce(dummy, false)), 0)                  as dummy_rev
       from flagged group by space_id, observed_date
   )
   select space_id, observed_date,
     short_days::int, short_open_h::int, short_booked_h::int,
     round(short_booked_h::numeric / nullif(short_open_h, 0), 4),
     round(short_rev::numeric / nullif(short_days, 0), 1),
     round(short_rev::numeric / nullif(short_days, 0) * $3, 0),
     all_days::int, all_booked_h::int,
     round(all_booked_h::numeric / nullif(all_open_h, 0), 4),
     round(all_rev::numeric / nullif(all_days, 0) * $3, 0),
     round(max_rev::numeric / nullif(all_days, 0) * $3, 0),
     round(adr::numeric, 1),
     dummy_h::int, round(dummy_rev::numeric, 0)
   from agg`,
  [date, SHORT_DAYS, DAYS_PER_MONTH, DUMMY_MULT]
);
console.log(`space_revenue: ${r.rowCount}곳`);

await c.query('commit');

const d = await c.query(
  `select coalesce(sum(dummy_h), 0)::int h,
          coalesce(sum(dummy_rev), 0)::bigint rev,
          count(*) filter (where dummy_h > 0)::int spaces
     from space_revenue where observed_date = $1`, [date]);
const dx = d.rows[0];
if (dx.h > 0)
  console.log(
    `더미 가격 제외: ${dx.spaces}곳 ${dx.h}시간 ` +
    `(매출로 셌다면 ${Number(dx.rev).toLocaleString('ko-KR')}원)`
  );

const s = await c.query(
  `select count(*)::int n,
          count(*) filter (where r.short_booked_h > 0)::int active,
          round((percentile_cont(0.5) within group (
            order by case when not f.is_blocked_suspect then r.rev_month_short end))::numeric, 0) med,
          round((percentile_cont(0.9) within group (
            order by case when not f.is_blocked_suspect then r.rev_month_short end))::numeric, 0) p90,
          round((percentile_cont(0.5) within group (
            order by case when not f.is_blocked_suspect then r.rev_month_max end))::numeric, 0) max_med,
          round((percentile_cont(0.5) within group (
            order by case when not f.is_blocked_suspect then r.adr end))::numeric, 0) adr
     from space_revenue r
     join booking_space_fill f on f.space_id = r.space_id and f.observed_date = r.observed_date
    where r.observed_date = $1`, [date]);
const x = s.rows[0];
const won = (v) => (v == null ? '—' : Number(v).toLocaleString('ko-KR') + '원');
console.log(
  `\n공간 ${x.n}곳 (D+1~${SHORT_DAYS} 예약 있는 곳 ${x.active}곳)\n` +
  `월 매출 추산 중앙값 ${won(x.med)} · 상위10% ${won(x.p90)}\n` +
  `100% 찼을 때 잠재 매출 중앙값 ${won(x.max_med)} · 예약 시간 평균 단가 ${won(x.adr)}`
);

c.release();
await db.end();
