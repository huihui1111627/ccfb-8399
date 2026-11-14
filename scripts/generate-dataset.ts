/**
 * Generate deliberately messy 工商登记 sample files from data/seed/scenario.json.
 *
 * The application under src/ only ever sees the generated CSVs; the true entity
 * each record belongs to is written to data/truth/record_map.json for independent
 * accuracy scoring.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = join(ROOT, 'data', 'samples');
const TRUTH = join(ROOT, 'data', 'truth');
mkdirSync(SAMPLES, { recursive: true });
mkdirSync(TRUTH, { recursive: true });

interface ScenarioCompany {
  name: string; uscc: string; short: string; former: string[]; addr: string;
  legal: string; established: string; capital: number;
}
interface ScenarioPerson { name: string; idfrag: string; addr: string; }
interface Scenario {
  companies: Record<string, ScenarioCompany>;
  persons: Record<string, ScenarioPerson>;
  timeline: Record<string, Array<[string, Record<string, number>]>>;
  relations: Array<Record<string, unknown>>;
  nonEquityChanges: string[][];
  snapshotDates: Record<string, string>;
}
const S: Scenario = JSON.parse(readFileSync(join(ROOT, 'data', 'seed', 'scenario.json'), 'utf8'));

// deterministic RNG
let seed = 20260301;
function rnd(): number {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length) % arr.length];
const chance = (p: number) => rnd() < p;

function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function writeCsv(file: string, headers: string[], rows: string[][]) {
  const body = [headers, ...rows].map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
  writeFileSync(join(SAMPLES, file), body, 'utf8');
}

const personKeys = Object.keys(S.persons);
const isPerson = (k: string) => personKeys.includes(k);
// Names shared by more than one natural person: real feeds almost always carry
// an ID for these, and dropping it would make the case unresolvable.
const nameCount = new Map<string, number>();
for (const p of Object.values(S.persons)) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
const isHomonym = (k: string) => (nameCount.get(S.persons[k].name) ?? 0) > 1;
const personName = (k: string) => S.persons[k].name;
const companyName = (k: string) => S.companies[k].name;

/** Messy person name rendering. */
function messyPersonName(k: string): { name: string; id: string; note: string } {
  const p = S.persons[k];
  const base = p.name;
  const id = p.idfrag;
  const style = pick(['plain', 'plain', 'space', 'idparen', 'idparen_cn', 'trail']);
  switch (style) {
    case 'space':
      return { name: base.split('').join(' '), id, note: 'name-space' };
    case 'idparen':
      return { name: `${base}(${id})`, id: '', note: 'name-id' };
    case 'idparen_cn':
      return { name: `${base}（身份证${id}）`, id: '', note: 'name-id-cn' };
    case 'trail':
      return { name: base + ' ', id: chance(0.5) || isHomonym(k) ? id : '', note: 'trail' };
    default:
      return { name: base, id: chance(0.12) && !isHomonym(k) ? '' : id, note: 'plain' };
  }
}

/** Messy company name rendering. */
function messyCompanyName(k: string): string {
  const c = S.companies[k];
  const opts: string[] = [c.name, c.name, c.name];
  if (c.short) opts.push(c.short);
  if (c.former.length) opts.push(c.former[0]);
  if (/^(深圳|北京|上海|广州|中山|郑州|香港)/.test(c.addr)) {
    const city = c.addr.slice(0, 2);
    if (city === '深圳' || city === '北京' || city === '上海' || city === '广州' || city === '中山' || city === '郑州') {
      opts.push(city + '市' + c.name);
    }
  }
  if (c.name.includes('（')) opts.push(c.name.replace('（', '(').replace('）', ')'));
  if (chance(0.12)) opts.push(c.name.replace('有限公司', ' 有限公司'));
  return pick(opts);
}

