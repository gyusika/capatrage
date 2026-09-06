// 플랫폼 대분류(SPC_TP_CD)는 MEET 처럼 뭉뚱그려져 있어서
// 태그 + 상품명 + 공간명/소개에서 세부 업종을 뽑는다. 구체적인 것부터 검사한다.
const RULES = [
  ['공유주방', [/공유\s*주방/, /쿠킹\s*스튜디오/, /베이킹\s*(?:룸|스튜디오)/, /주방\s*대여/]],
  ['촬영스튜디오', [/호리존/, /렌탈\s*스튜디오/, /촬영\s*스튜디오/, /촬영\s*(?:공간|장소|스튜디오)/, /스튜디오\s*대관/, /제품\s*촬영/, /영상\s*촬영/, /화보/, /룩북/]],
  ['연습실', [/연습실/, /합주실/, /댄스\s*(?:연습|스튜디오)/, /보컬/, /무용/, /안무/, /피아노\s*연습/]],
  ['파티룸', [/파티룸/, /파티\s*공간/, /모임\s*공간/, /브라이덜/, /생일\s*파티/, /루프탑\s*파티/]],
  ['회의실', [/회의실/, /세미나/, /컨퍼런스/, /강의실/, /스터디\s*룸/, /미팅\s*룸/, /교육장/, /공유\s*오피스/]],
  ['팝업', [/팝업/, /전시\s*공간/, /갤러리\s*대관/, /쇼룸/]],
  ['녹음실', [/녹음실/, /레코딩/, /보이스\s*룸/]],
  ['스포츠', [/골프/, /필라테스/, /요가/, /클라이밍/, /탁구/, /당구/]],
  ['숙박', [/숙박/, /게스트하우스/, /독채/, /펜션/]],
];

export function classify({ name = '', subTitle = '', tags = [], productNames = [], desc = '' }) {
  // 태그와 상품명이 가장 정확하고, 소개글은 마케팅 문구가 섞여 신뢰도가 낮다.
  const strong = [name, subTitle, ...tags, ...productNames].join(' ');
  const weak = desc.slice(0, 500);
  for (const [cat, pats] of RULES) if (pats.some((p) => p.test(strong))) return cat;
  for (const [cat, pats] of RULES) if (pats.some((p) => p.test(weak))) return cat;
  return '기타';
}

/** "경기도 성남시 분당구 정자동 1-1" 처럼 시/구가 두 토큰인 경우를 처리한다. */
export function splitAddr(addr) {
  if (!addr) return { sido: null, sigungu: null, dong: null };
  const t = addr.trim().split(/\s+/);
  const sido = t[0] ?? null;
  let sigungu = t[1] ?? null;
  let rest = 2;
  if (t[1]?.endsWith('시') && t[2]?.endsWith('구')) {
    sigungu = `${t[1]} ${t[2]}`;
    rest = 3;
  }
  const dong = t[rest] ?? null;
  return { sido, sigungu, dong };
}
