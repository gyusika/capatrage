// 매출 추산. 예약된 시간 × 그 시간의 가격 — 둘 다 실측값이다.
//
// D+1~3 을 따로 내는 이유: 향후 예약은 아직 덜 찼다.
// 리드타임 곡선이 D+1 5.0% → D+21 0.8% 로 떨어진다. 3주 뒤 예약률은 수요가 아니라 시기의 문제다.
// 내일·모레 예약은 사실상 확정이므로 그걸 운영 상황의 근사로 쓴다.
import { pool } from './lib/db.js';
import { prepBatch } from './lib/batch.js';
import { pricingCTEs } from './lib/revenue_sql.js';
import { today } from './lib/util.js';
import { stage } from './lib/progress.js';

const date = process.env.LOAD_DATE ?? today();
const SHORT_DAYS = Number(process.env.SHORT_LEAD_DAYS ?? 3); // D+1 ~ D+3
const DAYS_PER_MONTH = 30.4;
// 더미 가격 경계. 그 상품 통상 단가의 몇 배부터 "팔 생각이 없는 값"으로 볼지.
// 배수 분포가 이봉이고 10~20배 구간이 골짜기다. 근거는 sql/008_dummy_price.sql 참고.
const DUMMY_MULT = Number(process.env.DUMMY_PRICE_MULT ?? 10);
/**
 * 더미 가격 절대 상한. 상대 규칙(통상 단가의 N배)만으로는 단가가 한 값뿐이거나
 * 단계가 촘촘한 상품에서 차단값을 못 잡는다. 예약된 시각 단가의 p99 가 400,000원이라
 * 50만원은 정상 단가 위쪽 바깥이다.
 */
const DUMMY_ABS = Number(process.env.DUMMY_PRICE_ABS ?? 500000);


const db = pool();
const c = await db.connect();
await prepBatch(c, { name: `capatrage-revenue-${date}` });

console.log(`관측일 ${date} | 단기 기준 D+1~D+${SHORT_DAYS} | 더미 가격 경계 통상단가의 ${DUMMY_MULT}배 또는 시간당 ${DUMMY_ABS.toLocaleString('ko-KR')}원 이상`);

// 한 방 쿼리라 중간 진행이 없다. 도는 중이라는 것만 알리고 끝나면 결과를 남긴다.
const P = stage('revenue', date, { total: 1, note: '매출 환산 (수백만 행 집계, 수십 분)' });

await c.query('begin');
await c.query(`delete from space_revenue where observed_date = $1`, [date]);

// EXPLAIN_ONLY=1 이면 실행 대신 계획만 뜬다. 다섯 시간짜리 쿼리를 고치려면
// 어디서 시간을 쓰는지 먼저 봐야 하는데, 그걸 보려고 다섯 시간을 또 쓸 수는 없다.
const EXPLAIN = process.env.EXPLAIN_ONLY ? 'explain (verbose false, costs true) ' : '';

