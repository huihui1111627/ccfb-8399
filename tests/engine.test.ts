import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseRatio, parseDate } from '../src/core/csv.js';
import { mapCompanies, mapHolders, mapChanges, mergeDataset, emptyDataset } from '../src/core/import.js';
import { DEFAULT_MAPPINGS, ENGLISH_MAPPINGS } from '../src/core/types.js';
import { resolveEntities } from '../src/core/resolve.js';
import { buildGraph, buildOwnershipResult, solveLinear, solveIterative, findCycles, applyNominees, enumeratePaths } from '../src/core/ownership.js';
import { analyseControllers } from '../src/core/controllers.js';
import { EquityService } from '../src/service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (f: string) => readFileSync(join(ROOT, 'data', 'samples', f), 'utf8');

function directGraph(rows: Record<string, Record<string, number>>, entities: string[], kinds: Record<string, 'company' | 'person'>) {
  const direct = new Map<string, Map<string, number>>();
  for (const [company, holders] of Object.entries(rows)) direct.set(company, new Map(Object.entries(holders)));
  const ents = entities.map(id => ({
    id, kind: kinds[id], canonicalName: id, aliases: [id], uscc: null, addresses: [],
    legalReps: [], idFragments: [], recordIds: [], confidence: 1, evidence: [], createdAt: '',
  }));
  return { direct, ents };
}

test('CSV parser handles quotes, BOM and delimiter sniffing', () => {
  const parsed = parseCsv('﻿名称,比例,备注\n"甲, 乙",60%,"含 ""引号"""\n丙,0.4,\n');
  assert.deepEqual(parsed.headers, ['名称', '比例', '备注']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0]['名称'], '甲, 乙');
  assert.equal(parsed.rows[0]['备注'], '含 "引号"');
  const tsv = parseCsv('a\tb\n1\t2\n');
  assert.equal(tsv.rows[0]['b'], '2');
});

test('ratio and date parsing accept messy formats', () => {
  assert.equal(parseRatio('60%'), 0.6);
  assert.equal(parseRatio('60.00%'), 0.6);
  assert.equal(parseRatio('0.6'), 0.6);
  assert.equal(parseRatio('60'), 0.6);
  assert.equal(parseRatio('0.6000'), 0.6);
  assert.equal(parseRatio(''), null);
  assert.equal(parseDate('2022/02/01'), '2022-02-01');
  assert.equal(parseDate('2022年2月1日'), '2022-02-01');
  assert.equal(parseDate('20220201'), '2022-02-01');
});

test('english header mapping produces identical rows to Chinese mapping', () => {
  const cn = mapCompanies(parseCsv(sample('companies.csv')), DEFAULT_MAPPINGS.companies);
  const en = mapCompanies(parseCsv(sample('companies_en.csv')), ENGLISH_MAPPINGS.companies);
  assert.equal(cn.rows.length, en.rows.length);
  assert.deepEqual(cn.rows[0], en.rows[0]);
  const hCn = mapHolders(parseCsv(sample('holders.csv')), DEFAULT_MAPPINGS.holders);
  const hEn = mapHolders(parseCsv(sample('holders_en.csv')), ENGLISH_MAPPINGS.holders);
  assert.deepEqual(hCn.rows[5], hEn.rows[5]);
});

test('missing mapped column surfaces an actionable error', () => {
  const parsed = parseCsv('名字,比例\n甲,50%\n');
  const r = mapHolders(parsed, DEFAULT_MAPPINGS.holders);
  assert.equal(r.rows.length, 0);
  // whichever required column is missing first, the message must name it
  assert.ok(r.issues.some(i => i.severity === 'error' && /找不到列/.test(i.message)));
});

test('mergeDataset dedupes by record id and prefers richer rows', () => {
  const base = emptyDataset();
  base.companies.push({
    recordId: 'X1', name: '甲有限公司', uscc: '', address: '', legalRep: '', establishedDate: '',
    capital: null, status: '', shortName: '', formerNames: '', source: '', snapshotDate: '',
  });
  const merged = mergeDataset(base, {
    companies: [{
      recordId: 'X1', name: '甲有限公司', uscc: '91440300MA000000XX', address: '深圳', legalRep: '张三',
      establishedDate: '2010-01-01', capital: 100, status: '存续', shortName: '', formerNames: '',
      source: '工商公示', snapshotDate: '2025-12-31',
    }],
  }, []);
  assert.equal(merged.companies.length, 1);
  assert.equal(merged.companies[0].uscc, '91440300MA000000XX');
});

