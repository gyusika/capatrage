// 적재 전 sanity check: 지금까지 받은 스냅샷으로 분류/vintage/가격이 말이 되는지 본다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { classify, splitAddr } from '../src/lib/classify.js';
import { today } from '../src/lib/util.js';

const date = today();
const sm = fs.readFileSync(path.join('data','sitemap',date,'spaces.jsonl'),'utf8')
  .trim().split('\n').map(l=>JSON.parse(l)).sort((a,b)=>a.space_id-b.space_id);
const vintage = new Map();
let sfx = '9999-99-99';
for (let i=sm.length-1;i>=0;i--){ if(sm[i].lastmod<sfx) sfx=sm[i].lastmod; vintage.set(sm[i].space_id, sfx); }

const cat = {}, sido = {}, rows = [];
const rl = readline.createInterface({
  input: fs.createReadStream(path.join('data','snapshots',date,'spaces.jsonl.gz')).pipe(zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })),
  crlfDelay: Infinity });

for await (const line of rl) {
  if(!line.trim()) continue;
  let rec; try { rec = JSON.parse(line); } catch { continue; }  // 마지막 줄이 잘렸을 수 있다
  if(!rec.detail) continue;
  const d=rec.detail, info=d.info??{}, loc=d.location??{};
  const tags=(d.tags??[]).map(t=>t.tag);
  const prods=d.products??[];
  const c=classify({name:info.name??'',subTitle:info.sub_title??'',tags,
    productNames:prods.map(p=>p.info?.name??''),desc:info.desc??''});
  cat[c]=(cat[c]||0)+1;
  const a=splitAddr(loc.addr); sido[a.sido]=(sido[a.sido]||0)+1;
  const hourly=prods.filter(p=>p.info?.RSV_TP_CD==='TIME'&&p.info?.price>0).map(p=>p.info.price);
  const v=vintage.get(rec.id);
  const months=v? Math.max(1, Math.round((Date.now()-new Date(v))/2.63e9)) : null;
  rows.push({id:rec.id, cat:c, sigungu:a.sigungu, v, months,
    reviews:d.reviews?.page?.total??0,
    rpm: months? +( (d.reviews?.page?.total??0)/months ).toFixed(2) : null,
    price: hourly.length? hourly.sort((x,y)=>x-y)[hourly.length>>1] : null,
    pyeong: prods.reduce((s,p)=>s+(Number(p.info?.area_size_pyeong)||0),0)||null});
}

console.log(`\n표본 ${rows.length}건`);
console.log('\n[업종 분포]');
Object.entries(cat).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>
  console.log(`  ${k.padEnd(8)} ${String(v).padStart(5)}  ${(v/rows.length*100).toFixed(1)}%`));
console.log('\n[시도 분포 상위 8]');
Object.entries(sido).sort((a,b)=>b[1]-a[1]).slice(0,8).forEach(([k,v])=>
  console.log(`  ${String(k).padEnd(10)} ${v}`));

console.log('\n[업종별 median: 개월수 / 누적리뷰 / 월리뷰 / 시간당가격 / 평수]');
const med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[s.length>>1];};
for (const c of Object.keys(cat).sort()){
  const r=rows.filter(x=>x.cat===c);
  console.log(`  ${c.padEnd(8)} n=${String(r.length).padStart(4)} ` +
    `${String(med(r.map(x=>x.months).filter(Boolean))).padStart(4)}개월 ` +
    `리뷰 ${String(med(r.map(x=>x.reviews))).padStart(4)} ` +
    `월 ${String(med(r.map(x=>x.rpm).filter(v=>v!=null))).padStart(5)} ` +
    `${String(med(r.map(x=>x.price).filter(Boolean))).padStart(7)}원 ` +
    `${String(med(r.map(x=>x.pyeong).filter(Boolean))).padStart(5)}평`);
}
console.log('\n[vintage 추정 검증: id 구간별 추정 개업월]');
for(let lo=0; lo<82000; lo+=10000){
  const r=rows.filter(x=>x.id>=lo&&x.id<lo+10000).map(x=>x.v).filter(Boolean).sort();
  if(r.length) console.log(`  id ${String(lo).padStart(5)}~${lo+9999}: ${r[0]} ~ ${r[r.length-1]} (n=${r.length})`);
}
