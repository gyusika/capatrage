// 실제 예약 현황 수집.
// GET {API_BASE}/products/{product_id}/prices?reservation_type_id=&year=&month=
// 한 번 호출에 약 36~43일치 시간별 available 이 온다. 익명으로 200.
//
// 이 호스트는 robots.txt 에서 크롤러에 disallow 다. 사용자가 명시적으로 승인해서 진행한다.
// 부하를 줄이려고 초당 요청을 제한하고, 상품 하나당 월 2회만 호출한다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { rateLimiter, today, sleep } from './lib/util.js';
import { parseAddr } from './lib/region.js';
import { classify } from './lib/classify.js';

const API_BASE = process.env.SC_API_BASE ?? 'https://api.spacecloud.kr';
const RPS = Number(process.env.BOOK_RPS ?? 2);
const CONC = Number(process.env.BOOK_CONCURRENCY ?? 3);
// 기본은 서울 전역. TARGET_SIGUNGU 를 주면 그 구들만.
const TARGET_SIDO = process.env.TARGET_SIDO ?? '11'; // 11 = 서울특별시 (법정동코드 앞 2자리)
const TARGETS = process.env.TARGET_SIGUNGU
  ? process.env.TARGET_SIGUNGU.split(',').map((s) => s.trim())
  : null;
const LIMIT = Number(process.env.BOOK_LIMIT ?? 0);

const date = today();
const outDir = path.join('data', 'booking', date);
fs.mkdirSync(outDir, { recursive: true });

// ── 대상 목록 만들기 ─────────────────────────────────────────────
const jobs = [];
const spaceMeta = new Map();
{
  const rl = readline.createInterface({
    input: fs
      .createReadStream(path.join('data', 'snapshots', date, 'spaces.jsonl.gz'))
      .pipe(zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r.detail) continue;
    const d = r.detail, info = d.info ?? {}, loc = d.location ?? {};
    const reg = parseAddr(loc.addr, loc.cortar_no);
    if (TARGETS ? !TARGETS.includes(reg.sigungu) : reg.sido_code !== TARGET_SIDO) continue;
    const prods = d.products ?? [];
    const cat = classify({
      name: info.name ?? '', subTitle: info.sub_title ?? '',
      tags: (d.tags ?? []).map((t) => t.tag),
      productNames: prods.map((p) => p.info?.name ?? ''), desc: info.desc ?? '',
    });
    spaceMeta.set(r.id, {
      name: info.name ?? null, sigungu: reg.sigungu, dong: reg.dong, dong_code: reg.dong_code,
      category: cat, lat: loc.latitude ? Number(loc.latitude) : null,
      lng: loc.longitude ? Number(loc.longitude) : null,
      // 휴무 정보가 있어야 "예약 불가"가 실제 예약인지 휴무인지 구분된다
      break_times: d.break_times ?? [], break_days: d.break_days ?? [],
      break_holidays: d.break_holidays ?? [],
    });
    for (const p of prods) {
      const pid = p.info?.id;
      if (!pid) continue;
      for (const rt of p.reservation_types ?? []) {
        // 예약률은 시간 단위 상품에서만 의미가 있다. DAY/PACKAGE 는 스케일이 다르다.
        if (rt.RSV_TP_CD !== 'TIME') continue;
        jobs.push({
          space_id: r.id, product_id: pid, rsv_type_id: rt.id,
          product_name: p.info?.name ?? null,
          pyeong: Number(p.info?.area_size_pyeong) || null,
          max_guest: p.info?.max_guest_capacity ?? null,
          price: rt.price ?? null,
        });
      }
    }
  }
}

// 이번 달과 다음 달을 부르면 오늘부터 약 5~6주가 덮인다
const now = new Date();
const months = [
  { year: now.getFullYear(), month: String(now.getMonth() + 1).padStart(2, '0') },
  {
    year: now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear(),
    month: String(((now.getMonth() + 1) % 12) + 1).padStart(2, '0'),
  },
];

let units = [];
for (const j of jobs) for (const m of months) units.push({ ...j, ...m });
if (LIMIT) units = units.slice(0, LIMIT);

// 재개
const donePath = path.join(outDir, 'done.txt');
const done = new Set();
if (fs.existsSync(donePath))
  for (const l of fs.readFileSync(donePath, 'utf8').split('\n')) if (l.trim()) done.add(l.trim());
const key = (u) => `${u.product_id}:${u.rsv_type_id}:${u.year}${u.month}`;
units = units.filter((u) => !done.has(key(u)));

console.log(
  `대상 ${TARGETS ? TARGETS.join(',') : '시도코드 ' + TARGET_SIDO} | ` +
  `공간 ${spaceMeta.size}곳 | 시간제 상품 ${jobs.length}개`
);
console.log(`요청 ${units.length}건 (완료 ${done.size}) | ${RPS} req/s, 동시 ${CONC}`);

fs.writeFileSync(
  path.join(outDir, 'space_meta.json'),
  JSON.stringify(Object.fromEntries(spaceMeta))
);
fs.writeFileSync(path.join(outDir, 'products.json'), JSON.stringify(jobs));

const gz = zlib.createGzip();
gz.pipe(fs.createWriteStream(path.join(outDir, 'slots.jsonl.gz'), { flags: 'a' }));
const doneOut = fs.createWriteStream(donePath, { flags: 'a' });

const gate = rateLimiter(RPS);
let cursor = 0, ok = 0, fail = 0, slotDays = 0, sinceFlush = 0;
const started = Date.now();

const writeGz = async (line) => {
  await new Promise((r) => (gz.write(line) ? r() : gz.once('drain', r)));
  if (++sinceFlush >= 50) {
    sinceFlush = 0;
    await new Promise((r) => gz.flush(zlib.constants.Z_SYNC_FLUSH, r));
  }
};

async function fetchJson(url, retries = 3) {
  let last;
  for (let a = 0; a <= retries; a++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'capatrage-research/0.1', accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (a < retries) await sleep(1000 * 2 ** a);
    }
  }
  throw last;
}

