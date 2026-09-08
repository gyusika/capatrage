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

  // Nested Loop 금지. 이게 매출 집계를 5시간 24분에서 2분 37초로 줄였다.
  //
  // 계획을 떠보면 원인이 보인다 — booking_day 와 booking_hour_class 를
  // (space_id, product_id, rsv_type_id) 로 조인한 결과를 플래너가 1행으로
  // 추정한다. 세 컬럼이 사실상 한 덩어리인데(상품은 공간에, 예약타입은 상품에
  // 종속) 독립으로 보고 선택도를 곱하기 때문이다. 실제로는 수백만 행이다.
  // 1행이라 믿으니 24,201행짜리 guest CTE 를 매 행마다 다시 훑는 Nested Loop 을
  // 고르고, 그게 다섯 시간이 된다.
  //
  // 확장 통계(013)로는 못 고친다. 그건 한 테이블 안의 컬럼 상관관계를 재는
  // 것이고, 여기서 틀리는 건 두 테이블 사이의 조인 선택도다 — Postgres 에는
  // 그걸 재는 통계가 없다.
  //
  // 추정이 틀린 채로 두면 계획이 불안정하다. 같은 쿼리가 09-06 에는 2분,
  // 09-08 에는 5시간이 걸렸다. 통계가 조금만 흔들려도 계획이 뒤집힌다.
  // Nested Loop 을 빼면 Hash/Merge 만 남고, 그건 추정이 틀려도 실제 행 수에
  // 비례해서만 느려진다. 배치 잡이라 최악을 없애는 쪽이 맞다.
  //
  // 웹 요청에는 절대 쓰면 안 된다. 단건 조회는 Nested Loop 이 맞는 선택이다.
  if (!process.env.KEEP_NESTLOOP) await c.query(`set enable_nestloop = off`);

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
  // SET 은 파라미터를 못 받는다. set_config 를 쓴다.
  await c.query(`select set_config('application_name', $1, false)`, [name]);
}
