# 수집 점검 절차 (RUNBOOK)

매일 04:00 KST 에 `.github/workflows/daily.yml` 이 돈다. 이 문서는 그게 제대로 됐는지
확인하고, 안 됐으면 고치고 다시 돌리는 절차다. 사람이 해도 되고, 클라우드 점검
routine(Claude Code, 매일 13:00·20:00 KST)이 이걸 읽고 그대로 한다.

## 1. 판정 — 무엇이 "정상"인가

`https://capatrage.vercel.app/api/pipeline` 이 오늘 KST 날짜(`run_date`)의 단계별 기록을
준다. **"잡이 success 로 끝났다"는 정상의 증거가 아니다.** 09-16 에 상세 페이지가
Nuxt 에서 Next.js 로 바뀌어 14,074건이 전부 실패했는데 잡은 success 였고, 뒤 단계가
전부 "공간 0곳"으로 완료됐다. 건수를 봐야 한다.

| 단계 | 정상 기준 (note 의 숫자) | 그보다 작으면 |
|---|---|---|
| sitemap | 공간 13,000개 이상 | sitemap.xml 형식 변경 의심 |
| crawl | done ≥ total×0.95, fail_n ≤ total×0.05, `공간 N곳 수신` N ≥ 12,000 | 상세 페이지 형식 변경 (`src/lib/nuxt.js`) |
| load | `공간 N곳` N ≥ 12,000, `상품 M개` M ≥ 8,000 | 적재 코드 필드 불일치 (`src/load.js`) |
| booking | fail_n ≤ total×0.05, `일자 N건` N ≥ 100,000 | 예약 API 변경 (`src/booking.js`) |
| load_booking | `공간 N곳` N ≥ 5,000 (서울) | |
| fill / revenue / settled | 상태 ok, `공간 N곳` N ≥ 5,000 | 집계 SQL 이 죽음 (statement timeout 등) |

- 어떤 단계가 `running` 이고 `updated_at` 이 15분 이내면 아직 도는 중이다. 손대지 말고
  다음 점검에서 본다. `running` 인데 1시간 넘게 안 움직였으면 죽은 것이다.
- `status: fail` 이면 `err` 에 스택이 2,000자까지 있다.
- 오늘 `run_date` 행이 아예 없으면 워크플로가 시작도 못 한 것이다 (Actions 자체 문제).

## 2. 원인 파악

1. `err` 와 note 를 읽는다.
2. GitHub Actions 로그: `gh run list --workflow daily.yml -L 3` → `gh run view <id> --log`.
   `gh` 인증이 없으면 건너뛴다 — `pipeline_run` 의 err 와 아래 재현으로 충분한 경우가 대부분이다.
3. 직접 재현한다. 수집기는 전부 로컬에서 단독으로 돈다 (DB 없으면 진행 기록만 생략).
   ```bash
   npm ci
   npm run sitemap                          # ~10초. data/sitemap/LATEST 를 만든다
   CRAWL_LIMIT=20 npm run crawl             # ok=20 이어야 정상
   node -e "import('./src/lib/nuxt.js').then(async ({parseSpacePage}) => {
     const h = await (await fetch('https://www.spacecloud.kr/space/36359')).text();
     console.log(JSON.stringify(parseSpacePage(h)?.detail?.products?.[0]?.info)) })"
   curl -s 'https://api.spacecloud.kr/products/92155/prices?reservation_type_id=163518&year=2026&month=9' | head -c 300
   ```
   크롤이 `처음 200건 중 … 정상 수신 0건` 으로 exit 2 면 페이지 형식이 바뀐 것이다.
   페이지를 받아 `window.__NUXT__` / `self.__next_f` / `__NEXT_DATA__` 중 뭐가 있는지,
   `"detail":{` 가 어디 들어있는지 본다.
4. DB 를 봐야 하면 Supabase 로 읽기 전용 질의만 한다. 예:
   `select * from pipeline_run where run_date = current_date order by seq;`
   `select observed_date, count(*) from booking_day group by 1 order by 1 desc limit 5;`

## 3. 고치기 — 허용 범위

고쳐도 되는 것: `src/lib/nuxt.js`, `src/crawl.js`, `src/booking.js`, `src/sitemap.js`,
`src/load.js`, `src/load_booking.js`, `src/lib/util.js` 같은 **수집·파싱 코드**, 그리고
`.github/workflows/daily.yml` 의 재시도·타임아웃.

하면 안 되는 것:
- `sql/` 의 스키마 변경, `src/compute_*.js` · `src/lib/revenue_sql.js` 의 집계 규칙 변경.
  숫자의 의미가 바뀌는 일이라 사람이 한다.
- robots 정책 밖의 경로 추가. 허용된 것은 `www.spacecloud.kr/sitemap.xml`, `/space/{id}`,
  그리고 이미 승인된 `api.spacecloud.kr/products/{id}/prices` 뿐이다. 다른 호스트·경로·
  검색 API·로그인·User-Agent 위장은 안 한다. 요청률(크롤 3, 예약 2 req/s)도 안 올린다.
- 상대 사이트 형식이 바뀌었을 때 필드 이름을 바꾸는 게 아니라 **예전 모양으로 되돌리는**
  쪽으로 고친다 (`src/lib/nuxt.js` 의 `normalizeDetail` 이 그 예). 적재 코드와 DB 는 그대로 둔다.
- 못 고치겠으면 억지로 하지 않는다. 무엇을 봤고 어디서 막혔는지 적어서 보고한다.

커밋 메시지는 이 저장소의 기존 것처럼 "무엇이 왜" 를 한국어로 쓴다. `main` 에 직접 푸시한다.

## 4. 다시 돌리기

고친 코드가 `main` 에 올라간 뒤, 그 날짜로 재실행한다. 이어받기(`done.txt`)가 있어
이미 받은 것은 다시 안 받는다.

```bash
D=$(TZ=Asia/Seoul date +%F)
gh workflow run daily.yml -f run_date=$D            # gh 가 되면 이것
git push origin main:refs/heads/rerun/$D            # 안 되면 이것 (같은 효과)
```

같은 날 두 번 걸지 않는다. `concurrency: daily` 라 어차피 겹치지 않지만, 이미 도는 게
있으면 기다린다. 전체가 5~8시간이라 재실행 결과는 다음 점검에서 본다.

## 5. 보고

문제가 없으면 아무것도 보내지 않는다. 문제가 있었으면 — 고쳤든 못 고쳤든 —
jnbinternational119@gmail.com 으로 메일 한 통:

- 제목: `[capatrage] 09-16 수집 실패 → 고치고 재실행` 처럼 날짜·상태 한 줄
- 본문: 무엇이 실패했나(숫자), 원인, 무엇을 고쳤나(커밋 해시), 재실행 걸었나, 사람이 봐야 할 것
