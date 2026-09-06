// sql 파일을 순서대로 실행한다. node --env-file=.env scripts/apply_sql.js sql/001_schema.sql ...
import fs from 'node:fs';
import { pool } from '../src/lib/db.js';

const files = process.argv.slice(2);
const db = pool();
const client = await db.connect();
for (const f of files) {
  const sql = fs.readFileSync(f, 'utf8');
  await client.query(sql);
  console.log(`적용: ${f}`);
}
client.release();
await db.end();
