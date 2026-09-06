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

const db = pool();
const c = await db.connect();

console.log(`관측일 ${date} | 단기 기준 D+1~D+${SHORT_DAYS}`);

await c.query('begin');
await c.query(`delete from space_revenue where observed_date = $1`, [date]);

const r = await c.query(
  `insert into space_revenue
     (space_id, observed_date, short_days, short_open_h, short_booked_h, short_fill,
      short_rev_day, rev_month_short, all_days, all_booked_h, all_fill, rev_month_all,
      rev_month_max, adr)
   with ex as (
     select b.space_id, b.observed_date, b.target_date,
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
   agg as (
     select space_id, observed_date,
       count(distinct target_date) filter (where lead_days <= $2)          as short_days,
       count(*) filter (where lead_days <= $2)                             as short_open_h,
       count(*) filter (where lead_days <= $2 and booked)                  as short_booked_h,
       coalesce(sum(price) filter (where lead_days <= $2 and booked), 0)    as short_rev,
       count(distinct target_date)                                        as all_days,
       count(*)                                                            as all_open_h,
       count(*) filter (where booked)                                      as all_booked_h,
       coalesce(sum(price) filter (where booked), 0)                        as all_rev,
       sum(price)                                                          as max_rev,
       avg(price) filter (where booked)                                    as adr
       from ex group by space_id, observed_date
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
     round(adr::numeric, 1)
   from agg`,
  [date, SHORT_DAYS, DAYS_PER_MONTH]
);
console.log(`space_revenue: ${r.rowCount}곳`);

await c.query('commit');

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
