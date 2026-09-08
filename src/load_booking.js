// 예약 수집 결과(slots.jsonl.gz)를 Postgres 로 적재한다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { pool, insertBatch } from './lib/db.js';
import { today } from './lib/util.js';
import { stage } from './lib/progress.js';

const date = process.env.LOAD_DATE ?? today();
const dir = path.join('data', 'booking', date);

const P = stage('load_booking', date, { total: 3, note: 'slots.jsonl.gz 읽는 중' });

const db = pool();
const client = await db.connect();

// ── 휴무 정보 ────────────────────────────────────────────────────
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'space_meta.json'), 'utf8'));
const hourRows = Object.entries(meta).map(([id, m]) => [
  Number(id), date,
  JSON.stringify(m.break_times ?? []),
  JSON.stringify(m.break_days ?? []),
  JSON.stringify(m.break_holidays ?? []),
]);
await insertBatch(
  client, 'space_hours',
  ['space_id', 'observed_date', 'break_times', 'break_days', 'break_holidays'],
  hourRows,
  `on conflict (space_id) do update set observed_date=excluded.observed_date,
     break_times=excluded.break_times, break_days=excluded.break_days,
     break_holidays=excluded.break_holidays`
);
console.log(`space_hours: ${hourRows.length}건`);
P.set(1, { note: `space_hours ${hourRows.length}건` });

// ── 예약 현황 ────────────────────────────────────────────────────
const rows = [];
let skippedPast = 0;
const rl = readline.createInterface({
  input: fs
    .createReadStream(path.join(dir, 'slots.jsonl.gz'))
    .pipe(zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })),
  crlfDelay: Infinity,
});

// 같은 (공간,상품,타입,관측일,대상일)이 두 달치 응답에 겹쳐 들어올 수 있다.
// 두 번째 것을 버리지 않고 마지막 값으로 덮되, 배치 안에서 키 충돌이 나지 않게 먼저 합친다.
const seen = new Map();
// 패키지는 같은 파일에 kind:'pkg' 로 섞여 들어온다. 한 행 = (상품, PKG타입, 패키지, 대상일).
const seenPkg = new Map();
for await (const line of rl) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  if (r.d < r.observed) { skippedPast++; continue; }
  if (r.kind === 'pkg') {
    seenPkg.set(
      `${r.space_id}|${r.product_id}|${r.rsv_type_id}|${r.package_id}|${r.observed}|${r.d}`, r
    );
    continue;
  }
  const k = `${r.space_id}|${r.product_id}|${r.rsv_type_id}|${r.observed}|${r.d}`;
  seen.set(k, r);
}
for (const r of seen.values()) {
  // 시간별 가격 배열. null 은 그 시각에 가격이 없다는 뜻(휴무 등).
  const hp = Array.isArray(r.hp)
    ? `{${r.hp.map((v) => (v == null ? 'NULL' : v)).join(',')}}`
    : null;
  rows.push([
    r.space_id, r.product_id, r.rsv_type_id, r.observed, r.d,
    r.wday ?? null, r.hday === 'Y',
    r.n_slots, `{${r.booked.join(',')}}`, r.booked.length, r.price ?? null, hp,
  ]);
}

const n = await insertBatch(
  client, 'booking_day',
  ['space_id','product_id','rsv_type_id','observed_date','target_date',
   'wday','is_holiday','n_slots','booked_hours','n_booked','price','hour_prices'],
  rows,
  `on conflict (space_id, product_id, rsv_type_id, observed_date, target_date) do update set
     n_slots=excluded.n_slots, booked_hours=excluded.booked_hours,
     n_booked=excluded.n_booked, price=excluded.price,
     hour_prices=excluded.hour_prices`,
  400
);
console.log(`booking_day: ${n}건 적재 (과거일 제외 ${skippedPast}건)`);
P.set(2, { note: `booking_day ${n.toLocaleString('ko-KR')}건 적재` });

// ── 패키지 가격표 ────────────────────────────────────────────────
// 같은 시간을 시간제보다 싸게 파는 창이다. 매출 하한이 여기서 나온다.
const pkgRows = [];
for (const r of seenPkg.values())
  pkgRows.push([
    r.space_id, r.product_id, r.rsv_type_id, r.package_id, r.observed, r.d,
    r.name ?? null, r.shour, r.ehour, r.price ?? null, r.available === true,
  ]);

if (pkgRows.length) {
  const np = await insertBatch(
    client, 'booking_package',
    ['space_id','product_id','rsv_type_id','package_id','observed_date','target_date',
     'name','shour','ehour','price','available'],
    pkgRows,
    `on conflict (space_id, product_id, rsv_type_id, package_id, observed_date, target_date)
     do update set name=excluded.name, shour=excluded.shour, ehour=excluded.ehour,
       price=excluded.price, available=excluded.available`,
    400
  );
  const wrap = pkgRows.filter((r) => r[7] >= r[8]).length;
  console.log(`booking_package: ${np}건 적재 (자정을 넘는 창 ${wrap}건 — 다음 날 새벽과 짝지어 맞춘다)`);
} else {
  console.log('booking_package: 0건 (이번 수집분에 패키지가 없다)');
}

const s = await client.query(
  `select count(distinct space_id) spaces, count(*) rows,
          min(target_date) from_d, max(target_date) to_d,
          sum(n_booked) booked, sum(n_slots) slots
     from booking_day where observed_date = $1`, [date]);
const r0 = s.rows[0];
console.log(`공간 ${r0.spaces}곳 | ${r0.from_d} ~ ${r0.to_d} | ` +
  `예약 ${r0.booked}시간 / 전체 ${r0.slots}시간 = ${(r0.booked/r0.slots*100).toFixed(1)}%`);

P.set(3);
await P.ok(`공간 ${r0.spaces}곳 · 일자 ${Number(r0.rows).toLocaleString('ko-KR')}건`);

client.release();
await db.end();
