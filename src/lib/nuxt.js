import vm from 'node:vm';

/**
 * 스페이스클라우드 상세 페이지에서 API 응답(detail)을 꺼낸다.
 *
 * 2026-09-15 까지는 Nuxt SSR 이라 window.__NUXT__=(function(a,b,...){return {...}})(...)
 * 안에 통째로 들어있었다. 09-16 에 Next.js(App Router)로 바뀌면서 그 스크립트가 사라졌고
 * 같은 데이터가 RSC 페이로드 — self.__next_f.push([1,"..."]) 조각들 — 안에 "detail":{...}
 * 로 들어간다. 하루치 크롤 14,074건이 전부 'nuxt payload 없음'으로 실패한 게 그 날이다.
 *
 * 두 형식을 다 읽는다. 필드 이름과 값 표기가 달라진 것은 여기서 예전 모양으로 되돌려서
 * (RSV_TP_CD, charging_per_person 'Y'/'N' 등) load.js·booking.js·DB 가 그대로 돌게 한다.
 */
export function extractNuxt(html) {
  const key = 'window.__NUXT__=';
  const i = html.indexOf(key);
  if (i === -1) return null;
  const j = html.indexOf('</script>', i);
  if (j === -1) return null;
  const expr = html.slice(i + key.length, j).replace(/;\s*$/, '');
  return vm.runInContext(`(${expr})`, vm.createContext(Object.create(null)), { timeout: 5000 });
}

/**
 * RSC 페이로드를 하나의 문자열로 잇는다. 각 조각은 JSON 문자열 리터럴이라
 * JSON.parse 로 풀면 된다. 조각 경계가 토큰 중간에 올 수 있어 반드시 이어 붙인 뒤 찾는다.
 */
function nextFlight(html) {
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  const parts = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    try { parts.push(JSON.parse(m[1])); } catch { /* 깨진 조각은 건너뛴다 */ }
  }
  return parts.length ? parts.join('') : null;
}

/** s[i] 가 '{' 일 때 짝이 맞는 '}' 까지 잘라 파싱한다. 문자열 안의 괄호는 세지 않는다. */
function balancedJson(s, i) {
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(s.slice(i, j + 1));
  }
  return null;
}

const yn = (v) => (v == null ? null : typeof v === 'boolean' ? (v ? 'Y' : 'N') : v);

/** Next 페이로드의 detail 을 Nuxt 시절 모양으로 맞춘다. */
function normalizeDetail(d) {
  if (d.info && d.info.SPC_TP_CD == null && d.info.spc_tp_cd != null) d.info.SPC_TP_CD = d.info.spc_tp_cd;
  for (const p of d.products ?? []) {
    const pi = p.info;
    if (pi) {
      if (pi.RSV_TP_CD == null && pi.rsv_tp_cd != null) pi.RSV_TP_CD = pi.rsv_tp_cd;
      pi.charging_per_person = yn(pi.charging_per_person);
    }
    for (const rt of p.reservation_types ?? []) {
      if (rt.RSV_TP_CD == null && rt.rsv_tp_cd != null) rt.RSV_TP_CD = rt.rsv_tp_cd;
      rt.charging_per_person = yn(rt.charging_per_person);
      rt.is_extra_person_price_per_hour = yn(rt.is_extra_person_price_per_hour);
    }
  }
  return d;
}

export function extractNext(html) {
  const flight = nextFlight(html);
  if (!flight) return null;
  const key = '"detail":{';
  let i = -1;
  while ((i = flight.indexOf(key, i + 1)) !== -1) {
    let d = null;
    try { d = balancedJson(flight, i + key.length - 1); } catch { continue; }
    // 같은 이름의 다른 객체(리뷰 안의 상품 상세 등)를 지나쳐 진짜 공간 상세만 받는다
    if (d?.info?.id != null && Array.isArray(d.products)) return normalizeDetail(d);
  }
  return null;
}

/** ld+json 의 LocalBusiness 블록 (전화번호 등 상세에 없는 필드가 있다) */
export function extractLocalBusiness(html) {
  const re = /application\/ld\+json"?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const d = JSON.parse(m[1]);
      if (d['@type'] === 'LocalBusiness') return d;
    } catch { /* 무시 */ }
  }
  return null;
}

export function parseSpacePage(html) {
  const detail = extractNuxt(html)?.data?.[0]?.detail ?? extractNext(html);
  if (!detail) return null;
  return { detail, localBusiness: extractLocalBusiness(html) };
}
