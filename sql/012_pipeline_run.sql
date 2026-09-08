-- ── 파이프라인 진행 상황 ──────────────────────────────────────────
--
-- 왜 필요한가: 수집은 하루 5시간짜리 배치다. 그 사이 화면은 어제 값을 보여주는데,
-- 그게 "아직 도는 중"인지 "어제 죽어서 멈춘 것"인지 구분할 방법이 없었다.
-- 실제로 09-06·09-07 관측분이 집계에서 죽어 파생 테이블이 열흘 넘게 08-26 에
-- 멈춰 있었고, 화면만 봐서는 알 수 없었다.
--
-- GitHub Actions 로그를 봐야 알 수 있는 것을 DB 에 남긴다. 단계마다 한 행이고
-- 진행 중에도 계속 갱신되므로, 화면에서 남은 시간을 낼 수 있다.
--
-- 주의: 이 테이블은 관측 데이터가 아니라 운영 기록이다. 지표 계산에 쓰지 않는다.
create table if not exists pipeline_run (
  run_date   date        not null,
  stage      text        not null,   -- sitemap|crawl|load|booking|load_booking|fill|revenue|settled
  seq        int         not null,   -- 화면 정렬 순서
  status     text        not null,   -- running|ok|fail
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done       bigint,                 -- 처리한 건수 (이어받은 몫 포함)
  base       bigint      not null default 0,  -- 시작 시점에 이미 끝나 있던 몫
  total      bigint,                 -- 전체 건수 (모르면 null)
  fail_n     bigint      not null default 0,
  note       text,                   -- 지금 뭘 하고 있는지 한 줄
  err        text,
  primary key (run_date, stage)
);

create index if not exists pipeline_run_recent on pipeline_run (run_date desc, seq);

-- 이어받기 때문에 base 가 필요하다. done 만 보면 재시도한 크롤이 "이미 90% 됐다"로
-- 보이고, 남은 시간을 done/경과시간으로 내면 실제보다 몇 배 빠르게 나온다.
-- 속도는 (done - base) / 경과시간 으로 내야 맞다.
alter table pipeline_run add column if not exists base bigint not null default 0;