async function worker() {
  while (cursor < units.length) {
    const u = units[cursor++];
    await gate();
    const url =
      `${API_BASE}/products/${u.product_id}/prices` +
      `?reservation_type_id=${u.rsv_type_id}&year=${u.year}&month=${u.month}`;
    try {
      const d = await fetchJson(url);
      for (const day of d.days ?? []) {
        if (!day.times?.length) continue; // 과거 날짜는 times 가 없다
        const booked = day.times.filter((t) => !t.available).map((t) => t.hour);
        // 표본 12개 중 5개가 시간대별로 가격이 달랐다(최대 5배). 하루 가격 하나로는 매출이 틀어진다.
        const hp = Array.from({ length: 24 }, (_, h) => {
          const t = day.times.find((x) => x.hour === h);
          return t?.price ?? null;
        });
        await writeGz(
          JSON.stringify({
            space_id: u.space_id, product_id: u.product_id, rsv_type_id: u.rsv_type_id,
            observed: date,
            d: `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`,
            wday: day.wday, hday: day.hday,
            n_slots: day.times.length, booked, hp,
            price: day.times[0]?.price ?? null,
          }) + '\n'
        );
        slotDays++;
      }
      doneOut.write(key(u) + '\n');
      ok++;
    } catch (e) {
      fail++;
      fs.appendFileSync(path.join(outDir, 'errors.log'), `${key(u)}\t${e.message}\n`);
    }
    const n = ok + fail;
    if (n % 200 === 0) {
      const el = (Date.now() - started) / 1000;
      console.log(
        `[${n}/${units.length}] ok=${ok} fail=${fail} 일자레코드=${slotDays} ` +
          `${(n / el).toFixed(1)}/s ETA ${Math.round((units.length - n) / (n / el) / 60)}분`
      );
    }
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
await new Promise((r) => gz.end(r));
doneOut.end();
console.log(`완료: ok=${ok} fail=${fail} 일자레코드=${slotDays} -> ${outDir}/slots.jsonl.gz`);
