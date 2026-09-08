/**
 * 매출 계산의 공통 부분.
 *
 * compute_revenue(향후 예약 기준 환산)와 compute_settled(지나간 날짜 실측)가
 * 같은 가격 규칙을 써야 한다. 더미 가격 판정, 인원 요금 하한/상한, 패키지 보정이
 * 두 곳에서 갈라지면 두 숫자를 나란히 놓을 수 없다. 그래서 한 곳에 둔다.
 *
 * 호출자가 ex 를 정의해서 넘긴다. ex 는 아래 컬럼을 가져야 한다:
 *   space_id, product_id, rsv_type_id, observed_date, target_date, lead_days,
 *   hour, booked, price
 *
 * 호출자는 세 곳에서 집계한다. 갈래를 나눈 이유는 아래 numbered 주석에 있다.
 *   flagged  — 열려 있는 모든 시각 (분모·더미·잠재매출)
 *   numbered — 그중 팔린 시각만 (분자·매출)
 *   blk_agg  — 팔린 시각을 연속 덩어리로 묶은 것 (건당 추가금·패키지 보정)
 *
 * __SNAP__ = 가격·인원·패키지 기준으로 삼을 관측일(스냅샷 날짜).
 */
const TEMPLATE = `   -- 그 상품의 통상 단가. 더미 판정의 기준선이다.
   -- 절대 금액으로 자르면 업종별 정상 단가 차이(연습실 9천 ~ 숙박 7만)에 걸린다.
   -- ex 가 아니라 booking_day 에서 직접 뽑는다. ex 를 두 번 훑으면 2분을 넘긴다.
   base as (
     select b.space_id, b.product_id, b.rsv_type_id,
            percentile_cont(0.5) within group (order by p) as med_price
       from booking_day b, unnest(b.hour_prices) p
      where b.observed_date = __SNAP__ and p is not null and p > 0
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
      where r.snapshot_date = __SNAP__
   ),
   flagged as (
     select e.*,
            -- 통상 단가의 N배 이상이면 팔 생각이 없는 값으로 본다.
            -- 예약(분자)에서도 영업시간(분모)에서도 뺀다. 휴무와 같은 취급이다.
            (b.med_price > 0 and e.price >= b.med_price * __DUMMY__) as dummy,
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
   -- 연속된 예약 시간을 하나의 예약 건으로 본다. 건당 추가금을 몇 번 붙일지,
   -- 그리고 그 구간이 패키지 창과 맞는지의 근거다.
   -- 서로 다른 사람의 인접 예약은 하나로 합쳐져 상한이 낮게 잡힌다(보수적).
   --
   -- hour - row_number() 는 연속된 시각 안에서 값이 일정하다. 그 값이 덩어리 번호다.
   -- 안 팔린 시각을 먼저 버리고 번호를 매기는 게 핵심이다. 예전 구조는 lag 로
   -- 앞 행이 팔렸는지를 봐야 해서 열린 시각 전부(1,320만 행)를 정렬해야 했고,
   -- work_mem 이 3.5MB 라 그 정렬이 통째로 디스크로 나갔다. 팔린 행만 남기면
   -- 220만 행이고, 앞 행이 h-1 이라는 것은 h-1 이 팔렸다는 뜻이므로 판정이 같다.
   numbered as (
     select f.*,
            f.hour - row_number() over (
              partition by f.space_id, f.product_id, f.rsv_type_id, f.target_date
              order by f.hour) as blk
       from flagged f
      where f.booked and not coalesce(f.dummy, false)
   ),
   blk_agg as (
     select space_id, product_id, rsv_type_id, observed_date, target_date, lead_days, blk,
            min(hour) as h0, max(hour) as h1,
            sum(floor_amt) as blk_floor,
            -- block_add 는 상품·예약타입마다 하나로 정해진 값이라 덩어리 안에서 일정하다
            max(block_add) as block_add
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
      where p.observed_date = __SNAP__ and p.shour < p.ehour and p.price > 0
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
   ),`;

/**
 * 파라미터 번호는 호출자마다 다르다. 번호를 박아두면 두 스크립트가 같은 인자 순서를
 * 강요받고, 하나를 고치면 다른 하나가 조용히 깨진다. 그래서 자리표시자로 받는다.
 *
 * @param snap  가격·인원·패키지 기준 관측일 placeholder (예: '$1')
 * @param dummy 더미 가격 배수 placeholder (예: '$4')
 */
export function pricingCTEs(snap, dummy) {
  return TEMPLATE.replaceAll('__SNAP__', snap).replaceAll('__DUMMY__', dummy);
}