function loadRaw(kind: 'companies' | 'holders' | 'changes') {
  const map = { companies: mapCompanies, holders: mapHolders, changes: mapChanges }[kind];
  return map(parseCsv(sample(`${kind}.csv`)), DEFAULT_MAPPINGS[kind]).rows;
}

test('entity resolution merges companies by USCC/alias and splits homonyms by ID', () => {
  const dataset = {
    companies: loadRaw('companies'),
    holders: loadRaw('holders'),
    changes: loadRaw('changes'),
    issues: [],
  };
  const r = resolveEntities(dataset);
  assert.equal(r.companies.length, 20, '20 real companies after alias merging');
  assert.equal(r.persons.length, 14, '14 natural persons after homonym splitting');
  const wang = r.persons.filter(p => p.canonicalName === '王海峰');
  assert.equal(wang.length, 4, 'four distinct 王海峰 by ID fragment');
  assert.ok(wang.every(p => p.idFragments.length === 1));
  // no company record left unresolved
  assert.equal(r.unresolvedCompanies.length, 0);
  // 蓝海网络技术有限公司 (former name) must merge with 蓝海科技有限公司 rows
  const blue = r.companies.find(c => c.aliases.includes('蓝海科技有限公司'))!;
  assert.ok(blue.aliases.includes('蓝海网络技术有限公司'));
  // 海峰投资 must stay separate from 蓝海科技
  assert.ok(r.companies.some(c => c.canonicalName === '海峰投资有限公司'));
});

test('linear solver sums path products without exploding on cycles', () => {
  const { direct, ents } = directGraph(
    { A: { P: 0.5, B: 0.5 }, B: { P: 1 } },
    ['A', 'B', 'P'], { A: 'company', B: 'company', P: 'person' },
  );
  const sol = solveLinear(['A', 'B'], direct, { persons: ['P'] });
  assert.ok(Math.abs((sol.matrix.get('P')!.get('A') ?? 0) - 1) < 1e-9);
  assert.ok(Math.abs((sol.matrix.get('P')!.get('B') ?? 0) - 1) < 1e-9);
  void ents;
});

test('cross holding cycle converges to a finite stable solution', () => {
  // X owns 40% of Y, Y owns 30% of X, persons hold the rest directly.
  const direct = new Map<string, Map<string, number>>([
    ['X', new Map([['Y', 0.3], ['P', 0.7]])],
    ['Y', new Map([['X', 0.4], ['Q', 0.6]])],
  ]);
  const lin = solveLinear(['X', 'Y'], direct, { persons: ['P', 'Q'] });
  const it = solveIterative(['X', 'Y'], direct, { persons: ['P', 'Q'] });
  assert.ok(it.converged, 'iterative solver converges rather than looping forever');
  for (const p of ['P', 'Q']) {
    for (const c of ['X', 'Y']) {
      const a = lin.matrix.get(p)!.get(c) ?? 0;
      const b = it.matrix.get(p)!.get(c) ?? 0;
      assert.ok(Math.abs(a - b) < 1e-6, `${p}->${c}: ${a} vs ${b}`);
    }
  }
  // P: 0.7 of X; X also holds 0.3 of Y whose 0.4 goes back to X...
  const px = lin.matrix.get('P')!.get('X')!;
  const py = lin.matrix.get('P')!.get('Y')!;
  assert.ok(px > 0.7 && px < 0.9, `P->X should be finite and above direct 0.7, got ${px}`);
  assert.ok(py > 0.28 && py < 0.36);
  // total ownership of each company by all persons must be 1 when the columns are balanced
  const sumX = (lin.matrix.get('P')!.get('X') ?? 0) + (lin.matrix.get('Q')!.get('X') ?? 0);
  assert.ok(Math.abs(sumX - 1) < 1e-9, `sum of person ownership in X = ${sumX}`);
});

test('cycle detection reports strongly connected components and self loops', () => {
  const direct = new Map<string, Map<string, number>>([
    ['A', new Map([['B', 0.5]])],
    ['B', new Map([['A', 0.5]])],
    ['C', new Map([['C', 0.2]])],
    ['D', new Map([['A', 0.3]])],
  ]);
  const cycles = findCycles(['A', 'B', 'C', 'D'], direct, new Map());
  const flat = cycles.map(c => c.slice().sort().join(','));
  assert.ok(flat.includes('A,B'));
  assert.ok(flat.includes('C'));
  assert.ok(!flat.includes('D'));
});

