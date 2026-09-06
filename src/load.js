// 스냅샷 JSONL.gz + sitemap -> Postgres 적재.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { pool, insertBatch } from './lib/db.js';
import { classify } from './lib/classify.js';
import { parseAddr, buildDongNames } from './lib/region.js';
import { today } from './lib/util.js';

const date = process.env.LOAD_DATE ?? today();
const snapDir = path.join('data', 'snapshots', date);
const smDir = path.join('data', 'sitemap', date);

// ── 1. sitemap 으로 개업 시점(vintage) 추정 ──────────────────────
// space_id 는 등록 순서와 단조증가하고 lastmod >= 등록일 이므로,
// id 내림차순 누적 최소값(suffix-min)이 등록일의 단조 상한 추정치가 된다.
const smSpaces = fs
  .readFileSync(path.join(smDir, 'spaces.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .sort((a, b) => a.space_id - b.space_id);

const vintage = new Map();
let suffixMin = '9999-99-99';
for (let i = smSpaces.length - 1; i >= 0; i--) {
  const s = smSpaces[i];
  if (s.lastmod < suffixMin) suffixMin = s.lastmod;
  vintage.set(s.space_id, suffixMin.slice(0, 7) + '-01');
}
const lastmodOf = new Map(smSpaces.map((s) => [s.space_id, s.lastmod]));

const db = pool();
const client = await db.connect();

// ── 2. 리뷰 (sitemap 이 날짜까지 준다) ───────────────────────────
const reviews = fs
  .readFileSync(path.join(smDir, 'reviews.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const rvRows = reviews.map((r) => [r.review_id, r.space_id, r.review_date, date]);
const nRv = await insertBatch(
  client,
  'review',
  ['review_id', 'space_id', 'review_date', 'first_seen'],
  rvRows,
  'on conflict (review_id) do nothing'
);
console.log(`review: ${nRv}건 처리`);

// ── 3. 공간 스냅샷 스트리밍 적재 ─────────────────────────────────
const spaceRows = [];
const snapRows = [];
const prodRows = [];
const rsvRows = [];
const tagRows = [];
let ok = 0,
  gone = 0;
const addrSeen = [];   // cortar_no -> 동이름 사전을 만들 재료

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const rl = readline.createInterface({
  input: fs.createReadStream(path.join(snapDir, 'spaces.jsonl.gz')).pipe(zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line);
  const id = rec.id;

  if (!rec.detail) {
    gone++;
    spaceRows.push([id, date, date, vintage.get(id) ?? null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, null, null, null, null,
      null, null, true, date]);
    snapRows.push([id, date, rec.status, null, null, null, null, null, null, null, null, null, null, null]);
    continue;
  }
  ok++;

  const d = rec.detail;
  const info = d.info ?? {};
  const loc = d.location ?? {};
  const prods = d.products ?? [];
  const tags = (d.tags ?? []).map((t) => t.tag);
  const prodNames = prods.map((p) => p.info?.name ?? '');
  const reg = parseAddr(loc.addr, loc.cortar_no);
  const cat = classify({
    name: info.name ?? '',
    subTitle: info.sub_title ?? '',
    tags,
    productNames: prodNames,
    desc: info.desc ?? '',
  });

  const lat = loc.latitude ? Number(loc.latitude) : null;
  const lng = loc.longitude ? Number(loc.longitude) : null;

  spaceRows.push([
    id, date, date, vintage.get(id) ?? null, info.name ?? null,
    d.host?.id ?? null, d.host?.name ?? null, rec.lb?.telephone ?? null,
    loc.addr ?? null, loc.addr_detail ?? null,
    reg.sido, reg.sigungu, reg.dong,
    reg.sido_code, reg.sigungu_code, reg.dong_code,
    loc.cortar_no ?? null, loc.floor ?? null, lat, lng,
    lat != null && lng != null ? `SRID=4326;POINT(${lng} ${lat})` : null,
    info.SPC_TP_CD ?? null, cat, false, null,
  ]);
  addrSeen.push({ addr: loc.addr, cortarNo: loc.cortar_no });

  // 시간 단위 상품의 단가만 가격 지표로 쓴다 (DAY/PACKAGE 는 스케일이 달라 섞으면 왜곡된다)
  const hourly = prods
    .filter((p) => p.info?.RSV_TP_CD === 'TIME' && p.info?.price > 0)
    .map((p) => p.info.price);
  const pyeong = prods.reduce((s, p) => s + (Number(p.info?.area_size_pyeong) || 0), 0);
  const cap = prods.reduce((s, p) => Math.max(s, Number(p.info?.max_guest_capacity) || 0), 0);
  const latestReview = d.reviews?.reviews?.[0]?.created_at ?? null;

  snapRows.push([
    id, date, rec.status,
    d.reviews?.page?.total ?? 0,
    d.reviews?.avg_rate ?? null,
    info.zzim_cnt ?? null,
    hourly.length ? Math.min(...hourly) : null,
    median(hourly),
    hourly.length ? Math.max(...hourly) : null,
    prods.length,
    pyeong || null,
    cap || null,
    JSON.stringify(d.break_days ?? []),
    latestReview ? latestReview.replace(' ', 'T') + '+09:00' : null,
  ]);

  for (const p of prods) {
    const pi = p.info;
    if (!pi?.id) continue;
    prodRows.push([
      id, pi.id, date, pi.name ?? null, pi.price ?? null, pi.RSV_TP_CD ?? null,
      pi.charging_per_person ?? null, pi.min_time_policy ?? null, pi.max_guest_capacity ?? null,
      Number(pi.area_size_pyeong) || null, Number(pi.area_size_square_meter) || null,
      pi.min_guest_policy ?? null,
    ]);
    // 인원 요금은 상품이 아니라 예약타입에 붙는다. 매출 상한을 여기서 계산한다.
    for (const rt of p.reservation_types ?? []) {
      if (!rt?.id) continue;
      rsvRows.push([
        id, pi.id, rt.id, date, rt.RSV_TP_CD ?? null, rt.price ?? null,
        rt.charging_per_person ?? pi.charging_per_person ?? null,
        rt.person_ceiling ?? null, rt.extra_person_price ?? null,
        rt.is_extra_person_price_per_hour ?? null,
      ]);
    }
  }
  for (const t of d.tags ?? []) tagRows.push([id, t.tag, t.rank ?? null]);
}

// 도로명 주소는 동 이름이 안 나오므로, 같은 법정동코드를 쓰는 지번 주소에서 빌려 채운다.
const dongNames = buildDongNames(addrSeen);
const DONG_I = 12, DONGCODE_I = 15;
let filled = 0;
for (const r of spaceRows) {
  if (!r[DONG_I] && r[DONGCODE_I] && dongNames.has(r[DONGCODE_I])) {
    r[DONG_I] = dongNames.get(r[DONGCODE_I]);
    filled++;
  }
}
console.log(`동 이름 보정: ${filled}건 (사전 ${dongNames.size}개)`);

await insertBatch(client, 'space',
  ['space_id','first_seen','last_seen','vintage_month','name','host_id','host_name','telephone',
   'addr','addr_detail','sido','sigungu','eupmyeondong','sido_code','sigungu_code','dong_code',
   'cortar_no','floor_raw','lat','lng','geom','spc_tp_cd','category','is_gone','gone_at'],
  spaceRows,
  `on conflict (space_id) do update set
     last_seen=excluded.last_seen, name=excluded.name, host_id=excluded.host_id,
     host_name=excluded.host_name, telephone=coalesce(excluded.telephone, space.telephone),
     addr=coalesce(excluded.addr, space.addr), sido=coalesce(excluded.sido, space.sido),
     sigungu=coalesce(excluded.sigungu, space.sigungu),
     eupmyeondong=coalesce(excluded.eupmyeondong, space.eupmyeondong),
     sido_code=coalesce(excluded.sido_code, space.sido_code),
     sigungu_code=coalesce(excluded.sigungu_code, space.sigungu_code),
     dong_code=coalesce(excluded.dong_code, space.dong_code),
     cortar_no=coalesce(excluded.cortar_no, space.cortar_no),
     lat=coalesce(excluded.lat, space.lat), lng=coalesce(excluded.lng, space.lng),
     geom=coalesce(excluded.geom, space.geom),
     category=coalesce(excluded.category, space.category),
     is_gone=excluded.is_gone,
     gone_at=coalesce(space.gone_at, excluded.gone_at)`);
console.log(`space: ${spaceRows.length}건 (정상 ${ok}, 폐업/비공개 ${gone})`);

await insertBatch(client, 'space_snapshot',
  ['space_id','snapshot_date','http_status','review_total','review_avg_rate','zzim_cnt',
   'min_price','median_price','max_price','n_products','total_pyeong','max_capacity',
   'break_days','latest_review_at'],
  snapRows, 'on conflict (space_id, snapshot_date) do nothing');
console.log(`space_snapshot: ${snapRows.length}건`);

await insertBatch(client, 'product_snapshot',
  ['space_id','product_id','snapshot_date','name','price','rsv_tp_cd','charging_per_person',
   'min_time_policy','max_guest_capacity','area_pyeong','area_sqm','min_guest_policy'],
  prodRows,
  // 나중에 추가한 컬럼은 do nothing 이면 기존 행에 영원히 안 채워진다
  `on conflict (space_id, product_id, snapshot_date) do update
     set min_guest_policy = excluded.min_guest_policy`);
console.log(`product_snapshot: ${prodRows.length}건`);

await insertBatch(client, 'rsv_type_snapshot',
  ['space_id','product_id','rsv_type_id','snapshot_date','rsv_tp_cd','price',
   'charging_per_person','person_ceiling','extra_person_price','extra_per_hour'],
  rsvRows, 'on conflict (space_id, product_id, rsv_type_id, snapshot_date) do nothing');
console.log(`rsv_type_snapshot: ${rsvRows.length}건`);

await insertBatch(client, 'space_tag', ['space_id','tag','rank'], tagRows,
  'on conflict (space_id, tag) do nothing');
console.log(`space_tag: ${tagRows.length}건`);

await client.query(
  `insert into crawl_run (run_date, spaces_listed, spaces_ok, spaces_gone, spaces_failed, reviews_seen)
   values ($1,$2,$3,$4,$5,$6)
   on conflict (run_date) do update set spaces_ok=excluded.spaces_ok, spaces_gone=excluded.spaces_gone,
     reviews_seen=excluded.reviews_seen, finished_at=now()`,
  [date, smSpaces.length, ok, gone, 0, reviews.length]
);

client.release();
await db.end();
console.log('적재 완료');
