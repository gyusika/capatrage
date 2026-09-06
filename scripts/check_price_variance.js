// 시간대별·요일별로 가격이 다른지 확인한다.
// 다르면 매출 추산에 시간별 가격이 필요하므로 재수집해야 한다.
import fs from 'node:fs';
import path from 'node:path';
import { today, sleep } from '../src/lib/util.js';

const API = process.env.SC_API_BASE ?? 'https://api.spacecloud.kr';
const date = today();
const jobs = JSON.parse(fs.readFileSync(path.join('data', 'booking', date, 'products.json'), 'utf8'));

// 무작위가 아니라 고정 간격으로 12개 뽑는다 (재현 가능하게)
const step = Math.floor(jobs.length / 12);
const sample = Array.from({ length: 12 }, (_, i) => jobs[i * step]).filter(Boolean);

let varyHour = 0, varyDay = 0, flat = 0;
for (const j of sample) {
  const url = `${API}/products/${j.product_id}/prices?reservation_type_id=${j.rsv_type_id}&year=${new Date().getFullYear()}&month=09`;
  const res = await fetch(url, { headers: { 'user-agent': 'capatrage-research/0.1', accept: 'application/json' } });
  if (!res.ok) { console.log(`  ${j.space_id} HTTP ${res.status}`); continue; }
  const d = await res.json();
  const days = (d.days ?? []).filter((x) => x.times?.length);
  if (!days.length) continue;

  const withinDay = new Set(days[0].times.map((t) => t.price));
  const acrossDays = new Set(days.map((x) => x.times.map((t) => t.price).join(',')));
  const label =
    withinDay.size > 1 ? '시간별 다름' : acrossDays.size > 1 ? '요일별 다름' : '균일';
  if (withinDay.size > 1) varyHour++;
  else if (acrossDays.size > 1) varyDay++;
  else flat++;
  console.log(
    `  space ${String(j.space_id).padEnd(6)} 하루 안 가격종류 ${withinDay.size} · ` +
    `날짜별 패턴 ${acrossDays.size}종 → ${label}` +
    (withinDay.size > 1 ? `  [${[...withinDay].sort((a, b) => a - b).join(', ')}]` : ` [${[...withinDay][0]}]`)
  );
  await sleep(500);
}
console.log(`\n균일 ${flat} · 요일별 다름 ${varyDay} · 시간별 다름 ${varyHour} (표본 ${sample.length})`);
