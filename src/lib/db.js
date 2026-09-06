import pg from 'pg';

export function pool() {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL 이 없습니다. .env 를 확인하세요.');
  return new pg.Pool({ connectionString: cs, max: 4, ssl: { rejectUnauthorized: false } });
}

/**
 * 다중행 INSERT 를 청크로 쪼개 실행한다.
 * cols: 컬럼명 배열, rows: 값 배열의 배열, conflict: 'ON CONFLICT ... ' 절
 */
export async function insertBatch(client, table, cols, rows, conflict, chunk = 500) {
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params = [];
    const tuples = slice.map((r) => {
      const ph = r.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(',')})`;
    });
    await client.query(
      `insert into ${table} (${cols.join(',')}) values ${tuples.join(',')} ${conflict}`,
      params
    );
    n += slice.length;
  }
  return n;
}
