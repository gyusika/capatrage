/**
 * 오래 도는 집계 잡의 세션 준비.
 *
 * work_mem: 서버 기본값이 3.5MB 다. 웹 요청에는 맞지만 수백만 행 정렬·해시집계에는
 * 턱없이 모자라 전부 디스크로 나간다. 배치 연결 하나에만 올린다.
 *
 * 좀비 정리: GitHub Actions 잡이 취소돼도 Postgres 는 클라이언트가 죽은 걸 바로
 * 모른다. 다음 쓰기를 시도할 때까지 그대로 돈다 — 실제로 취소된 잡의 insert 가
 * 3시간 더 돌면서 새 실행과 CPU·work_mem 을 나눠 썼고, 그래서 45분짜리가
 * 3시간을 넘겼다. 같은 잡을 다시 돌리기 전에 앞선 것을 끊는다.
 *
 * 무엇을 끊을지는 application_name 으로 고른다. 쿼리문으로 고르면 같은 테이블에
 * 쓰는 다른 관측일의 정상 실행까지 죽인다 — 매출 집계는 한 번에 수십 분이 걸려서
 * 두 날짜가 겹쳐 도는 일이 실제로 생긴다. 같은 잡·같은 날짜만 끊는다.
 */
export async function prepBatch(c, { name } = {}) {
  await c.query(`set statement_timeout = 0`);
  await c.query(`set work_mem = '128MB'`);

  if (!name) return;
  // 먼저 앞선 것을 끊고, 그 다음에 내 이름을 단다. 순서가 바뀌면 나를 죽인다.
  const r = await c.query(
    `select pid, extract(epoch from now() - query_start)::int secs
       from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and state = 'active' and application_name = $1`, [name]);
  for (const row of r.rows) {
    await c.query(`select pg_terminate_backend($1)`, [row.pid]);
    console.log(`앞선 실행 정리: pid ${row.pid} (${row.secs}초째 돌던 중)`);
  }
  await c.query(`set application_name = $1`, [name]);
}
