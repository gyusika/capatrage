/**
 * 단계별 진행 상황을 pipeline_run 에 남긴다.
 *
 * 수집은 하루 5시간짜리 배치라, 도는 동안 화면이 볼 수 있는 것이 아무것도 없었다.
 * 콘솔에 찍던 ETA 를 DB 로 옮겨 화면이 같은 것을 보게 한다.
 *
 * 원칙 하나: 이 기록이 수집을 방해하면 안 된다. DATABASE_URL 이 없거나 쓰기가
 * 실패해도 조용히 넘어간다 — 진행 표시 때문에 관측을 놓치는 것이 훨씬 손해다.
 *
 * 쓰기는 5초에 한 번으로 묶는다. 크롤은 초당 3건이 돌아 매 건 쓰면 DB 에
 * 초당 3회 UPDATE 가 간다. 화면은 5초 해상도면 충분하다.
 */
import pg from 'pg';

const FLUSH_MS = Number(process.env.PROGRESS_FLUSH_MS ?? 5000);

/** 화면에 이 순서로 늘어놓는다. 파이프라인 실행 순서와 같다. */
export const STAGE_SEQ = {
  sitemap: 1, crawl: 2, load: 3, booking: 4,
  load_booking: 5, fill: 6, revenue: 7, settled: 8,
};

const noop = {
  set() {}, note() {}, async ok() {}, async fail() {},
};

/**
 * @param {string} name  STAGE_SEQ 의 키
 * @param {string} date  관측일 (RUN_DATE)
 */
export function stage(name, date, { total = null, note = null, base = 0 } = {}) {
  if (!process.env.DATABASE_URL || process.env.PROGRESS_OFF) return noop;

  const seq = STAGE_SEQ[name] ?? 99;
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  let cur = { done: base, total, fail_n: 0, note };
  let ready = false, closed = false;

  const run = async (sql, params) => {
    try {
      if (!ready) { await client.connect(); ready = true; }
      await client.query(sql, params);
    } catch {
      /* 진행 표시는 실패해도 수집을 세우지 않는다 */
    }
  };

  const flush = () =>
    run(
      `insert into pipeline_run (run_date, stage, seq, status, done, total, fail_n, note, base)
       values ($1,$2,$3,'running',$4,$5,$6,$7,$8)
       on conflict (run_date, stage) do update set
         status='running', done=excluded.done, total=excluded.total,
         fail_n=excluded.fail_n, note=excluded.note, base=excluded.base, updated_at=now(),
         -- 재시도로 같은 단계를 다시 시작하면 시계도 다시 잰다
         started_at=case when pipeline_run.status<>'running' then now()
                         else pipeline_run.started_at end,
         err=null`,
      [date, name, seq, cur.done, cur.total, cur.fail_n, cur.note, base]
    );

  const finish = (status, err) =>
    run(
      `insert into pipeline_run (run_date, stage, seq, status, done, total, fail_n, note, err)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (run_date, stage) do update set
         status=excluded.status, done=excluded.done, total=excluded.total,
         fail_n=excluded.fail_n, note=excluded.note, err=excluded.err, updated_at=now()`,
      [date, name, seq, status, cur.done, cur.total, cur.fail_n, cur.note, err ?? null]
    );

  flush();
  // 값이 안 변해도 매번 쓴다. updated_at 이 곧 심장박동이라, 이게 멈추면 화면이
  // "중단됨"으로 읽는다. 매출 집계는 한 방 쿼리가 수십 분 도는 동안 진행이
  // 하나도 안 움직이므로, 갱신이 있을 때만 쓰면 살아 있는데도 죽은 걸로 보인다.
  // unref: 이 타이머 때문에 스크립트가 안 끝나면 안 된다
  const timer = setInterval(() => { if (!closed) flush(); }, FLUSH_MS);
  timer.unref?.();

  const close = async (status, err) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    await finish(status, err);
    try { await client.end(); } catch { /* 이미 닫혔으면 그만 */ }
  };

  // 스크립트가 예외로 죽어도 '진행 중'인 채로 남지 않게 한다.
  // 남으면 화면이 영원히 "도는 중"으로 보인다.
  const onCrash = async (e) => {
    await close('fail', String(e?.stack ?? e).slice(0, 2000));
    process.exit(1);
  };
  process.once('uncaughtException', onCrash);
  process.once('unhandledRejection', onCrash);

  // 잡 취소·타임아웃은 예외가 아니라 신호로 온다. 이게 없으면 CI 가 6시간
  // 상한에서 잘렸을 때 화면에 영원히 "진행 중"으로 남는다.
  for (const sig of ['SIGTERM', 'SIGINT'])
    process.once(sig, async () => {
      await close('fail', `${sig} 로 중단됨 (잡 취소 또는 시간 초과)`);
      process.exit(130);
    });

  return {
    /** 진행 갱신. 실제 쓰기는 5초에 한 번으로 묶인다. */
    set(done, { total: t, fail: f, note: n } = {}) {
      cur.done = done;
      if (t != null) cur.total = t;
      if (f != null) cur.fail_n = f;
      if (n != null) cur.note = n;
    },
    /** 지금 뭘 하고 있는지만 바꾼다. 건수 없는 단계에서 쓴다. */
    note(n) { cur.note = n; flush(); },
    async ok(n) { if (n) cur.note = n; await close('ok'); },
    async fail(e) { await close('fail', String(e?.stack ?? e).slice(0, 2000)); },
  };
}