/** Format a ratio in one of the source formats the importer must cope with. */
function fmtRatio(r: number, source: string): string {
  if (source === '企业年报') return (r * 100).toFixed(2) + '%';
  if (source === '工商公示') return r === 0 ? '0' : (r * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '%';
  return r === 0 ? '0' : String(Math.round(r * 10000) / 10000);
}
function fmtDate(d: string, source: string): string {
  if (source === '企业年报' && chance(0.35)) return d.replace(/-/g, '/');
  if (source === '第三方数据' && chance(0.2)) return d.replace(/-/g, '/');
  return d;
}

const companyRecords: Array<{ id: string; key: string; fields: string[] }> = [];
const equityRecords: Array<{ id: string; companyKey: string; holderKey: string; holderKind: 'person' | 'company'; fields: string[] }> = [];
const changeRecords: Array<{ id: string; fields: string[] }> = [];
const personRecordTruth: Record<string, string> = {};
const companyRecordTruth: Record<string, string> = {};

let crSeq = 0;
function addCompanyRecord(key: string, name: string, uscc: string, addr: string, source: string,
                          snapshot: string, includeFormer = true) {
  const c = S.companies[key];
  const id = `CR-${String(++crSeq).padStart(4, '0')}`;
  const legal = messyPersonName(c.legal).name.replace(/（.*?）|\(.*?\)/g, '');
  const status = pick(['存续', '在营', '存续', '开业']);
  const former = includeFormer ? c.former.join('；') : '';
  const short = chance(0.25) ? '' : c.short;
  companyRecords.push({
    id, key,
    fields: [id, name, uscc, chance(0.08) ? '' : addr, legal, c.established,
             String(c.capital), status, short, former, source, snapshot],
  });
  companyRecordTruth[id] = key;
}

for (const key of Object.keys(S.companies)) {
  const c = S.companies[key];
  const snapshot = '2025-12-31';
  addCompanyRecord(key, c.name, c.uscc, c.addr, '工商公示', snapshot);
  // historical alias row: former name + same USCC in about half the cases
  for (const f of c.former) {
    addCompanyRecord(key, f, chance(0.6) ? c.uscc : '', c.addr, '历史工商快照', '2019-01-01', false);
  }
  // short-name row from an annual report, often missing the code
  if (c.short) {
    addCompanyRecord(key, c.short, chance(0.3) ? c.uscc : '', c.addr, '企业年报', snapshot, false);
  }
  // third-party variant
  if (chance(0.7)) {
    addCompanyRecord(key, messyCompanyName(key), chance(0.15) ? c.uscc : '', c.addr, '第三方数据', snapshot, false);
  }
}

const positions = ['股东', '董事长', '董事', '监事', '执行董事', '执行事务合伙人', '总经理', '股东'];
let eqSeq = 0;
const timelineDatesByCompany: Record<string, string[]> = {};

for (const [companyKey, rows] of Object.entries(S.timeline)) {
  const capital = S.companies[companyKey].capital;
  timelineDatesByCompany[companyKey] = rows.map(r => r[0]);
  let prev: Record<string, number> = {};
  for (const [date, table] of rows) {
    const source = pick(['工商公示', '工商公示', '企业年报', '第三方数据']);
    for (const [holderKey, pct] of Object.entries(table)) {
      upsertEquity(companyKey, holderKey, pct, date, source, capital);
    }
    for (const holderKey of Object.keys(prev)) {
      if (!(holderKey in table)) upsertEquity(companyKey, holderKey, 0, date, source, capital);
    }
    prev = table;
  }
}

function upsertEquity(companyKey: string, holderKey: string, pct: number, date: string,
                      source: string, capital: number) {
  const id = `EQ-${String(++eqSeq).padStart(4, '0')}`;
  const coName = messyCompanyName(companyKey);
  let holderName: string;
  let idNo = '';
  let addr = '';
  let position = '';
  let holderKind: 'person' | 'company';
  if (isPerson(holderKey)) {
    holderKind = 'person';
    const m = messyPersonName(holderKey);
    holderName = m.name;
    idNo = m.id;
    addr = chance(0.9) ? S.persons[holderKey].addr : '';
    position = pick(positions);
  } else {
    holderKind = 'company';
    holderName = messyCompanyName(holderKey);
    idNo = chance(0.35) ? S.companies[holderKey].uscc : '';
    addr = chance(0.5) ? S.companies[holderKey].addr : '';
    position = '';
  }
  const subscribed = (pct * capital).toFixed(2).replace(/\.00$/, '');
  equityRecords.push({
    id, companyKey, holderKey, holderKind,
    fields: [id, coName, holderName, holderKind === 'person' ? (chance(0.2) ? pick(['自然人', '个人']) : '自然人') : pick(['企业法人', '法人', '企业']),
             idNo, subscribed, fmtRatio(pct, source), addr, position, fmtDate(date, source), source],
  });
  if (holderKind === 'person') personRecordTruth[id] = holderKey;
}

let chSeq = 0;
function addChange(companyKey: string, date: string, item: string, before: string, after: string, source = '工商公示') {
  const id = `CH-${String(++chSeq).padStart(4, '0')}`;
  const c = S.companies[companyKey];
  changeRecords.push({
    id,
    fields: [id, c.name, chance(0.9) ? c.uscc : '', fmtDate(date, source), item, before, after, source],
  });
}

// name / address / legal representative changes (drive alias linking)
for (const [date, key, item, before, after] of S.nonEquityChanges) {
  addChange(key, date, item, before, after, '工商公示');
}
// equity change summaries per company at each later timeline date
for (const [companyKey, rows] of Object.entries(S.timeline)) {
  let prev: Record<string, number> = {};
  for (const [date, table] of rows) {
    if (Object.keys(prev).length) {
      const fmt = (o: Record<string, number>) =>
        Object.entries(o).filter(([, v]) => v > 0).map(([k, v]) => `${isPerson(k) ? personName(k) : companyName(k)} ${(v * 100).toFixed(2)}%`).join('；');
      addChange(companyKey, date, '投资人（股权）变更', fmt(prev), fmt(table),
                chance(0.5) ? '企业年报' : '工商公示');
    }
    prev = table;
  }
}
// a few unrelated administrative changes for noise
addChange('ZK', '2024-11-02', '注册资本变更', '2000万元', '2500万元', '工商公示');
addChange('STAR', '2023-09-18', '注册资本变更', '8000万元', '10000万元', '工商公示');
addChange('HK', '2022-04-06', '法定代表人变更', '马骏', '马骏', '第三方数据');
addChange('BLUE', '2024-02-29', '经营范围变更', '技术开发；技术服务', '技术开发；技术服务；软件开发', '工商公示');

// shuffle equity rows a little so files are not grouped by company (but deterministic)
for (let i = equityRecords.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [equityRecords[i], equityRecords[j]] = [equityRecords[j], equityRecords[i]];
}

const companyHeaders = ['记录ID', '企业名称', '统一社会信用代码', '注册地址', '法定代表人', '成立日期',
  '注册资本(万元)', '登记状态', '简称', '曾用名', '数据来源', '快照日期'];
const equityHeaders = ['记录ID', '企业名称', '股东名称', '股东类型', '证件号码', '认缴出资额(万元)',
  '出资比例', '股东地址', '任职', '变更日期', '数据来源'];
const changeHeaders = ['变更ID', '企业名称', '统一社会信用代码', '变更日期', '变更事项', '变更前', '变更后', '数据来源'];

writeCsv('companies.csv', companyHeaders, companyRecords.map(r => r.fields));
writeCsv('holders.csv', equityHeaders, equityRecords.map(r => r.fields));
writeCsv('changes.csv', changeHeaders, changeRecords.map(r => r.fields));

// English-header clone to demonstrate configurable field mapping
writeCsv('companies_en.csv',
  ['record_id', 'company_name', 'uscc', 'address', 'legal_rep', 'established_date',
    'registered_capital', 'status', 'short_name', 'former_names', 'source', 'snapshot_date'],
  companyRecords.map(r => r.fields));
writeCsv('holders_en.csv',
  ['record_id', 'company_name', 'holder_name', 'holder_type', 'id_number', 'subscribed_amount',
    'equity_ratio', 'holder_address', 'position', 'change_date', 'source'],
  equityRecords.map(r => r.fields));
writeCsv('changes_en.csv',
  ['record_id', 'company_name', 'uscc', 'change_date', 'change_item', 'before', 'after', 'source'],
  changeRecords.map(r => r.fields));

writeFileSync(join(TRUTH, 'record_map.json'), JSON.stringify({
  generatedAt: '2026-03-01',
  companyRecords: companyRecordTruth,
  personRecords: personRecordTruth,
  allCompanyHolderRecords: Object.fromEntries(equityRecords.filter(r => r.holderKind === 'company').map(r => [r.id, r.holderKey])),
  counts: {
    companyRecords: companyRecords.length,
    equityRecords: equityRecords.length,
    personHolderRecords: Object.keys(personRecordTruth).length,
    changeRecords: changeRecords.length,
  },
}, null, 2), 'utf8');

console.log('wrote samples:', {
  companies: companyRecords.length,
  equity: equityRecords.length,
  changes: changeRecords.length,
  persons: Object.keys(personRecordTruth).length,
});