const r = await c.query(
  EXPLAIN + `insert into space_revenue
     (space_id, observed_date, short_days, short_open_h, short_booked_h, short_fill,
      short_rev_day, rev_month_short, all_days, all_booked_h, all_fill, rev_month_all,
      rev_month_max, adr, dummy_h, dummy_rev,
      rev_month_short_ceil, rev_month_all_ceil, n_rsv_blocks,
      n_pkg_blocks, pkg_cut_short, pkg_cut_all)
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
${pricingCTEs('$1', '$4', '$5')}
   adj as (
     select space_id, observed_date,
            coalesce(sum(cut) filter (where lead_days <= $2), 0) as cut_short,
            coalesce(sum(cut), 0)                                as cut_all,
            count(*)::int                                        as n_pkg_blocks
       from pkg_adj group by space_id, observed_date
   ),
   -- 분모: 열려 있는 모든 시각. 예약 여부와 무관하다.
   agg_open as (
     select space_id, observed_date,
       count(distinct target_date) filter (where lead_days <= $2 and not coalesce(dummy, false)) as short_days,
       count(*) filter (where lead_days <= $2 and not coalesce(dummy, false))                    as short_open_h,
       count(distinct target_date) filter (where not coalesce(dummy, false))                     as all_days,
       count(*) filter (where not coalesce(dummy, false))                                        as all_open_h,
       coalesce(sum(floor_amt) filter (where not coalesce(dummy, false)), 0)                     as max_rev,
       count(*) filter (where booked and coalesce(dummy, false))                                 as dummy_h,
       coalesce(sum(price) filter (where booked and coalesce(dummy, false)), 0)                  as dummy_rev
       from flagged group by space_id, observed_date
   ),
   -- 분자: 팔린 시각만. 예전엔 이것도 flagged 위에서 filter 로 냈지만, 그러면
   -- 덩어리 판정 때문에 1,320만 행을 정렬해야 했다. 갈래를 나눠 220만 행만 만진다.
   agg_sold as (
     select space_id, observed_date,
       count(*) filter (where lead_days <= $2)                            as short_booked_h,
       coalesce(sum(floor_amt) filter (where lead_days <= $2), 0)         as short_rev,
       coalesce(sum(ceil_amt)  filter (where lead_days <= $2), 0)         as short_rev_ceil_h,
       count(*)                                                          as all_booked_h,
       coalesce(sum(floor_amt), 0)                                       as all_rev,
       coalesce(sum(ceil_amt), 0)                                        as all_rev_ceil_h,
       avg(floor_amt)                                                    as adr
       from numbered group by space_id, observed_date
   ),
   -- 건당 추가금은 덩어리마다 한 번 붙는다.
   agg_blk as (
     select space_id, observed_date,
       coalesce(sum(block_add) filter (where lead_days <= $2), 0) as short_block_add,
       coalesce(sum(block_add), 0)                                as all_block_add,
       count(*)::int                                              as n_blocks
       from blk_agg group by space_id, observed_date
   ),
   agg as (
     select o.space_id, o.observed_date,
       o.short_days, o.short_open_h, o.all_days, o.all_open_h,
       o.max_rev, o.dummy_h, o.dummy_rev,
       coalesce(s.short_booked_h, 0)                                as short_booked_h,
       coalesce(s.short_rev, 0)                                     as short_rev,
       coalesce(s.short_rev_ceil_h, 0) + coalesce(k.short_block_add, 0) as short_rev_ceil,
       coalesce(s.all_booked_h, 0)                                  as all_booked_h,
       coalesce(s.all_rev, 0)                                       as all_rev,
       coalesce(s.all_rev_ceil_h, 0) + coalesce(k.all_block_add, 0) as all_rev_ceil,
       s.adr,
       coalesce(k.n_blocks, 0)                                      as n_blocks
       from agg_open o
       left join agg_sold s on s.space_id = o.space_id and s.observed_date = o.observed_date
       left join agg_blk  k on k.space_id = o.space_id and k.observed_date = o.observed_date
   )
   select a.space_id, a.observed_date,
     a.short_days::int, a.short_open_h::int, a.short_booked_h::int,
     round(a.short_booked_h::numeric / nullif(a.short_open_h, 0), 4),
     -- 하한에서 패키지 보정분을 뺀다. 상한은 그대로다.
     round((a.short_rev - coalesce(j.cut_short, 0))::numeric / nullif(a.short_days, 0), 1),
     round((a.short_rev - coalesce(j.cut_short, 0))::numeric / nullif(a.short_days, 0) * $3, 0),
     a.all_days::int, a.all_booked_h::int,
     round(a.all_booked_h::numeric / nullif(a.all_open_h, 0), 4),
     round((a.all_rev - coalesce(j.cut_all, 0))::numeric / nullif(a.all_days, 0) * $3, 0),
     round(a.max_rev::numeric / nullif(a.all_days, 0) * $3, 0),
     -- adr 은 예약된 시간의 시간제 게시 단가 평균이다. 패키지 보정을 넣지 않는다.
     round(a.adr::numeric, 1),
     a.dummy_h::int, round(a.dummy_rev::numeric, 0),
     round(a.short_rev_ceil::numeric / nullif(a.short_days, 0) * $3, 0),
     round(a.all_rev_ceil::numeric / nullif(a.all_days, 0) * $3, 0),
     a.n_blocks::int,
     coalesce(j.n_pkg_blocks, 0),
     round(coalesce(j.cut_short, 0)::numeric / nullif(a.short_days, 0) * $3, 0),
     round(coalesce(j.cut_all, 0)::numeric / nullif(a.all_days, 0) * $3, 0)
   from agg a
   left join adj j on j.space_id = a.space_id and j.observed_date = a.observed_date`,
  [date, SHORT_DAYS, DAYS_PER_MONTH, DUMMY_MULT, DUMMY_ABS]
);
if (EXPLAIN) {
  console.log(r.rows.map((x) => x['QUERY PLAN']).join('\n'));
  await c.query('rollback');
  c.release();
  await db.end();
  process.exit(0);
}
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

