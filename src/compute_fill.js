// booking_day 에서 영업시간을 판정하고 실제 예약률을 계산해 테이블에 넣는다.
// 매 페이지 요청마다 24배 cross join 을 돌리지 않기 위해 적재 직후 한 번만 돌린다.
import { pool } from './lib/db.js';
import { today } from './lib/util.js';

const date = process.env.LOAD_DATE ?? today();
const MIN_DAYS = Number(process.env.CLOSED_MIN_DAYS ?? 14);

const db = pool();
const c = await db.connect();
// 관측일이 늘면서 09-06 관측분(55만행)부터 차단 판별 UPDATE 가 서버 기본 2분을 넘겨
// 트랜잭션째로 롤백됐다. 배치 잡이므로 푼다. compute_revenue 와 같은 처리다.
await c.query(`set statement_timeout = 0`);

console.log(`관측일 ${date} | 영업시간 판정 최소 관측일수 ${MIN_DAYS}일`);

await c.query('begin');

// ── 1. 시각별 판정 ───────────────────────────────────────────────
await c.query(`delete from booking_hour_class where observed_date = $1`, [date]);
const r1 = await c.query(
  `insert into booking_hour_class
     (space_id, product_id, rsv_type_id, observed_date, hour, n_days, n_blocked, is_closed)
   select b.space_id, b.product_id, b.rsv_type_id, b.observed_date, h.hour,
          count(*)::int,
          count(*) filter (where h.hour = any(b.booked_hours))::int,
          -- 관측 일수가 충분한데 단 하루도 열린 적이 없으면 영업시간 밖으로 본다
          (count(*) >= $2 and count(*) filter (where h.hour = any(b.booked_hours)) = count(*))
     from booking_day b
     cross join generate_series(0, 23) as h(hour)
    where b.observed_date = $1 and b.target_date > b.observed_date
    group by b.space_id, b.product_id, b.rsv_type_id, b.observed_date, h.hour`,
  [date, MIN_DAYS]
);
console.log(`booking_hour_class: ${r1.rowCount}건`);

// ── 2. 공간 단위 집계 ────────────────────────────────────────────
await c.query(`delete from booking_space_fill where observed_date = $1`, [date]);
const r2 = await c.query(
  `insert into booking_space_fill
     (space_id, observed_date, n_products, n_days, open_hours_day, closed_hours,
      open_slot_hours, booked_hours, fill_rate, open_14d, booked_14d, fill_rate_14d)
   with ex as (
     select b.space_id, b.product_id, b.rsv_type_id, b.observed_date, b.target_date,
            h.hour, (h.hour = any(b.booked_hours)) as blocked
       from booking_day b
       cross join generate_series(0, 23) as h(hour)
      where b.observed_date = $1 and b.target_date > b.observed_date
   ),
   j as (
     select e.*, k.is_closed
       from ex e
       join booking_hour_class k
         on k.space_id = e.space_id and k.product_id = e.product_id
        and k.rsv_type_id = e.rsv_type_id and k.observed_date = e.observed_date
        and k.hour = e.hour
   )
   select space_id, observed_date,
     count(distinct product_id)::int,
     count(distinct target_date)::int,
     round(
       count(*) filter (where not is_closed)::numeric
       / nullif(count(distinct target_date) * count(distinct (product_id, rsv_type_id)), 0), 2),
     count(distinct (product_id, rsv_type_id, hour)) filter (where is_closed)::int,
     count(*) filter (where not is_closed)::int,
     count(*) filter (where not is_closed and blocked)::int,
     round(count(*) filter (where not is_closed and blocked)::numeric
           / nullif(count(*) filter (where not is_closed), 0), 4),
     count(*) filter (where not is_closed and target_date <= observed_date + 14)::int,
     count(*) filter (where not is_closed and blocked and target_date <= observed_date + 14)::int,
     round(
       count(*) filter (where not is_closed and blocked and target_date <= observed_date + 14)::numeric
       / nullif(count(*) filter (where not is_closed and target_date <= observed_date + 14), 0), 4)
   from j
   group by space_id, observed_date`,
  [date]
);
console.log(`booking_space_fill: ${r2.rowCount}건`);

// ── 2b. 캘린더 차단 판별 ─────────────────────────────────────────
// 실제 예약은 날짜마다 시각 조합이 다르다. 차단은 매일 똑같다.
// mode_share >= 0.8 이면 차단 의심. 지우지 않고 표시만 하되 집계에서는 뺀다.
// 24시간을 cross join 해서 13.2M 행을 만들지 않는다. 예약된 시각은 이미 배열이라
// 그것만 펼치면 2.2M 행이면 된다. 휴무 시각은 상품별로 배열 하나로 접어놓고 뺀다.
// 08-26 관측분에서 두 방식의 결과가 2,685곳 전부 일치하는 것을 확인했다 (63.9초 -> 2.2초).
// 관측일이 55만 행으로 늘자 예전 방식이 40분을 넘겨 파이프라인을 세웠다.
const r2b = await c.query(
  `with cls as (
     select space_id, product_id, rsv_type_id,
            coalesce(array_agg(hour) filter (where is_closed), '{}') as closed_h
       from booking_hour_class
      where observed_date = $1
      group by 1, 2, 3
   ),
   pat as (
     select b.space_id, b.product_id, b.target_date,
            array_agg(x order by x) as hrs
       from booking_day b
       left join cls c on c.space_id = b.space_id and c.product_id = b.product_id
                      and c.rsv_type_id = b.rsv_type_id
       cross join lateral unnest(b.booked_hours) as x
      where b.observed_date = $1 and b.target_date > b.observed_date
        and not (x = any(coalesce(c.closed_h, '{}'::smallint[])))
      group by 1, 2, 3
   ),
   cnt as (
     select space_id, hrs, count(*) as n
       from pat where hrs is not null and array_length(hrs, 1) > 0
      group by 1, 2
   ),
   tot as (
     select space_id, sum(n)::int days_with_booking, max(n)::int top_n, count(*)::int n_pattern
       from cnt group by 1
   )
   update booking_space_fill f
      set days_with_booking = t.days_with_booking,
          n_pattern = t.n_pattern,
          mode_share = round(t.top_n::numeric / t.days_with_booking, 3),
          is_blocked_suspect = (t.top_n::numeric / t.days_with_booking) >= 0.8
     from tot t
    where f.space_id = t.space_id and f.observed_date = $1`,
  [date]
);
console.log(`차단 판별: ${r2b.rowCount}곳 갱신`);

