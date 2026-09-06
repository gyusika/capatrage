// 예약 수집 결과(slots.jsonl.gz)를 Postgres 로 적재한다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { pool, insertBatch } from './lib/db.js';
import { today } from './lib/util.js';

const date = process.env.LOAD_DATE ?? today();
const dir = path.join('data', 'booking', date);

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
for await (const line of rl) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  if (r.d < r.observed) { skippedPast++; continue; }
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

const s = await client.query(
  `select count(distinct space_id) spaces, count(*) rows,
          min(target_date) from_d, max(target_date) to_d,
          sum(n_booked) booked, sum(n_slots) slots
     from booking_day where observed_date = $1`, [date]);
const r0 = s.rows[0];
console.log(`공간 ${r0.spaces}곳 | ${r0.from_d} ~ ${r0.to_d} | ` +
  `예약 ${r0.booked}시간 / 전체 ${r0.slots}시간 = ${(r0.booked/r0.slots*100).toFixed(1)}%`);

client.release();
await db.end();
