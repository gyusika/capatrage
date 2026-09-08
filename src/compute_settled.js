// 실측 월매출. 지나간 날짜를 실제로 세서 낸다 — 곱셈이 없다.
//
// compute_revenue 는 D+1~3 사흘치를 30.4로 곱한다. 근거는 있지만 환산이다.
// 이 스크립트는 날짜마다 그 날짜를 가장 늦게 본 관측을 골라 실제 예약을 센다.
// 가격 규칙(더미 판정·인원 하한/상한·패키지 보정)은 compute_revenue 와 같은
// pricingCTEs 를 쓴다. 두 숫자를 나란히 놓으려면 규칙이 갈라지면 안 된다.
//
// 관측이 30일 쌓이기 전에는 "한 달치"가 아니다. n_days 를 반드시 같이 낸다.
import { pool } from './lib/db.js';
import { prepBatch } from './lib/batch.js';
import { pricingCTEs } from './lib/revenue_sql.js';
import { today } from './lib/util.js';
import { stage } from './lib/progress.js';

const date = process.env.LOAD_DATE ?? today();
/** 관측이 이 날짜보다 며칠 이내면 사실상 최종으로 본다. */
const FINAL_LEAD = Number(process.env.SETTLED_FINAL_LEAD ?? 1);
const DUMMY_MULT = Number(process.env.DUMMY_PRICE_MULT ?? 10);
/**
 * 더미 가격 절대 상한. 상대 규칙(통상 단가의 N배)만으로는 단가가 한 값뿐이거나
 * 단계가 촘촘한 상품에서 차단값을 못 잡는다. 예약된 시각 단가의 p99 가 400,000원이라
 * 50만원은 정상 단가 위쪽 바깥이다.
 */
const DUMMY_ABS = Number(process.env.DUMMY_PRICE_ABS ?? 500000);


const db = pool();
const c = await db.connect();
await prepBatch(c, { name: `capatrage-settled-${date}` });

console.log(`기준 관측일 ${date} | 확정 판정 D-${FINAL_LEAD} 이내`);

const P = stage('settled', date, { total: 1, note: '지나간 날짜 실측 매출 (곱셈 없음)' });

await c.query('begin');
await c.query(`delete from space_settled where as_of = $1`, [date]);

const r = await c.query(
  `insert into space_settled
     (space_id, as_of, from_date, to_date, n_days, n_days_final,
      open_h, booked_h, fill_rate, rev, rev_ceil, rev_day, rev_day_final, n_days_pkg)
   with pick as (
     -- 날짜마다 그 날짜를 가장 늦게 본 관측 하나. 달력 화면과 같은 규칙이다.
     -- 지나간 날짜만 본다 — 앞으로의 날짜는 아직 덜 차서 실측이 아니다.
     select distinct on (b.space_id, b.product_id, b.rsv_type_id, b.target_date) b.*
       from booking_day b
      where b.target_date < $1
      order by b.space_id, b.product_id, b.rsv_type_id, b.target_date, b.observed_date desc
   ),
   ex as (
     select p.space_id, p.product_id, p.rsv_type_id, p.observed_date, p.target_date,
            (p.target_date - p.observed_date) as lead_days,
            h.hour,
            (h.hour = any(p.booked_hours)) as booked,
            coalesce(p.hour_prices[h.hour + 1], p.price) as price,
            k.is_closed
       from pick p
       cross join generate_series(0, 23) as h(hour)
       -- 영업시간 판정은 최신 관측분 하나를 쓴다. 시각별 영업 여부는 날마다 바뀌지 않고,
       -- 과거 관측일마다 따로 잡으면 같은 상품이 날짜별로 다른 영업시간을 갖게 된다.
       join booking_hour_class k
         on k.space_id = p.space_id and k.product_id = p.product_id
        and k.rsv_type_id = p.rsv_type_id and k.observed_date = $1
        and k.hour = h.hour
      where not k.is_closed
   ),
${pricingCTEs('$1', '$2', '$4')}
   adj as (
     select space_id, coalesce(sum(cut), 0) as cut, count(*)::int as n_pkg
       from pkg_adj group by space_id
   ),
   -- 분모: 열려 있던 모든 시각. 갈래를 나눈 이유는 revenue_sql 의 numbered 주석에 있다.
   agg_open as (
     select space_id,
       min(target_date) as from_date,
       max(target_date) as to_date,
       count(distinct target_date) filter (where not coalesce(dummy, false))        as n_days,
       count(distinct target_date) filter (
         where not coalesce(dummy, false) and lead_days <= $3)                      as n_days_final,
       count(*) filter (where not coalesce(dummy, false))                           as open_h
       from flagged group by space_id
   ),
   -- 분자: 실제로 팔린 시각만.
   agg_sold as (
     select space_id,
       count(*)                                                as booked_h,
       coalesce(sum(floor_amt), 0)                             as rev,
       coalesce(sum(ceil_amt), 0)                              as rev_ceil_h,
       -- 확정된 날짜만으로 낸 합. 과소인 날을 섞지 않은 값이다.
       coalesce(sum(floor_amt) filter (where lead_days <= $3), 0) as rev_final
       from numbered group by space_id
   ),
   agg_blk as (
     select space_id, coalesce(sum(block_add), 0) as block_add from blk_agg group by space_id
   ),
   agg as (
     select o.space_id, o.from_date, o.to_date, o.n_days, o.n_days_final, o.open_h,
       coalesce(s.booked_h, 0)                                     as booked_h,
       coalesce(s.rev, 0)                                          as rev,
       coalesce(s.rev_ceil_h, 0) + coalesce(k.block_add, 0)        as rev_ceil,
       coalesce(s.rev_final, 0)                                    as rev_final,
       o.n_days_final                                              as days_final
       from agg_open o
       left join agg_sold s on s.space_id = o.space_id
       left join agg_blk  k on k.space_id = o.space_id
   )
   select a.space_id, $1::date, a.from_date, a.to_date,
     a.n_days::int, a.n_days_final::int,
     a.open_h::int, a.booked_h::int,
     round(a.booked_h::numeric / nullif(a.open_h, 0), 4),
     round((a.rev - coalesce(j.cut, 0))::numeric, 0),
     round(a.rev_ceil::numeric, 0),
     round((a.rev - coalesce(j.cut, 0))::numeric / nullif(a.n_days, 0), 1),
     round(a.rev_final::numeric / nullif(a.days_final, 0), 1),
     coalesce(j.n_pkg, 0)
   from agg a
   left join adj j on j.space_id = a.space_id`,
  [date, DUMMY_MULT, FINAL_LEAD, DUMMY_ABS]
);
console.log(`space_settled: ${r.rowCount}곳`);

