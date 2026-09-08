// 공간 상세 전수 크롤. robots 허용 경로(/space/{id})만 사용한다.
// 출력: data/snapshots/{date}/spaces.jsonl.gz  (id, fetched_at, status, detail, lb)
// 중단해도 done.txt 기준으로 이어서 받는다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fetchText, rateLimiter, today } from './lib/util.js';
import { parseSpacePage } from './lib/nuxt.js';
import { stage } from './lib/progress.js';

const RPS = Number(process.env.CRAWL_RPS ?? 3);
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY ?? 4);
const LIMIT = Number(process.env.CRAWL_LIMIT ?? 0); // 0 = 전수

const date = today();
const snapDir = path.join('data', 'snapshots', date);
fs.mkdirSync(snapDir, { recursive: true });

const sitemapDate = fs.readFileSync(path.join('data', 'sitemap', 'LATEST'), 'utf8').trim();
const sitemapPath = path.join('data', 'sitemap', sitemapDate, 'spaces.jsonl');
let ids = fs
  .readFileSync(sitemapPath, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l).space_id);

// 재개: 이미 받은 id 건너뛰기
const donePath = path.join(snapDir, 'done.txt');
const done = new Set();
if (fs.existsSync(donePath)) {
  const rl = readline.createInterface({ input: fs.createReadStream(donePath), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) done.add(Number(line));
}
ids = ids.filter((id) => !done.has(id));
if (LIMIT) ids = ids.slice(0, LIMIT);

console.log(
  `크롤 시작: ${ids.length}건 (이미 완료 ${done.size}건) | ${RPS} req/s, 동시 ${CONCURRENCY}`
);

// 이어받은 몫도 진행에 포함한다. 재시도로 남은 건수가 줄면 화면의 막대가
// 거꾸로 짧아 보이는데, 실제로는 앞 시도가 해놓은 일이 있기 때문이다.
const P = stage('crawl', date, {
  total: done.size + ids.length,
  base: done.size,
  note: `공간 상세 ${RPS} req/s 로 받는 중`,
});

const gz = zlib.createGzip();
const out = fs.createWriteStream(path.join(snapDir, 'spaces.jsonl.gz'), { flags: 'a' });
gz.pipe(out);
const doneOut = fs.createWriteStream(donePath, { flags: 'a' });

const gate = rateLimiter(RPS);
let cursor = 0;
let ok = 0;
let gone = 0;
let failed = 0;
const started = Date.now();

// 역압: 스트림 버퍼가 차면 drain 을 기다린다
let sinceFlush = 0;
const writeGz = async (line) => {
  await new Promise((resolve) => (gz.write(line) ? resolve() : gz.once('drain', resolve)));
  // 중단돼도 받은 만큼은 항상 읽히도록 주기적으로 flush 한다.
  // 이걸 안 하면 done.txt 는 완료인데 데이터는 버퍼에서 사라진다.
  if (++sinceFlush >= 100) {
    sinceFlush = 0;
    await new Promise((resolve) => gz.flush(zlib.constants.Z_SYNC_FLUSH, resolve));
  }
};

async function worker() {
  while (cursor < ids.length) {
    const id = ids[cursor++];
    await gate();
    try {
      const { status, text } = await fetchText(`https://www.spacecloud.kr/space/${id}`);
      if (!text) {
        gone++; // 404 = 폐업/비공개. 그 자체가 신호라 기록한다.
        await writeGz(JSON.stringify({ id, fetched_at: new Date().toISOString(), status }) + '\n');
      } else {
        const parsed = parseSpacePage(text);
        if (!parsed) throw new Error('nuxt payload 없음');
        await writeGz(
          JSON.stringify({
            id,
            fetched_at: new Date().toISOString(),
            status,
            detail: parsed.detail,
            lb: parsed.localBusiness,
          }) + '\n'
        );
        ok++;
      }
      doneOut.write(id + '\n');
    } catch (e) {
      failed++;
      fs.appendFileSync(path.join(snapDir, 'errors.log'), `${id}\t${e.message}\n`);
    }

    const n = ok + gone + failed;
    if (n % 250 === 0) {
      const el = (Date.now() - started) / 1000;
      const rate = n / el;
      const eta = Math.round((ids.length - n) / rate / 60);
      console.log(
        `[${n}/${ids.length}] ok=${ok} gone=${gone} fail=${failed} ` +
          `${rate.toFixed(1)}/s ETA ${eta}분`
      );
      P.set(done.size + n, { fail: failed, note: `공간 상세 ${rate.toFixed(1)} req/s` });
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await new Promise((r) => gz.end(r));
doneOut.end();
console.log(`완료: ok=${ok} gone=${gone} fail=${failed} -> ${snapDir}/spaces.jsonl.gz`);

P.set(done.size + ok + gone + failed, { fail: failed });
await P.ok(`공간 ${ok}곳 수신 · 폐업/비공개 ${gone}곳 · 실패 ${failed}건`);
