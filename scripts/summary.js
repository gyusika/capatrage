// 서울 전역 결과 요약. 보고서 갱신용 수치를 한 번에 뽑는다.
import { pool } from '../src/lib/db.js';

const db = pool();
const c = await db.connect();
const Q = async (s, p = []) => (await c.query(s, p)).rows;
const w = (v) => (v == null ? '—' : Number(v).toLocaleString('ko-KR'));

const JOIN = `
  from space_revenue r
  join booking_space_fill f on f.space_id = r.space_id and f.observed_date = r.observed_date
  join space s on s.space_id = r.space_id
  left join space_snapshot ss on ss.space_id = r.space_id and ss.snapshot_date = r.observed_date`;
const CLEAN = `not f.is_blocked_suspect`;

// ── 전체 ─────────────────────────────────────────────────────────
const [tot] = await Q(`
  select count(*)::int n,
         count(*) filter (where ${CLEAN})::int clean,
         count(*) filter (where f.is_blocked_suspect)::int blocked,
         count(*) filter (where ${CLEAN} and r.short_booked_h > 0)::int active
  ${JOIN} where s.category <> '기타'`);
console.log(`전체 ${w(tot.n)}곳 | 정상 ${w(tot.clean)} | 차단 ${w(tot.blocked)} | ` +
  `D+1~3 예약 있음 ${w(tot.active)} (${Math.round(tot.active / tot.clean * 100)}%)`);

// ── 예약률 분포 ──────────────────────────────────────────────────
const [d] = await Q(`
  select count(*)::int n,
         count(*) filter (where r.all_booked_h = 0)::int zero,
         count(*) filter (where r.all_fill > 0 and r.all_fill < 0.02)::int a,
         count(*) filter (where r.all_fill >= 0.02 and r.all_fill < 0.05)::int b,
         count(*) filter (where r.all_fill >= 0.05 and r.all_fill < 0.10)::int cc,
         count(*) filter (where r.all_fill >= 0.10 and r.all_fill < 0.20)::int e,
         count(*) filter (where r.all_fill >= 0.20)::int g
  ${JOIN} where ${CLEAN}`);
console.log(`\n[예약률 분포 · 차단 제외 ${w(d.n)}곳]`);
for (const [k, v] of [['0% (예약 0건)', d.zero], ['0~2%', d.a], ['2~5%', d.b],
  ['5~10%', d.cc], ['10~20%', d.e], ['20%+', d.g]])
  console.log(`  ${k.padEnd(14)} ${String(w(v)).padStart(6)}곳  ${(v / d.n * 100).toFixed(1).padStart(5)}%`);

// ── 업종별 ───────────────────────────────────────────────────────
const g = await Q(`
  select s.category, count(*)::int n,
    count(*) filter (where ${CLEAN})::int clean,
    count(*) filter (where ${CLEAN} and r.short_booked_h > 0)::int active,
    round((percentile_cont(0.5) within group (
      order by case when ${CLEAN} and r.short_booked_h > 0 then r.rev_month_short end))::numeric, 0) med_act,
    round((percentile_cont(0.9) within group (
      order by case when ${CLEAN} then r.rev_month_short end))::numeric, 0) p90,
    round((percentile_cont(0.5) within group (
      order by case when ${CLEAN} then r.rev_month_max end))::numeric, 0) maxm,
    round((percentile_cont(0.5) within group (
      order by case when ${CLEAN} then r.adr end))::numeric, 0) adr
  ${JOIN} where s.category <> '기타'
  group by s.category having count(*) >= 30
  order by count(*) filter (where ${CLEAN} and r.short_booked_h > 0)::float
           / nullif(count(*) filter (where ${CLEAN}), 0) desc`);
console.log('\n[업종별]');
console.log('업종        공급  정상  활성  활성률    되는곳중앙   상위10%     잠재      시간당');
for (const x of g)
  console.log(`${x.category.padEnd(9)} ${String(x.n).padStart(4)} ${String(x.clean).padStart(5)} ` +
    `${String(x.active).padStart(5)} ${String(Math.round(x.active / x.clean * 100) + '%').padStart(6)} ` +
    `${w(x.med_act).padStart(12)} ${w(x.p90).padStart(10)} ${w(x.maxm).padStart(11)} ${w(x.adr).padStart(8)}`);

// ── 과수요 후보: 하위25%가 0원이 아닌 시장 ────────────────────────
const MKT = `
  select s.sigungu, s.eupmyeondong dong, s.category,
    count(*) filter (where ${CLEAN})::int n_clean,
    count(*) filter (where ${CLEAN} and r.short_booked_h > 0)::int n_active,
    percentile_cont(0.5) within group (order by case when ${CLEAN} then r.rev_month_short end) med,
    percentile_cont(0.25) within group (order by case when ${CLEAN} then r.rev_month_short end) p25,
    percentile_cont(0.5) within group (order by case when ${CLEAN} then r.short_fill end) fill,
    percentile_cont(0.5) within group (
      order by case when ${CLEAN} and ss.total_pyeong > 0 then r.rev_month_short / ss.total_pyeong end) rpp,
    percentile_cont(0.5) within group (order by ss.total_pyeong) py
  ${JOIN} where s.category <> '기타'
  group by s.sigungu, s.eupmyeondong, s.category
  having count(*) filter (where ${CLEAN}) >= 5`;

const t = await Q(`select * from (${MKT}) t where p25 > 0 order by p25 desc, med desc limit 15`);
console.log(`\n[하위25%가 0원이 아닌 시장 — "평범한 공급도 팔리는" 후보]`);
console.log('지역             업종      정상 활성 활성률    중앙값    하위25%  예약률   평당   면적');
for (const x of t)
  console.log(`${(x.sigungu + ' ' + (x.dong ?? '')).padEnd(15)} ${String(x.category).padEnd(8)} ` +
    `${String(x.n_clean).padStart(4)} ${String(x.n_active).padStart(4)} ` +
    `${String(Math.round(x.n_active / x.n_clean * 100) + '%').padStart(6)} ` +
    `${w(Math.round(x.med)).padStart(9)} ${w(Math.round(x.p25)).padStart(8)} ` +
    `${(x.fill * 100).toFixed(1).padStart(6)}% ${w(Math.round(x.rpp)).padStart(7)} ` +
    `${x.py == null ? '—' : Math.round(x.py) + '평'}`);

const [cnt] = await Q(`select count(*)::int n from (${MKT}) t where p25 > 0`);
const [cnt2] = await Q(`select count(*)::int n from (${MKT}) t`);
console.log(`\n하위25% > 0 인 시장: ${cnt.n}개 / 전체 ${cnt2.n}개 (공급 5곳 이상)`);

c.release();
await db.end();
