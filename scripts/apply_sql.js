/**
 * 마이그레이션 적용. `npm run sql -- sql/*.sql`
 *
 * 이미 적용한 파일은 건너뛴다. 전부 다시 돌리면 안 되기 때문이다 —
 * 003 이 v_booking_market 을 create or replace 로 만들고 006 이 컬럼을 더해
 * 다시 정의하므로, 003 을 다시 돌리면 "cannot drop columns from view" 로 깨진다.
 * 순서가 있는 마이그레이션은 원래 한 번씩만 도는 것이 맞다.
 *
 * 그래서 이력을 DB 에 남긴다. CI 가 매 실행 앞에서 이걸 돌려도 새 파일만 적용되고,
 * 사람이 손으로 마이그레이션하러 오지 않아도 된다.
 *
 * 내용이 바뀐 파일은 경고만 하고 건너뛴다. 적용된 마이그레이션을 고치는 건
 * 그 자체가 실수인 경우가 대부분이라, 자동으로 다시 돌리는 쪽이 더 위험하다.
 * 정말 다시 돌리려면 FORCE_SQL=1 을 준다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pool } from '../src/lib/db.js';

const files = process.argv.slice(2);
const FORCE = !!process.env.FORCE_SQL;

const db = pool();
const client = await db.connect();

await client.query(`
  create table if not exists schema_migration (
    name       text primary key,
    sha1       text not null,
    applied_at timestamptz not null default now()
  )`);

const seen = new Map(
  (await client.query('select name, sha1 from schema_migration')).rows.map((r) => [r.name, r.sha1])
);

let applied = 0, skipped = 0;
for (const f of files) {
  const name = path.basename(f);
  const sql = fs.readFileSync(f, 'utf8');
  const sha1 = crypto.createHash('sha1').update(sql).digest('hex');
  const prev = seen.get(name);

  if (prev && !FORCE) {
    if (prev !== sha1)
      console.warn(`! ${name} 은 적용 후 내용이 바뀌었다. 건너뛴다 (다시 돌리려면 FORCE_SQL=1)`);
    skipped++;
    continue;
  }

  await client.query(sql);
  await client.query(
    `insert into schema_migration (name, sha1) values ($1,$2)
     on conflict (name) do update set sha1=excluded.sha1, applied_at=now()`,
    [name, sha1]
  );
  console.log(`적용: ${name}`);
  applied++;
}

console.log(`마이그레이션 ${applied}개 적용, ${skipped}개 건너뜀`);
client.release();
await db.end();
