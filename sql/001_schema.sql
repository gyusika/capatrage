-- Capacity Arbitrage :: 스페이스클라우드 수요 패널
-- 설계 원칙: 매일 스냅샷을 append 하고 절대 덮어쓰지 않는다.
--            진짜 자산은 크롤러가 아니라 이 시계열이다.

create extension if not exists postgis;
create extension if not exists pg_trgm;

-- ── 공간 마스터 (변하지 않는 정체성) ──────────────────────────────
create table if not exists space (
  space_id        bigint primary key,
  first_seen      date not null,
  last_seen       date not null,
  -- space_id 는 등록 순서와 단조증가한다. sitemap lastmod 로 보정한 개업 추정 시점.
  vintage_month   date,
  name            text,
  host_id         text,
  host_name       text,
  telephone       text,
  addr            text,
  addr_detail     text,
  sido            text,
  sigungu         text,
  eupmyeondong    text,
  sido_code       text,           -- cortar_no 앞 2자리
  sigungu_code    text,           -- cortar_no 앞 5자리
  dong_code       text,           -- cortar_no 10자리 (법정동)
  cortar_no       text,
  floor_raw       text,
  lat             double precision,
  lng             double precision,
  geom            geography(Point, 4326),
  spc_tp_cd       text,           -- 플랫폼 대분류 (MEET 등)
  category        text,           -- 태그/상품명에서 파생한 세부 업종
  is_gone         boolean not null default false,   -- 404 = 폐업/비공개
  gone_at         date
);
create index if not exists space_geom_idx on space using gist (geom);
create index if not exists space_cat_idx  on space (category, sigungu);
create index if not exists space_vintage_idx on space (vintage_month);
create index if not exists space_dongcode_idx on space (dong_code, category);
create index if not exists space_sigungucode_idx on space (sigungu_code, category);

-- ── 일별 스냅샷 (변하는 값) ───────────────────────────────────────
-- 리뷰 누적수의 일별 증분이 곧 수요 플로우다.
create table if not exists space_snapshot (
  space_id        bigint not null references space(space_id),
  snapshot_date   date   not null,
  http_status     int,
  review_total    int,
  review_avg_rate numeric(5,4),
  zzim_cnt        int,
  min_price       int,          -- 상품 중 최저 시간당 단가
  median_price    int,
  max_price       int,
  n_products      int,
  total_pyeong    numeric(10,2),
  max_capacity    int,
  break_days      jsonb,
  latest_review_at timestamptz, -- 상세에 실린 최근 리뷰 시각 (가동 여부 판단)
  primary key (space_id, snapshot_date)
);
create index if not exists snap_date_idx on space_snapshot (snapshot_date);

-- ── 상품(=대관 단위) 스냅샷 ───────────────────────────────────────
-- Capacity 계산의 단위. 평수/정원/단가가 여기 있다.
create table if not exists product_snapshot (
  space_id        bigint not null,
  product_id      bigint not null,
  snapshot_date   date   not null,
  name            text,
  price           int,
  rsv_tp_cd       text,          -- TIME / DAY / PACKAGE
  charging_per_person text,
  min_time_policy int,
  max_guest_capacity int,
  area_pyeong     numeric(10,2),
  area_sqm        numeric(10,2),
  primary key (space_id, product_id, snapshot_date)
);

-- ── 리뷰 (sitemap 이 날짜와 함께 공짜로 준다) ─────────────────────
-- api.spacecloud.kr 은 robots 로 차단돼 있어 리뷰 API 는 쓰지 않는다.
-- sitemap 이 매일 2만 건의 (space_id, review_id, 날짜) 표본을 노출한다.
create table if not exists review (
  review_id     bigint primary key,
  space_id      bigint not null,
  review_date   date   not null,
  first_seen    date   not null
);
create index if not exists review_space_idx on review (space_id, review_date);
create index if not exists review_date_idx  on review (review_date);

-- ── 태그 ──────────────────────────────────────────────────────────
create table if not exists space_tag (
  space_id  bigint not null,
  tag       text   not null,
  rank      int,
  primary key (space_id, tag)
);

-- ── 크롤 실행 이력 ────────────────────────────────────────────────
create table if not exists crawl_run (
  run_date      date primary key,
  spaces_listed int,
  spaces_ok     int,
  spaces_gone   int,
  spaces_failed int,
  reviews_seen  int,
  finished_at   timestamptz default now()
);