// 패키지 보정. 같은 시간을 시간제보다 싸게 파는 창이 있으면 하한이 그쪽으로 내려간다.
const pk = await c.query(
  `select count(*) filter (where n_pkg_blocks > 0)::int spaces,
          coalesce(sum(n_pkg_blocks), 0)::int blocks,
          coalesce(sum(pkg_cut_all), 0)::bigint cut,
          round(percentile_cont(0.5) within group (
            order by case when n_pkg_blocks > 0 and rev_month_all > 0
                          then pkg_cut_all::numeric / (rev_month_all + pkg_cut_all) end)::numeric, 3) share
     from space_revenue where observed_date = $1`, [date]);
const pkx = pk.rows[0];
const pkgAll = await c.query(
  `select count(*)::int rows, count(distinct space_id)::int spaces,
          count(*) filter (where shour >= ehour)::int wrap
     from booking_package where observed_date = $1`, [date]);
const pax = pkgAll.rows[0];
console.log(
  `\n패키지 가격표 ${Number(pax.rows).toLocaleString('ko-KR')}행 / ${pax.spaces}곳` +
  (pax.wrap ? ` (자정을 넘는 창 ${pax.wrap}행은 다음 날 새벽과 짝지어 맞춘다)` : '') + '\n' +
  (pkx.blocks
    ? `  예약 덩어리 ${Number(pkx.blocks).toLocaleString('ko-KR')}건이 패키지 창과 정확히 일치해 ` +
      `${pkx.spaces}곳의 하한을 패키지가로 다시 잡았다\n` +
      `  그만큼 깎인 월환산 매출 ${won(pkx.cut)} · 해당 공간 하한의 중앙값 기준 ` +
      `${pkx.share == null ? '—' : (Number(pkx.share) * 100).toFixed(1) + '%'} 감소`
    : '  패키지 창과 정확히 일치하는 예약 덩어리가 없어 하한 보정 없음')
);

// 매출 구간. 예약 인원을 관측할 수 없어 값 하나로 낼 수 없다.
const g = await c.query(
  `select round(percentile_cont(0.5) within group (
            order by case when not f.is_blocked_suspect and r.rev_month_all > 0
                          then r.rev_month_all end)::numeric, 0) lo,
          round(percentile_cont(0.5) within group (
            order by case when not f.is_blocked_suspect and r.rev_month_all > 0
                          then r.rev_month_all_ceil end)::numeric, 0) hi,
          round(percentile_cont(0.5) within group (
            order by case when not f.is_blocked_suspect and r.rev_month_all > 0
                          then r.rev_month_all_ceil::numeric / nullif(r.rev_month_all, 0) end)::numeric, 2) mult,
          sum(r.n_rsv_blocks)::int blocks
     from space_revenue r
     join booking_space_fill f on f.space_id = r.space_id and f.observed_date = r.observed_date
    where r.observed_date = $1`, [date]);
const gx = g.rows[0];
console.log(
  `\n인원 미상으로 인한 매출 구간 (관측 창 전체, 예약 있는 곳 중앙값)\n` +
  `  하한 ${won(gx.lo)} ~ 상한 ${won(gx.hi)}  (상한/하한 ${gx.mult}배)\n` +
  `  예약 덩어리 ${Number(gx.blocks).toLocaleString('ko-KR')}건 — 건당 추가금은 덩어리마다 한 번 붙였다`
);

P.set(1);
await P.ok(`공간 ${r.rowCount.toLocaleString('ko-KR')}곳 매출 구간 산출`);

c.release();
await db.end();