test('nominee restatement moves holdings to the actual owner', () => {
  const direct = new Map<string, Map<string, number>>([['X', new Map([['N', 0.4], ['P', 0.6]])]]);
  const adjusted = applyNominees(direct, [{
    id: 'R', type: 'nominee', scopeCompanyId: 'X', leaderEntityId: null,
    memberEntityIds: ['P'], nominalEntityId: 'N', actualEntityId: 'P',
    start: '2020-01-01', end: null, note: '', createdBy: '', createdAt: '',
  }]);
  assert.equal(adjusted.get('X')!.get('N'), 0);
  assert.equal(adjusted.get('X')!.get('P'), 1);
});

test('beneficial owners use a strict >25% threshold and controller needs 30%', () => {
  const direct = new Map<string, Map<string, number>>([
    ['C', new Map([['P', 0.25], ['Q', 0.25], ['R', 0.5]])],
  ]);
  const entities = ['C', 'P', 'Q', 'R'].map(id => ({
    id, kind: (id === 'C' ? 'company' : 'person') as 'company' | 'person', canonicalName: id,
    aliases: [id], uscc: null, addresses: [], legalReps: [], idFragments: [], recordIds: [],
    confidence: 1, evidence: [], createdAt: '',
  }));
  const graph = buildGraph([], entities, []);
  // buildGraph has no edges; inject direct rows through a synthetic graph instead
  graph.companies = ['C'];
  graph.persons = ['P', 'Q', 'R'];
  graph.direct = direct;
  const ownership = buildOwnershipResult(graph, new Map(entities.map(e => [e.id, e.id])));
  const analysis = analyseControllers(ownership, entities, []);
  const ctrl = analysis.byCompany.get('C')!;
  assert.equal(ctrl.kind, 'person');
  assert.equal(ctrl.leaderEntityId, 'R');
  assert.deepEqual(ctrl.beneficialOwners.map(o => o.entityId), ['R']);
  assert.equal(ctrl.beneficialOwners[0].pct, 0.5);
});

test('concert group can outrank the largest single shareholder', () => {
  const direct = new Map<string, Map<string, number>>([
    ['C', new Map([['P', 0.2], ['Q', 0.25], ['R', 0.25]])],
  ]);
  const entities = ['C', 'P', 'Q', 'R'].map(id => ({
    id, kind: (id === 'C' ? 'company' : 'person') as 'company' | 'person', canonicalName: id,
    aliases: [id], uscc: null, addresses: [], legalReps: [], idFragments: [], recordIds: [],
    confidence: 1, evidence: [], createdAt: '',
  }));
  const graph = buildGraph([], entities, []);
  graph.companies = ['C'];
  graph.persons = ['P', 'Q', 'R'];
  graph.direct = direct;
  const ownership = buildOwnershipResult(graph, new Map(entities.map(e => [e.id, e.id])));
  const rel = {
    id: 'R1', type: 'concert' as const, scopeCompanyId: 'C', leaderEntityId: 'P',
    memberEntityIds: ['P', 'Q'], nominalEntityId: null, actualEntityId: null,
    start: '2020-01-01', end: null, note: '', createdBy: '', createdAt: '',
  };
  const analysis = analyseControllers(ownership, entities, [rel]);
  const ctrl = analysis.byCompany.get('C')!;
  assert.equal(ctrl.kind, 'group');
  assert.equal(ctrl.leaderEntityId, 'P');
  assert.ok(Math.abs(ctrl.pct - 0.45) < 1e-9);
});

test('path enumeration multiplies and the truncated cycle tail is reported', () => {
  const direct = new Map<string, Map<string, number>>([
    ['T', new Map([['M', 0.4], ['P', 0.2]])],
    ['M', new Map([['P', 0.5], ['T', 0.1]])],
  ]);
  const names = new Map([['T', 'T'], ['M', 'M'], ['P', 'P']]);
  const kinds = new Map([['T', 'company'], ['M', 'company'], ['P', 'person']]);
  const { paths, truncatedCyclePct } = enumeratePaths('T', 'P', direct, names, kinds, { maxPaths: 20 });
  const total = paths.reduce((s, p) => s + p.pct, 0);
  // direct 0.2 + via M 0.4*0.5 = 0.4 (the T<-M<-T loop is truncated at the repeat)
  assert.ok(Math.abs(total - 0.4) < 1e-9, `paths sum ${total}`);
  assert.ok(truncatedCyclePct > 0);
});

