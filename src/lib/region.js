// 주소는 "서울 마포구 토정로17길 11"(도로명)과 "서울특별시 강서구 가양동 449-4"(지번)이
// 섞여 있다. 시도/시군구는 두 형식 모두에서 뽑히지만 동은 지번에서만 나온다.
// 그래서 지역 키는 cortar_no(10자리 법정동코드)를 쓴다. 100% 채워져 있다.
//   앞 2자리 = 시도, 앞 5자리 = 시군구, 10자리 = 법정동

const SIDO_CANON = {
  서울: '서울특별시', 서울시: '서울특별시',
  부산: '부산광역시', 대구: '대구광역시', 인천: '인천광역시',
  광주: '광주광역시', 대전: '대전광역시', 울산: '울산광역시',
  세종: '세종특별자치시', 세종시: '세종특별자치시',
  경기: '경기도', 강원: '강원특별자치도', 강원도: '강원특별자치도',
  충북: '충청북도', 충남: '충청남도',
  전북: '전북특별자치도', 전라북도: '전북특별자치도', 전남: '전라남도',
  경북: '경상북도', 경남: '경상남도',
  제주: '제주특별자치도', 제주도: '제주특별자치도',
};

const isDoro = (addr) => /(로|길)\s*\d/.test(addr);

export function parseAddr(addr, cortarNo) {
  const out = {
    sido: null, sigungu: null, dong: null,
    sido_code: null, sigungu_code: null, dong_code: null,
  };
  if (cortarNo) {
    const c = String(cortarNo);
    out.dong_code = c;
    out.sido_code = c.slice(0, 2);
    out.sigungu_code = c.slice(0, 5);
  }
  if (!addr) return out;

  const t = addr.trim().split(/\s+/);
  out.sido = SIDO_CANON[t[0]] ?? t[0] ?? null;

  // "경기 고양시 일산동구" 처럼 시 + 구가 둘 다 오는 경우
  let rest = 2;
  out.sigungu = t[1] ?? null;
  if (t[1]?.endsWith('시') && (t[2]?.endsWith('구') || t[2]?.endsWith('군'))) {
    out.sigungu = `${t[1]} ${t[2]}`;
    rest = 3;
  }

  // 동 이름은 지번 주소에서만 신뢰할 수 있다. 도로명이면 비워두고
  // 나중에 같은 cortar_no 를 쓰는 지번 주소에서 이름을 채운다.
  if (!isDoro(addr)) {
    const cand = t[rest];
    if (cand && /[동리가]$/.test(cand)) out.dong = cand;
  }
  return out;
}

/** 지번 주소들에서 cortar_no -> 동 이름 사전을 만든다 (도로명 주소 보정용) */
export function buildDongNames(records) {
  const m = new Map();
  for (const { addr, cortarNo } of records) {
    if (!addr || !cortarNo || isDoro(addr)) continue;
    const { dong } = parseAddr(addr, cortarNo);
    if (dong && !m.has(String(cortarNo))) m.set(String(cortarNo), dong);
  }
  return m;
}
