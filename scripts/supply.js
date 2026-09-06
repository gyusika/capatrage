// 관측된 사실만 집계한다: 공간 수, 게시 가격, 면적. 추정·환산 없음.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { classify } from '../src/lib/classify.js';
import { parseAddr } from '../src/lib/region.js';
import { today } from '../src/lib/util.js';

const date = today();
const rows = [];
const rl = readline.createInterface({
  input: fs.createReadStream(path.join('data','snapshots',date,'spaces.jsonl.gz'))
    .pipe(zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })),
  crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  let r; try { r = JSON.parse(line); } catch { continue; }
  if (!r.detail) continue;
  const d = r.detail, info = d.info ?? {}, loc = d.location ?? {};
  const prods = d.products ?? [];
  const reg = parseAddr(loc.addr, loc.cortar_no);
  const cat = classify({ name: info.name ?? '', subTitle: info.sub_title ?? '',
    tags: (d.tags ?? []).map(t => t.tag),
    productNames: prods.map(p => p.info?.name ?? ''), desc: info.desc ?? '' });
  const hourly = prods.filter(p => p.info?.RSV_TP_CD === 'TIME' && p.info?.price > 0)
    .map(p => p.info.price).sort((a,b)=>a-b);
  rows.push({ id: r.id, sido: reg.sido, sigungu: reg.sigungu, cat,
    price: hourly.length ? hourly[hourly.length>>1] : null,
    pyeong: prods.reduce((s,p)=>s+(Number(p.info?.area_size_pyeong)||0),0) || null });
}

const med = a => { const s=a.filter(v=>v!=null).sort((x,y)=>x-y); return s.length? s[s.length>>1] : null; };
const seoul = rows.filter(r => r.sido === '서울특별시');
console.log(`전체 ${rows.length}건 중 서울 ${seoul.length}건 (${(seoul.length/rows.length*100).toFixed(1)}%)\n`);

const TARGET = ['촬영스튜디오','연습실','파티룸','회의실','공유주방'];
const byGu = {};
for (const r of seoul) {
  if (!TARGET.includes(r.cat) || !r.sigungu) continue;
  (byGu[r.sigungu] ??= {})[r.cat] = [...((byGu[r.sigungu]?.[r.cat]) ?? []), r];
}
const tot = g => TARGET.reduce((s,c)=>s+((byGu[g][c]??[]).length),0);
const gus = Object.keys(byGu).sort((a,b)=>tot(b)-tot(a));

console.log('[서울 구별 공급 수 — 대상 5개 업종]');
console.log('구'.padEnd(8) + TARGET.map(c=>c.padStart(7)).join('') + '    합계');
for (const g of gus.slice(0,15)) {
  console.log(g.padEnd(8) +
    TARGET.map(c=>String((byGu[g][c]??[]).length).padStart(7)).join('') +
    String(tot(g)).padStart(8));
}
console.log('\n[상위 5개 구 × 업종: 시간당 가격 / 면적 중앙값 (실제 게시값)]');
for (const g of gus.slice(0,5)) {
  for (const c of TARGET) {
    const r = byGu[g][c] ?? [];
    if (r.length < 5) continue;
    console.log(`  ${g.padEnd(7)} ${c.padEnd(7)} n=${String(r.length).padStart(3)}  ` +
      `${String(med(r.map(x=>x.price))).padStart(7)}원/시간  ${String(med(r.map(x=>x.pyeong))).padStart(5)}평`);
  }
}