test('date filter rebuilds the ownership structure of an earlier snapshot', () => {
  const direct = new Map<string, Map<string, number>>([
    ['C', new Map([['P', 1]])],
  ]);
  const entities = ['C', 'P', 'Q'].map(id => ({
    id, kind: (id === 'C' ? 'company' : 'person') as 'company' | 'person', canonicalName: id,
    aliases: [id], uscc: null, addresses: [], legalReps: [], idFragments: [], recordIds: [],
    confidence: 1, evidence: [], createdAt: '',
  }));
  const rows = [
    { companyId: 'C', holderId: 'P', pct: 1, effectiveDate: '2019-01-01', recordId: '1', source: '', holderNameRaw: '', companyNameRaw: '' },
    // a 工商变更 batch re-states the whole cap table: the transfer row is
    // accompanied by P's new 0% row, so the columns stay balanced
    { companyId: 'C', holderId: 'P', pct: 0, effectiveDate: '2022-01-01', recordId: '2', source: '', holderNameRaw: '', companyNameRaw: '' },
    { companyId: 'C', holderId: 'Q', pct: 1, effectiveDate: '2022-01-01', recordId: '3', source: '', holderNameRaw: '', companyNameRaw: '' },
  ];
  const g = buildGraph(rows, entities, [], { asOf: '2020-01-01' });
  assert.equal(g.direct.get('C')!.get('P'), 1);
  assert.equal(g.direct.get('C')!.get('Q'), undefined);
  const g2 = buildGraph(rows, entities, [], { asOf: '2023-01-01' });
  assert.equal(g2.direct.get('C')!.get('Q'), 1);
  void direct;
});

test('service end-to-end matches the stored ground truth', () => {
  const s = new EquityService();
  s.loadDemo();
  const res = s.ensureResolved();
  assert.equal(res.companies.length, 20);
  assert.equal(res.persons.length, 14);
  const report = s.evaluateAgainstTruth();
  assert.equal(report.available, true);
  assert.ok(report.entity!.persons.bcubed.f1 > 0.99, 'person B3 F1');
  assert.ok(report.entity!.companies.bcubed.f1 > 0.99, 'company B3 F1');
  assert.ok(report.controllers!.accuracy > 0.99, 'controller accuracy');
  assert.ok(report.controllers!.ownerF1 > 0.99, 'beneficial owner F1');
  assert.deepEqual(report.snapshotsCompared.sort(), ['S0', 'S1', 'S2']);
});

test('beneficial owner report honours the 25% threshold and dates', () => {
  const s = new EquityService();
  s.loadDemo();
  const report = s.beneficialOwnersReport('2025-12-31', 0.25);
  assert.ok(report.rows.length >= 10);
  assert.ok(report.rows.every(r => r.pct > 0.25));
  const blue = report.rows.filter(r => r.companyName === '蓝海科技有限公司');
  assert.ok(blue.length >= 1);
});

test('manual nominee relation changes the controller result', () => {
  const s = new EquityService();
  s.loadDemo();
  const res = s.ensureResolved();
  const bluedev = res.companies.find(c => c.canonicalName === '蓝海智造设备有限公司')!;
  const before = s.evaluateOwnership('2025-12-31').analysis.byCompany.get(bluedev.id)!;
  assert.equal(before.kind, 'person');
  // remove the seeded nominee relation and confirm the controller flips
  const rel = s.state.relations.find(r => r.type === 'nominee' && r.scopeCompanyId === bluedev.id)!;
  s.deleteRelation(rel.id);
  const after = s.evaluateOwnership('2025-12-31').analysis.byCompany.get(bluedev.id)!;
  assert.ok(after.leaderEntityId !== before.leaderEntityId || after.pct !== before.pct);
});

test('history snapshots are chronological and non-empty', () => {
  const s = new EquityService();
  s.loadDemo();
  const snaps = s.listSnapshots();
  assert.ok(snaps.length > 5);
  for (let i = 1; i < snaps.length; i++) assert.ok(snaps[i].date > snaps[i - 1].date);
  assert.ok(snaps.some(x => x.cycles.length > 0));
});
