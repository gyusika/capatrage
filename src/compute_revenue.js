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
   -- 인원 요금 구조. 예약 인원은 관측할 수 없으므로 매출을 구간으로 낸다.
   --   하한 = 기준 인원까지 예약했을 때 (관측값 그대로. 그 경우 오차 0)
   --   상한 = 만석일 때. 전부 실측 필드로 계산되고 가정이 들어가지 않는다.
   -- 평균 인원은 잡지 않는다. 정원은 수용 한계지 통상 이용 인원이 아니고
   -- 인원 분포에 대한 근거가 하나도 없다.
   guest as (
     select r.space_id, r.product_id, r.rsv_type_id,
            coalesce(r.charging_per_person = 'Y', false)      as per_person,
            greatest(coalesce(p.min_guest_policy, 1), 1)      as min_guest,
            greatest(coalesce(p.max_guest_capacity, 1), 1)    as max_guest,
            coalesce(r.person_ceiling, 0)                     as ceil_n,
            coalesce(r.extra_person_price, 0)                 as extra,
            coalesce(r.extra_per_hour, 'N')                   as extra_per_hour
       from rsv_type_snapshot r
       left join product_snapshot p
         on p.space_id = r.space_id and p.product_id = r.product_id
        and p.snapshot_date = r.snapshot_date
      where r.snapshot_date = $1
   ),
   flagged as (
     select e.*,
            -- 통상 단가의 N배 이상이면 팔 생각이 없는 값으로 본다.
            -- 예약(분자)에서도 영업시간(분모)에서도 뺀다. 휴무와 같은 취급이다.
            (b.med_price > 0 and e.price >= b.med_price * $4) as dummy,
            -- 1인당 과금이면 기본가 자체가 1인 단가라 최소 인원을 곱해야 하한이 된다
            case when g.per_person then e.price * g.min_guest else e.price end as floor_amt,
            case when g.per_person then e.price * g.max_guest
                 when g.extra_per_hour = 'Y'
                   then e.price + greatest(g.max_guest - g.ceil_n, 0) * g.extra
                 else e.price end as ceil_amt,
            -- 추가금이 예약 건당이면 시간마다가 아니라 덩어리마다 한 번 붙는다
            case when not coalesce(g.per_person, false) and g.extra_per_hour = 'N'
                 then greatest(g.max_guest - g.ceil_n, 0) * g.extra else 0 end as block_add
       from ex e
       left join base b on b.space_id = e.space_id and b.product_id = e.product_id
                       and b.rsv_type_id = e.rsv_type_id
       left join guest g on g.space_id = e.space_id and g.product_id = e.product_id
                        and g.rsv_type_id = e.rsv_type_id
   ),
   -- 연속된 예약 시간을 하나의 예약 건으로 본다. 건당 추가금을 몇 번 붙일지의 근거다.
   -- 서로 다른 사람의 인접 예약은 하나로 합쳐져 상한이 낮게 잡힌다(보수적).
   marked as (
     select f.*,
            (f.booked and not coalesce(f.dummy, false)) as sold,
            lag(f.hour) over w                          as prev_hour,
            lag(f.booked and not coalesce(f.dummy, false)) over w as prev_sold
       from flagged f
       window w as (partition by f.space_id, f.product_id, f.rsv_type_id, f.target_date
                    order by f.hour)
   ),
   blocked as (
     select m.*,
            (m.sold and (m.prev_hour is null or m.prev_hour <> m.hour - 1
                         or not coalesce(m.prev_sold, false))) as block_start
       from marked m
   ),
   -- 덩어리마다 번호를 매겨 [시작시각, 끝시각] 을 뽑는다. 패키지 창과 맞출 단위다.
   -- 예약된 시각만 남기고 나서 번호를 매긴다. block_start 는 예약된 행에서만 참이라
   -- 안 팔린 행은 누적합에 0을 더할 뿐이고, 먼저 걸러도 번호가 같다.
   -- 1,320만 행 위에서 윈도우를 돌리면 40분이 넘는다. 걸러내면 220만 행이다.
   numbered as (
     select b.space_id, b.product_id, b.rsv_type_id, b.observed_date, b.target_date,
            b.lead_days, b.hour, b.floor_amt,
            sum(case when b.block_start then 1 else 0 end) over (
              partition by b.space_id, b.product_id, b.rsv_type_id, b.target_date
              order by b.hour rows unbounded preceding) as blk
       from blocked b
      where b.sold
   ),
   blk_agg as (
     select space_id, product_id, rsv_type_id, observed_date, target_date, lead_days, blk,
            min(hour) as h0, max(hour) as h1, sum(floor_amt) as blk_floor
       from numbered
      group by space_id, product_id, rsv_type_id, observed_date, target_date, lead_days, blk
   ),
   -- 패키지 가격표. 같은 구간을 시간제 합계보다 싸게 파는 창이다.
   -- 자정을 넘는 창(shour >= ehour)은 하루 단위 덩어리와 맞출 수 없어 뺀다.
   -- 1인당 과금 패키지면 기본가가 1인 단가라 최소 인원을 곱해야 하한이 된다.
   pkg as (
     select p.space_id, p.product_id, p.target_date, p.shour, p.ehour,
            min(case when coalesce(g.per_person, false) then p.price * g.min_guest
                     else p.price end) as pkg_floor
       from booking_package p
       left join guest g on g.space_id = p.space_id and g.product_id = p.product_id
                        and g.rsv_type_id = p.rsv_type_id
      where p.observed_date = $1 and p.shour < p.ehour and p.price > 0
      group by p.space_id, p.product_id, p.target_date, p.shour, p.ehour
   ),
   -- 예약 덩어리가 패키지 창과 정확히 일치하면 그 덩어리는 패키지로 팔렸을 수 있다.
   -- 어느 쪽으로 팔렸는지는 관측되지 않으므로 하한에는 싼 값(패키지가)을 쓴다.
   -- 상한(ceil_amt 합계)은 시간제로 팔린 경우라 그대로 둔다.
   -- 일치하지 않는 덩어리는 패키지로 살 수 없는 구간이라 손대지 않는다.
   pkg_adj as (
     select a.space_id, a.observed_date, a.lead_days,
            a.blk_floor - k.pkg_floor as cut
       from blk_agg a
       join pkg k on k.space_id = a.space_id and k.product_id = a.product_id
                 and k.target_date = a.target_date
                 and k.shour = a.h0 and k.ehour = a.h1 + 1
      where k.pkg_floor < a.blk_floor
   ),
   adj as (
     select space_id, observed_date,
            coalesce(sum(cut) filter (where lead_days <= $2), 0) as cut_short,
            coalesce(sum(cut), 0)                                as cut_all,
            count(*)::int                                        as n_pkg_blocks
       from pkg_adj group by space_id, observed_date
   ),
   agg as (
     select space_id, observed_date,
       count(distinct target_date) filter (where lead_days <= $2 and not coalesce(dummy, false)) as short_days,
       count(*) filter (where lead_days <= $2 and not coalesce(dummy, false))                    as short_open_h,
       count(*) filter (where lead_days <= $2 and sold)                                          as short_booked_h,
       coalesce(sum(floor_amt) filter (where lead_days <= $2 and sold), 0)                       as short_rev,
       coalesce(sum(ceil_amt)  filter (where lead_days <= $2 and sold), 0)
         + coalesce(sum(block_add) filter (where lead_days <= $2 and block_start), 0)            as short_rev_ceil,
       count(distinct target_date) filter (where not coalesce(dummy, false))                     as all_days,
       count(*) filter (where not coalesce(dummy, false))                                        as all_open_h,
       count(*) filter (where sold)                                                              as all_booked_h,
       coalesce(sum(floor_amt) filter (where sold), 0)                                           as all_rev,
       coalesce(sum(ceil_amt)  filter (where sold), 0)
         + coalesce(sum(block_add) filter (where block_start), 0)                                as all_rev_ceil,
       coalesce(sum(floor_amt) filter (where not coalesce(dummy, false)), 0)                     as max_rev,
       avg(floor_amt) filter (where sold)                                                        as adr,
       count(*) filter (where booked and coalesce(dummy, false))                                 as dummy_h,
       coalesce(sum(price) filter (where booked and coalesce(dummy, false)), 0)                  as dummy_rev,
       count(*) filter (where block_start)                                                       as n_blocks
       from blocked group by space_id, observed_date
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
  (pax.wrap ? ` (자정을 넘는 창 ${pax.wrap}행은 제외)` : '') + '\n' +
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

c.release();
await db.end();
