// 캘린더 차단과 실제 예약을 가른다.
//
// 실제 예약은 날짜마다 시각 조합이 다르다. 차단은 매일 똑같은 시각이 막혀 있다.
// mode_share = 가장 흔한 "예약된 시각 집합"이 전체 예약 있는 날 중 차지하는 비율.
// 1.0 에 가까우면 매일 동일 = 차단.
import { pool } from '../src/lib/db.js';

const db = pool();
const c = await db.connect();

const PAT = `
  with pat as (
    select b.space_id, b.product_id, b.target_date,
           array_agg(h.hour order by h.hour)
             filter (where h.hour = any(b.booked_hours) and not k.is_closed) as hrs
      from booking_day b
      cross join generate_series(0, 23) as h(hour)
      join booking_hour_class k
        on k.space_id = b.space_id and k.product_id = b.product_id
       and k.rsv_type_id = b.rsv_type_id and k.observed_date = b.observed_date
       and k.hour = h.hour
     where b.target_date > b.observed_date
     group by 1, 2, 3
  ),
  cnt as (
    select space_id, hrs, count(*) as n
      from pat
     where hrs is not null and array_length(hrs, 1) > 0
     group by 1, 2
  ),
  tot as (
    select space_id, sum(n)::int as days_with_booking, max(n)::int as top_n,
           count(*)::int as n_distinct
      from cnt group by 1
  )
  select t.*, round(t.top_n::numeric / t.days_with_booking, 3) as mode_share
    from tot t`;

const top = await c.query(`
  select t.space_id, s.name, round(f.fill_rate * 100, 1) pct,
         t.days_with_booking, t.n_distinct, t.top_n, t.mode_share
    from (${PAT}) t
    join booking_space_fill f using (space_id)
    join space s using (space_id)
   where f.fill_rate >= 0.3
   order by f.fill_rate desc limit 15`);

console.log('예약률 30%+ | mode_share = 최빈 예약시각집합 비율, n_distinct = 서로 다른 패턴 수');
console.log('  id      예약률  예약일  패턴수  최빈  비율    판정');
for (const x of top.rows) {
  console.log(
    `  ${String(x.space_id).padEnd(7)} ${String(x.pct + '%').padStart(6)} ` +
      `${String(x.days_with_booking).padStart(5)}일 ${String(x.n_distinct).padStart(5)}개 ` +
      `${String(x.top_n).padStart(5)}일 ${String(x.mode_share).padStart(6)}  ` +
      (Number(x.mode_share) >= 0.8 ? '차단 의심' : '실제 예약')
  );
}

const agg = await c.query(`
  select count(*)::int n,
         count(*) filter (where mode_share >= 0.8)::int suspect,
         count(*) filter (where n_distinct = 1)::int identical
    from (${PAT}) t
    join booking_space_fill f using (space_id)
   where f.fill_rate >= $1`, [0.05]);
const a = agg.rows[0];
console.log(`\n예약률 5%+ ${a.n}곳 | 차단 의심(최빈 80%+) ${a.suspect}곳 | 패턴 완전 동일 ${a.identical}곳`);

const agg2 = await c.query(`
  select count(*)::int n, count(*) filter (where mode_share >= 0.8)::int suspect
    from (${PAT}) t join booking_space_fill f using (space_id)`);
console.log(`예약 있는 전체 ${agg2.rows[0].n}곳 중 차단 의심 ${agg2.rows[0].suspect}곳`);

c.release();
await db.end();