await c.query('commit');

const s = await c.query(
  `select count(*)::int n,
          max(n_days)::int max_days,
          round(avg(n_days), 1) avg_days,
          round(avg(n_days_final), 1) avg_final,
          min(from_date)::text from_d, max(to_date)::text to_d,
          count(*) filter (where booked_h > 0)::int active
     from space_settled where as_of = $1`, [date]);
const x = s.rows[0];
console.log(
  `\n실측 구간 ${x.from_d} ~ ${x.to_d} | 공간 ${x.n}곳 (예약 있는 곳 ${x.active}곳)\n` +
  `공간당 실측 ${x.avg_days}일 (그중 확정 ${x.avg_final}일) · 최대 ${x.max_days}일`
);

if (x.max_days < 30)
  console.log(
    `\n주의: 아직 ${x.max_days}일치다. 30일이 차기 전까지 이 값은 월매출이 아니다.\n` +
    `화면에서 "실측 N일"로만 쓰고 rev_month_short 와 같은 칸에 두면 안 된다.`
  );

const cmp = await c.query(
  `select round(percentile_cont(0.5) within group (order by t.rev_day)::numeric, 0) settled_day,
          round(percentile_cont(0.5) within group (order by r.short_rev_day)::numeric, 0) short_day,
          count(*)::int n
     from space_settled t
     join space_revenue r on r.space_id = t.space_id and r.observed_date = t.as_of
     join booking_space_fill f on f.space_id = t.space_id and f.observed_date = t.as_of
    where t.as_of = $1 and not f.is_blocked_suspect and t.booked_h > 0`, [date]);
const cx = cmp.rows[0];
if (cx.n > 0) {
  const won = (v) => (v == null ? '—' : Number(v).toLocaleString('ko-KR') + '원');
  console.log(
    `\n하루 매출 중앙값 비교 (예약 있는 ${cx.n}곳)\n` +
    `  실측(지나간 날짜)  ${won(cx.settled_day)}\n` +
    `  환산 기준(D+1~3)   ${won(cx.short_day)}\n` +
    `  두 값이 크게 벌어지면 D+1~3 을 대표로 쓰는 가정을 다시 봐야 한다.`
  );
}

P.set(1);
await P.ok(`공간 ${r.rowCount.toLocaleString('ko-KR')}곳 · 실측 ${x.max_days ?? 0}일치`);

c.release();
await db.end();
