import vm from 'node:vm';

/**
 * 스페이스클라우드 상세 페이지는 Nuxt SSR이라 HTML 안에
 * window.__NUXT__=(function(a,b,...){return {...}})(...) 형태로
 * API 응답 전체가 박혀 있다. 리터럴만 들어있는 IIFE라 빈 컨텍스트에서 평가한다.
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
  const nuxt = extractNuxt(html);
  const detail = nuxt?.data?.[0]?.detail;
  if (!detail) return null;
  return { detail, localBusiness: extractLocalBusiness(html) };
}
