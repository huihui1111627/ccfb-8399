/** Name / identifier / address normalisation shared by import and disambiguation. */

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** Full-width -> half-width, trim, collapse whitespace inside CJK names. */
export function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

export function stripNoise(s: string): string {
  return s
    .replace(/[（(]\s*(?:身份证|证件号?|统一社会信用代码|注册号|ID)[:：]?[^）)]*[）)]/gi, '')
    .replace(/[（(]\s*\d{4,}[)）]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/** Person name key: normalised display form used for grouping, never across ID evidence. */
export function personNameKey(raw: string): string {
  let s = toHalfWidth(raw).trim();
  // strip balanced / unbalanced parenthetical suffixes, including nested ones
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/[（(][^（()）]*[)）]/g, '').replace(/[（(].*$/, '').replace(/[)）]/g, '');
  }
  s = s.replace(/[\s·•.]/g, '');
  return s;
}

/** Extract an ID fragment (masked ID string as printed) from a holder name or ID column. */
export function extractIdFragment(name: string, idColumn: string): string {
  const fromCol = idColumn.trim();
  const fromNameMatch = name.match(/[（(]\s*(?:身份证|证件号?|ID)?[:：]?\s*([0-9A-Za-z*×]{6,})[)）]/);
  const candidate = fromCol || (fromNameMatch ? fromNameMatch[1] : '');
  if (!candidate) return '';
  return normaliseIdFragment(candidate);
}

export function normaliseIdFragment(raw: string): string {
  let s = toHalfWidth(raw).toUpperCase().trim();
  s = s.replace(/[^0-9A-Z*×X-]/g, '');
  s = s.replace(/×/g, '*');
  if (!s) return '';
  // Keep structure: leading region + trailing 4 are the discriminating parts.
  return s;
}

/** Last-4 digits / characters of an ID fragment (the usual human-facing disambiguator). */
export function idTail(fragment: string): string {
  const digits = fragment.replace(/[^0-9A-Z]/g, '');
  return digits.slice(-4);
}

/** Region prefix of a resident ID (first 6 digits) if present. */
export function idRegion(fragment: string): string {
  const m = fragment.match(/^(\d{6})/);
  return m ? m[1] : '';
}

/** Comparability of two (possibly masked) IDs. */
export function idCompatibility(a: string, b: string): 'same-full' | 'same-tail' | 'conflict' | 'unknown' {
  if (!a || !b) return 'unknown';
  const na = a.replace(/[^0-9A-Z]/g, '');
  const nb = b.replace(/[^0-9A-Z]/g, '');
  if (na === nb) return 'same-full';
  // compare positionally: '*' in either acts as wildcard
  if (na.length === nb.length) {
    let conflict = false;
    for (let i = 0; i < na.length; i++) {
      const x = na[i], y = nb[i];
      if (x === '*' || y === '*') continue;
      if (x !== y) { conflict = true; break; }
    }
    if (!conflict) return 'same-full';
  }
  const ta = idTail(a), tb = idTail(b);
  if (ta && tb && ta.length === 4 && tb.length === 4) return ta === tb ? 'same-tail' : 'conflict';
  return 'unknown';
}

export function personNameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Chinese names: edit distance on characters
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  const dist = dp[a.length][b.length];
  return 1 - dist / Math.max(a.length, b.length);
}

export function companyNameKey(raw: string): string {
  let s = toHalfWidth(raw).replace(/\s+/g, '');
  s = s.replace(/[（(]/g, '(').replace(/[）)]/g, ')');
  return s;
}

/** Normalise address to district + street granularity for correlation. */
export function normaliseAddress(raw: string): string {
  let s = toHalfWidth(raw).replace(/\s+/g, '');
  s = s.replace(/(省|市|区|县|镇|街道|路|道|号|栋|层|室|楼|园|大厦|广场|中心)/g, '$1');
  return s;
}

/** Comparable address key: drop trailing unit/floor markers that change often. */
export function addressKey(raw: string): string {
  let s = normaliseAddress(raw);
  s = s.replace(/(\d+)[栋幢]?(\d+)?[层楼]?(\d+)?[室]?$/, '');
  return s;
}

export function pipelineToCompanyName(raw: string): string {
  return companyNameKey(raw).replace(/[()]/g, '');
}

export const LEGAL_SUFFIXES = [
  '股份有限公司', '有限责任公司', '有限公司', '集团有限公司', '集团', '合伙企业(有限合伙)',
  '合伙企业(普通合伙)', '有限合伙', '普通合伙', '(有限合伙)', '(普通合伙)',
];

export function stripLegalSuffix(name: string): string {
  let s = companyNameKey(name);
  for (const suffix of LEGAL_SUFFIXES) {
    if (s.endsWith(suffix) && s.length > suffix.length) return s.slice(0, -suffix.length);
  }
  return s;
}

/** City prefix like 深圳市 is optional in colloquial names. */
export function stripCityPrefix(name: string): string {
  return name.replace(/^(?:北京|上海|天津|重庆|深圳|广州|杭州|郑州|中山|香港|东莞|佛山|珠海|南京|苏州|成都|武汉)(?:市|省)?/, '');
}

/** Aggressive core name: no city prefix, no legal suffix, no brackets. */
export function coreCompanyName(name: string): string {
  let s = stripCityPrefix(companyNameKey(name));
  s = s.replace(/[()]/g, '');
  const stripped = stripLegalSuffix(s);
  return stripped;
}

export function isCompanyLikeName(raw: string): boolean {
  const s = companyNameKey(raw);
  return /(公司|企业|厂|中心|研究院|研究所|事务所|合伙|集团|银行|合作社|商行|经营部)/.test(s) &&
    !/^(股东|自然人|个人)$/.test(s);
}

export function isPersonLikeName(raw: string): boolean {
  if (isCompanyLikeName(raw)) return false;
  const s = personNameKey(raw);
  if (/^[A-Za-z][A-Za-z\s.]{2,40}$/.test(s)) return true;
  if (!/^[一-龥·•]{2,8}$/.test(s)) return false;
  // A bare Chinese word with an enterprise-ish tail is a company short name,
  // not a natural person (e.g. 星海控股 / 中原控股 / 启明汇智).
  if (/(控股|投资|资本|实业|科技|贸易|传媒|数据|咨询|管理|集团|基金|证券|银行|保险|地产|置业|生物|智能|装备|材料|能源|环保|物流|文化|教育|医疗|药业|食品)$/.test(s)) {
    return false;
  }
  return true;
}

export function roundPct(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function pctLabel(v: number, digits = 2): string {
  return (v * 100).toFixed(digits) + '%';
}

export { CN_NUM };
