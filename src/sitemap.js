// sitemap.xml 전수 파싱.
//  - 공간 14,090개 (id + lastmod=최근 갱신일)
//  - 리뷰 20,000개 (space_id + review_id + lastmod=리뷰 작성일)
// api.spacecloud.kr 은 robots에서 Googlebot 외 전면 차단이라 쓰지 않는다.
// /search* 도 disallow 이므로 열거는 오직 sitemap 으로만 한다.
import fs from 'node:fs';
import path from 'node:path';
import { fetchText, today } from './lib/util.js';
import { stage } from './lib/progress.js';

const OUT = path.join('data', 'sitemap', today());
const SITEMAP = 'https://www.spacecloud.kr/sitemap.xml';

const P = stage('sitemap', today(), { total: 1, note: 'sitemap.xml 내려받는 중' });

fs.mkdirSync(OUT, { recursive: true });
const { text } = await fetchText(SITEMAP, { timeoutMs: 180000 });
P.note('sitemap.xml 파싱 중');
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), text);

const spaces = [];
const reviews = [];

const spaceRe = /<loc>https:\/\/www\.spacecloud\.kr\/space\/(\d+)<\/loc>\s*<lastmod>([\d-]+)<\/lastmod>/g;
const reviewRe = /<loc>https:\/\/www\.spacecloud\.kr\/space\/(\d+)\/review\/(\d+)<\/loc>\s*<lastmod>([\d-]+)<\/lastmod>/g;

let m;
while ((m = spaceRe.exec(text)) !== null) spaces.push({ space_id: Number(m[1]), lastmod: m[2] });
while ((m = reviewRe.exec(text)) !== null)
  reviews.push({ space_id: Number(m[1]), review_id: Number(m[2]), review_date: m[3] });

spaces.sort((a, b) => a.space_id - b.space_id);
reviews.sort((a, b) => a.review_id - b.review_id);

const write = (name, rows) =>
  fs.writeFileSync(path.join(OUT, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
write('spaces.jsonl', spaces);
write('reviews.jsonl', reviews);

// crawl.js 가 읽는 최신 포인터
fs.writeFileSync(path.join('data', 'sitemap', 'LATEST'), today());

console.log(`공간 ${spaces.length}개 (id ${spaces[0].space_id}~${spaces.at(-1).space_id})`);
console.log(
  `리뷰 ${reviews.length}건 (${reviews[0].review_date} ~ ${reviews.at(-1).review_date}, ` +
    `review_id ${reviews[0].review_id}~${reviews.at(-1).review_id})`
);
console.log(`-> ${OUT}`);

P.set(1, { note: `공간 ${spaces.length}개 · 리뷰 ${reviews.length}건 열거` });
await P.ok();
