/**
 * 파생 테이블이 빠진 관측일을 찾아 다시 계산한다.
 *
 * 왜 필요한가: 수집(booking_day)은 성공했는데 집계가 죽는 일이 실제로 있었다.
 * 09-06·09-07 관측분이 statement timeout 으로 죽어 space_revenue 가 열흘 넘게
 * 08-26 에 멈춰 있었고, 화면은 그동안 8월 값을 보여줬다. 사람이 알아채고
 * 다시 돌리기 전까지 아무 일도 일어나지 않는다는 게 문제였다.
 *
 * 그래서 매 실행 끝에 이걸 돈다. 오늘 것이 잘 됐으면 할 일이 없고,
 * 어제 것이 빠졌으면 오늘 자동으로 메운다.
 *
 * 수집(booking_day)은 여기서 손대지 않는다. 지나간 날짜의 달력은 API 가 주지
 * 않으므로 되받을 방법이 없다. 메울 수 있는 건 DB 만 읽어 만드는 파생값뿐이다.
 */
import { spawn } from 'node:child_process';
import { pool } from './lib/db.js';

/** 최근 것부터 이만큼만 메운다. 밀린 게 많아도 CI 한 판을 넘기지 않게. */
const MAX_DAYS = Number(process.env.BACKFILL_MAX_DAYS ?? 3);
/** settled 는 as_of 하나만 쓰므로 최신 관측일만 낸다. 과거 as_of 는 화면이 안 본다. */
const db = pool();
const c = await db.connect();

const { rows } = await c.query(`
  with obs as (select distinct observed_date d from booking_day),
       fl  as (select distinct observed_date d from booking_space_fill),
       rv  as (select distinct observed_date d from space_revenue),
       st  as (select distinct as_of d from space_settled)
  select obs.d::text                         as day,
         (fl.d is null)                      as need_fill,
         (rv.d is null)                      as need_revenue,
         (st.d is null and obs.d = (select max(observed_date) from booking_day)) as need_settled
    from obs
    left join fl on fl.d = obs.d
    left join rv on rv.d = obs.d
    left join st on st.d = obs.d
   order by obs.d desc`);

c.release();
await db.end();

const todo = rows
  .filter((r) => r.need_fill || r.need_revenue || r.need_settled)
  .slice(0, MAX_DAYS);

if (!todo.length) {
  console.log('메울 것이 없다. 모든 관측일에 파생값이 있다.');
  process.exit(0);
}

console.log(
  `밀린 관측일 ${todo.length}일:\n` +
  todo.map((r) => `  ${r.day} — ${[
    r.need_fill && '예약률', r.need_revenue && '매출 환산', r.need_settled && '매출 실측',
  ].filter(Boolean).join(', ')}`).join('\n')
);

const run = (script, date) =>
  new Promise((resolve) => {
    console.log(`\n▶ ${script} (관측일 ${date})`);
    const p = spawn(process.execPath, ['--env-file-if-exists=.env', script], {
      stdio: 'inherit',
      env: { ...process.env, LOAD_DATE: date, RUN_DATE: date },
    });
    p.on('close', (code) => {
      if (code !== 0) console.error(`✗ ${script} (${date}) 실패: exit ${code}`);
      resolve(code === 0);
    });
  });

// 오래된 날짜부터 메운다. fill 이 있어야 revenue 가 의미를 갖는 순서 의존이 있다.
let failed = 0;
for (const r of [...todo].reverse()) {
  if (r.need_fill && !(await run('src/compute_fill.js', r.day))) { failed++; continue; }
  if (r.need_revenue && !(await run('src/compute_revenue.js', r.day))) failed++;
  if (r.need_settled && !(await run('src/compute_settled.js', r.day))) failed++;
}

console.log(failed ? `\n${failed}건이 여전히 실패했다.` : '\n밀린 것을 모두 메웠다.');
process.exit(failed ? 1 : 0);
