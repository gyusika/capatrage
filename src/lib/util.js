export const UA =
  'capatrage-research/0.1 (market research crawler; respects robots.txt; contact: jnbinternational119@gmail.com)';

// 관측일. CI 는 UTC 라 새벽에 돌리면 KST 와 하루 어긋난다.
// 잡이 나뉘어도 같은 날짜를 쓰도록 RUN_DATE 로 고정할 수 있게 한다.
export const today = () => process.env.RUN_DATE ?? new Date().toISOString().slice(0, 10);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 초당 rps건을 넘지 않도록 호출 간격을 강제하는 토큰 게이트 */
export function rateLimiter(rps) {
  const interval = 1000 / rps;
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + interval;
    if (at > now) await sleep(at - now);
  };
}

export async function fetchText(url, { retries = 3, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' },
        signal: ac.signal,
      });
      if (res.status === 404 || res.status === 410) return { status: res.status, text: null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, text: await res.text() };
    } catch (e) {
      lastErr = e;
      // 429/5xx/네트워크 오류는 지수 백오프 후 재시도
      if (attempt < retries) await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 500));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}