// ── 3. 요일×시간 히트맵 ──────────────────────────────────────────
await c.query(`delete from booking_heat where observed_date = $1`, [date]);
const r3 = await c.query(
  `insert into booking_heat (category, sigungu, observed_date, wday, hour, n_open, n_booked, fill_rate)
   with ex as (
     select b.space_id, b.product_id, b.rsv_type_id, b.observed_date, b.wday,
            h.hour, (h.hour = any(b.booked_hours)) as blocked
       from booking_day b
       cross join generate_series(0, 23) as h(hour)
      where b.observed_date = $1 and b.target_date > b.observed_date
   )
   select s.category, s.sigungu, e.observed_date, e.wday, e.hour,
          count(*)::int,
          count(*) filter (where e.blocked)::int,
          round(count(*) filter (where e.blocked)::numeric / nullif(count(*), 0), 4)
     from ex e
     join booking_hour_class k
       on k.space_id = e.space_id and k.product_id = e.product_id
      and k.rsv_type_id = e.rsv_type_id and k.observed_date = e.observed_date and k.hour = e.hour
     join space s on s.space_id = e.space_id
     join booking_space_fill f
       on f.space_id = e.space_id and f.observed_date = e.observed_date
    where not k.is_closed              -- 영업시간만 센다
      and not f.is_blocked_suspect     -- 차단된 캘린더는 "언제 차는가"를 왜곡한다
      and s.category <> '기타'
    group by s.category, s.sigungu, e.observed_date, e.wday, e.hour`,
  [date]
);
console.log(`booking_heat: ${r3.rowCount}건`);

// ── 4. 리드타임별 예약률 ─────────────────────────────────────────
await c.query(`delete from booking_lead where observed_date = $1`, [date]);
const r4 = await c.query(
  `insert into booking_lead (category, sigungu, observed_date, lead_days, n_open, n_booked, fill_rate)
   with ex as (
     select b.space_id, b.product_id, b.rsv_type_id, b.observed_date,
            (b.target_date - b.observed_date) as lead_days,
            h.hour, (h.hour = any(b.booked_hours)) as blocked
       from booking_day b
       cross join generate_series(0, 23) as h(hour)
      where b.observed_date = $1 and b.target_date > b.observed_date
   )
   select s.category, s.sigungu, e.observed_date, e.lead_days,
          count(*)::int,
          count(*) filter (where e.blocked)::int,
          round(count(*) filter (where e.blocked)::numeric / nullif(count(*), 0), 4)
     from ex e
     join booking_hour_class k
       on k.space_id = e.space_id and k.product_id = e.product_id
      and k.rsv_type_id = e.rsv_type_id and k.observed_date = e.observed_date and k.hour = e.hour
     join space s on s.space_id = e.space_id
     join booking_space_fill f
       on f.space_id = e.space_id and f.observed_date = e.observed_date
    where not k.is_closed
      and not f.is_blocked_suspect
      and s.category <> '기타' and s.sigungu is not null
    group by s.category, s.sigungu, e.observed_date, e.lead_days`,
  [date]
);
console.log(`booking_lead: ${r4.rowCount}건`);

await c.query('commit');

const s = await c.query(
  `select count(*) spaces,
          sum(booked_hours) booked, sum(open_slot_hours) open_h,
          round(avg(open_hours_day)::numeric, 1) avg_open_day,
          round(avg(fill_rate)::numeric * 100, 1) avg_fill,
          round((percentile_cont(0.5) within group (order by fill_rate))::numeric * 100, 1) med_fill
     from booking_space_fill where observed_date = $1`, [date]);
const r = s.rows[0];
console.log(
  `\n공간 ${r.spaces}곳 | 하루 평균 영업 ${r.avg_open_day}시간 | ` +
  `실제 예약 ${r.booked}h / 영업 ${r.open_h}h`
);
console.log(`예약률 평균 ${r.avg_fill}% · 중앙값 ${r.med_fill}%`);

const bs = await c.query(
  `select count(*)::int n,
          count(*) filter (where is_blocked_suspect)::int suspect,
          count(*) filter (where booked_hours > 0)::int with_any,
          count(*) filter (where booked_hours > 0 and is_blocked_suspect)::int any_suspect,
          round((percentile_cont(0.5) within group (
            order by case when not is_blocked_suspect then fill_rate end))::numeric * 100, 2) med_clean
     from booking_space_fill where observed_date = $1`, [date]);
const b2 = bs.rows[0];
console.log(
  `차단 의심 ${b2.suspect}곳 (예약 있는 ${b2.with_any}곳 중 ${b2.any_suspect}곳) | ` +
  `차단 제외 예약률 중앙값 ${b2.med_clean}%`
);

c.release();
await db.end();
