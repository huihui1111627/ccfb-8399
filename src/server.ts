import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EquityService } from './service.js';
import { DatasetKind, FIELD_LABELS, ENTITY_PREFIX } from './core/types.js';
import { pctLabel } from './core/normalize.js';
import { enumeratePaths } from './core/ownership.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
const service = new EquityService();

app.use(express.json({ limit: '25mb' }));
app.use(express.static(join(ROOT, 'public')));

const wrap = (fn: (req: express.Request, res: express.Response) => unknown) =>
  (req: express.Request, res: express.Response) => {
    try { fn(req, res); } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  };

const namesOf = () => new Map(service.state.entities.map(e => [e.id, e.canonicalName]));
const kindsOf = () => new Map(service.state.entities.map(e => [e.id, e.kind]));

// ---------------- meta ----------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/meta', (_req, res) => {
  const res2 = service.ensureResolved();
  res.json({
    counts: {
      companies: service.state.dataset.companies.length,
      holders: service.state.dataset.holders.length,
      changes: service.state.dataset.changes.length,
      companyEntities: res2.companies.length,
      personEntities: res2.persons.length,
    },
    imports: service.state.imports,
    lastResolvedAt: service.state.lastResolvedAt,
    hasTruth: existsSync(join(ROOT, 'data', 'truth', 'controllers.json')),
    relations: service.state.relations.length,
    manualMerges: service.state.merges.length,
    manualSplits: service.state.splits.length,
    mappings: service.state.mappings,
  });
});

// ---------------- import ----------------

app.get('/api/mapping/fields/:kind', (req, res) => {
  const kind = req.params.kind as DatasetKind;
  res.json(FIELD_LABELS[kind] ?? {});
});

app.put('/api/mapping/:kind', wrap((req, res) => {
  const kind = req.params.kind as DatasetKind;
  if (!['companies', 'holders', 'changes'].includes(kind)) throw new Error('未知数据类型');
  const fields = req.body?.fields;
  if (!fields || typeof fields !== 'object') throw new Error('缺少 fields');
  service.state.mappings[kind] = { fields: { ...service.state.mappings[kind].fields, ...fields } };
  res.json({ ok: true, mapping: service.state.mappings[kind] });
}));

app.post('/api/mapping/:kind/preset', wrap((_req, res) => {
  service.useEnglishMappings();
  res.json({ ok: true, mappings: service.state.mappings });
}));

app.post('/api/mapping/reset', wrap((_req, res) => {
  service.useDefaultMappings();
  res.json({ ok: true, mappings: service.state.mappings });
}));

app.post('/api/import/demo', wrap((_req, res) => {
  const imported = service.loadDemo();
  const resolved = service.ensureResolved();
  res.json({ imported, entities: { companies: resolved.companies.length, persons: resolved.persons.length } });
}));

app.post('/api/import/:kind', wrap((req, res) => {
  const kind = String(req.params.kind) as DatasetKind;
  if (!['companies', 'holders', 'changes'].includes(kind)) throw new Error(`未知数据类型 ${kind}`);
  const { csv, fileName, mapping } = req.body ?? {};
  if (typeof csv !== 'string' || !csv.trim()) throw new Error('缺少 CSV 内容');
  const result = service.ingestCsv(kind, csv, fileName ?? `${kind}.csv`, mapping);
  const resolved = service.resolve();
  res.json({
    ...result,
    entities: { companies: resolved.companies.length, persons: resolved.persons.length },
  });
}));


app.post('/api/import/reset', wrap((_req, res) => {
  service.state.dataset = { companies: [], holders: [], changes: [], issues: [] };
  service.state.relations = [];
  service.state.merges = [];
  service.state.splits = [];
  service.state.imports = [];
  service.state.entities = [];
  service.resolution = null;
  service.relationDefaultsApplied = false;
  res.json({ ok: true });
}));

// ---------------- entities / disambiguation ----------------

app.get('/api/entities', wrap((req, res) => {
  const result = service.ensureResolved();
  const q = String(req.query.q ?? '').trim();
  const kind = String(req.query.kind ?? '');
  const names = namesOf();
  let persons = result.persons;
  let companies = result.companies;
  const match = (e: { canonicalName: string; aliases: string[]; uscc: string | null; idFragments: string[] }) => {
    if (!q) return true;
    return e.canonicalName.includes(q) || e.aliases.some(a => a.includes(q)) ||
      (e.uscc ?? '').toUpperCase().includes(q.toUpperCase()) ||
      e.idFragments.some(f => f.includes(q));
  };
  persons = persons.filter(match);
  companies = companies.filter(match);
  const pickEntity = (e: typeof persons[number]) => ({
    id: e.id, kind: e.kind, name: e.canonicalName, aliases: e.aliases,
    uscc: e.uscc, addresses: e.addresses, idFragments: e.idFragments,
    legalReps: e.legalReps, records: e.recordIds.length, confidence: e.confidence,
    evidence: e.evidence,
  });
  res.json({
    companies: kind === 'person' ? [] : companies.map(pickEntity),
    persons: kind === 'company' ? [] : persons.map(pickEntity),
    conflicts: result.conflicts,
    diagnostics: result.diagnostics,
    unresolved: result.unresolvedCompanies,
    nameGroups: [...new Set(result.persons.map(p => p.canonicalName))]
      .map(name => ({ name, entities: result.persons.filter(p => p.canonicalName === name) }))
      .filter(g => g.entities.length > 1)
      .map(g => ({
        name: g.name,
        entities: g.entities.map(e => ({
          id: e.id, records: e.recordIds.length, idFragments: e.idFragments,
          addresses: e.addresses, confidence: e.confidence,
        })),
      })),
    _names: names.size,
  });
}));

app.get('/api/entities/manual-edits', (_req, res) => {
  const names = namesOf();
  res.json({
    merges: service.state.merges.map(m => ({ ...m, names: m.entityIds.map(id => names.get(id) ?? id) })),
    splits: service.state.splits.map(s => ({
      ...s,
      entityName: names.get(s.entityId) ?? s.entityId,
      recordIds: s.recordIds,
    })),
  });
});

app.get('/api/entities/:id', wrap((req, res) => {
  const result = service.ensureResolved();
  const entity = result.entities.find(e => e.id === String(req.params.id));
  if (!entity) throw new Error('主体不存在');
  const names = namesOf();
  const holderRows = service.state.dataset.holders
    .filter(h => result.holderResolution.get(h.recordId) === entity.id)
    .map(h => ({
      recordId: h.recordId, companyNameRaw: h.companyName, holderNameRaw: h.holderName,
      idNumber: h.idNumber, ratioText: h.ratioText, ratio: h.ratio, address: h.holderAddress,
      position: h.position, effectiveDate: h.effectiveDate, source: h.source,
    }));
  const companyRows = service.state.dataset.companies
    .filter(c => entity.recordIds.includes(c.recordId))
    .map(c => ({ recordId: c.recordId, name: c.name, uscc: c.uscc, address: c.address, shortName: c.shortName, formerNames: c.formerNames, source: c.source, snapshotDate: c.snapshotDate }));
  const relations = service.state.relations
    .filter(r => r.memberEntityIds.includes(entity.id) || r.nominalEntityId === entity.id || r.actualEntityId === entity.id)
    .map(r => ({
      ...r, scopeName: names.get(r.scopeCompanyId), memberNames: r.memberEntityIds.map(m => names.get(m) ?? m),
      nominalName: r.nominalEntityId ? names.get(r.nominalEntityId) : null,
      actualName: r.actualEntityId ? names.get(r.actualEntityId) : null,
    }));
  const nameMap: Record<string, string> = {};
  for (const e of result.entities) nameMap[e.id] = e.canonicalName;
  const readableEvidence = entity.evidence.map(ev => ({
    ...ev,
    detail: ev.detail.replace(/\b(?:CO|PE)-[0-9a-f]{8}\b/g, id => nameMap[id] ?? id),
  }));
  res.json({ entity: { ...entity, name: entity.canonicalName, evidence: readableEvidence }, holderRows, companyRows, relations });
}));

app.get('/api/entities/:id/merge-preview', wrap((req, res) => {
  const result = service.ensureResolved();
  const entity = result.entities.find(e => e.id === String(req.params.id));
  if (!entity) throw new Error('主体不存在');
  const others = result.entities.filter(e => e.kind === entity.kind && e.id !== entity.id);
  const sourceRecords = entity.recordIds.map(rid => service.state.dataset.holders.find(h => h.recordId === rid)).filter(Boolean);
  const scores = others.map(o => {
    let score = 0;
    let reason = '同名';
    if (o.canonicalName === entity.canonicalName) score = 0.3;
    const sharedAddr = o.addresses.filter(a => entity.addresses.includes(a));
    if (sharedAddr.length) { score = Math.max(score, 0.6); reason = '同名 + 地址相同'; }
    const sharedIds = o.idFragments.filter(f => entity.idFragments.includes(f));
    if (sharedIds.length) { score = 1; reason = '证件片段相同'; }
    const conflict = o.idFragments.length && entity.idFragments.length &&
      o.idFragments.every(a => entity.idFragments.every(b => a !== b));
    return { id: o.id, name: o.canonicalName, score, reason, conflict };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
  void sourceRecords;
  res.json({ entity: { id: entity.id, name: entity.canonicalName }, candidates: scores });
}));

app.post('/api/entities/:id/split', wrap((req, res) => {
  const recordIds: string[] = req.body?.recordIds ?? [];
  const note = String(req.body?.note ?? '');
  const split = service.splitEntity(String(req.params.id), recordIds, note);
  const after = service.ensureResolved();
  res.json({
    ok: true,
    splitId: split.id,
    recordIds,
    entities: { companies: after.companies.length, persons: after.persons.length },
  });
}));

app.post('/api/entities/merge', wrap((req, res) => {
  const entityIds: string[] = req.body?.entityIds ?? [];
  const merge = service.mergeEntities(entityIds, String(req.body?.note ?? ''));
  const after = service.ensureResolved();
  res.json({ ok: true, mergeId: merge.id, entities: { companies: after.companies.length, persons: after.persons.length } });
}));

app.post('/api/entities/undo-manual', wrap((_req, res) => {
  service.clearManualEdits();
  const after = service.ensureResolved();
  res.json({ ok: true, entities: { companies: after.companies.length, persons: after.persons.length } });
}));

// ---------------- graph / ownership ----------------

app.get('/api/graph', wrap((req, res) => {
  const asOf = req.query.asOf ? String(req.query.asOf) : undefined;
  const result = service.ensureResolved();
  const names = namesOf();
  const kinds = kindsOf();
  const { ownership, analysis, graph } = service.evaluateOwnership(asOf);
  const nodes = result.entities.map(e => ({
    id: e.id,
    name: e.canonicalName,
    kind: e.kind,
    uscc: e.uscc,
    aliases: e.aliases,
    idFragments: e.idFragments,
    confidence: e.confidence,
    controllerOf: analysis.results
      .filter(c => c.kind === 'person' && c.leaderEntityId === e.id)
      .map(c => c.companyId),
    dispersedController: false,
  }));
  const edges = graph.edges.map(e => ({
    companyId: e.companyId, holderId: e.holderId, pct: e.pct,
    effectiveDate: e.effectiveDate, source: e.source, recordId: e.recordId,
  }));
  // concert/nominee overlays
  const relations = service.state.relations
    .filter(r => !asOf || (r.start <= asOf && (r.end === null || r.end >= asOf)))
    .map(r => ({
      ...r,
      scopeName: names.get(r.scopeCompanyId),
      memberNames: r.memberEntityIds.map(m => names.get(m) ?? m),
      nominalName: r.nominalEntityId ? names.get(r.nominalEntityId) : null,
      actualName: r.actualEntityId ? names.get(r.actualEntityId) : null,
    }));
  const cycles = ownership.cycles;
  res.json({
    asOf: asOf ?? null,
    nodes, edges, relations, cycles,
    controllers: analysis.results.map(c => ({
      ...c,
      companyName: names.get(c.companyId),
      leaderName: c.leaderEntityId ? names.get(c.leaderEntityId) : null,
      memberNames: c.memberEntityIds.map(m => names.get(m) ?? m),
      ownerNames: c.beneficialOwners.map(o => ({ ...o, name: names.get(o.entityId) ?? o.entityId })),
      breakdown: c.breakdown.map(b => ({ ...b, name: names.get(b.entityId) ?? b.entityId, kind: kinds.get(b.entityId) })),
    })),
    diagnostics: {
      ...ownership.diagnostics,
      supersededRows: graph.diagnostics.supersededRows,
      droppedZero: graph.diagnostics.droppedZero,
      dispersed: analysis.dispersed.map(id => names.get(id)),
    },
  });
}));

app.get('/api/company/:id/detail', wrap((req, res) => {
  const asOf = req.query.asOf ? String(req.query.asOf) : undefined;
  const detail = service.companyDetail(String(req.params.id), asOf);
  const names = namesOf();
  res.json({
    ...detail,
    company: detail.company ? { id: detail.company.id, name: detail.company.canonicalName, uscc: detail.company.uscc, aliases: detail.company.aliases } : null,
    controller: detail.controller ? {
      ...detail.controller,
      leaderName: detail.controller.leaderEntityId ? names.get(detail.controller.leaderEntityId) : null,
      memberNames: detail.controller.memberEntityIds.map(m => names.get(m) ?? m),
      beneficialOwners: detail.controller.beneficialOwners.map(o => ({ ...o, name: names.get(o.entityId) ?? o.entityId })),
      breakdown: detail.controller.breakdown.map(b => ({ ...b, name: names.get(b.entityId) ?? b.entityId })),
    } : null,
    effectiveRows: detail.effectiveRows,
    paths: detail.paths.map(p => ({ ...p, pctLabel: pctLabel(p.pct) })),
  });
}));

app.post('/api/company/:id/paths', wrap((req, res) => {
  const asOf = req.body?.asOf ? String(req.body.asOf) : undefined;
  const personId = String(req.body?.personId ?? '');
  const { ownership, graph } = service.evaluateOwnership(asOf);
  const names = namesOf(); const kinds = kindsOf();
  const out = enumeratePaths(String(req.params.id), personId, ownership.direct, names, kinds, { maxPaths: 50, minPct: 1e-6 });
  void graph;
  res.json(out);
}));

// ---------------- controllers / history / export ----------------

app.get('/api/controllers', wrap((req, res) => {
  const asOf = req.query.asOf ? String(req.query.asOf) : undefined;
  const { analysis } = service.evaluateOwnership(asOf);
  const names = namesOf();
  res.json({
    asOf: asOf ?? null,
    rules: analysis.rules,
    items: analysis.results.map(c => ({
      companyId: c.companyId,
      companyName: names.get(c.companyId),
      kind: c.kind,
      leaderId: c.leaderEntityId,
      leaderName: c.leaderEntityId ? names.get(c.leaderEntityId) : null,
      members: c.memberEntityIds.map(m => ({ id: m, name: names.get(m) })),
      pct: c.pct,
      basis: c.basis,
      relationId: c.relationId,
      owners: c.beneficialOwners.map(o => ({ id: o.entityId, name: names.get(o.entityId), pct: o.pct, legalPct: o.legalPct })),
    })),
    concert: analysis.concertApplied.map(c => ({ ...c, companyName: names.get(c.companyId), memberNames: c.members.map(m => names.get(m)) })),
  });
}));

app.get('/api/history', wrap((req, res) => {
  res.json({ snapshots: service.listSnapshots() });
}));

app.get('/api/history/:date', wrap((req, res) => {
  const date = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
  const names = namesOf();
  const { ownership, analysis, graph } = service.evaluateOwnership(date);
  const edges = graph.edges.map(e => ({
    companyId: e.companyId, companyName: names.get(e.companyId),
    holderId: e.holderId, holderName: names.get(e.holderId),
    pct: e.pct, effectiveDate: e.effectiveDate,
  }));
  res.json({
    date,
    edges,
    controllers: analysis.results.map(c => ({
      companyId: c.companyId, companyName: names.get(c.companyId), kind: c.kind,
      leaderName: c.leaderEntityId ? names.get(c.leaderEntityId) : null, pct: c.pct, basis: c.basis,
    })),
    cycles: ownership.cycles,
    companies: ownership.companies.length,
  });
}));

app.get('/api/export/beneficial-owners', wrap((req, res) => {
  const asOf = req.query.asOf ? String(req.query.asOf) : undefined;
  const threshold = req.query.threshold ? Number(req.query.threshold) / 100 : 0.25;
  const report = service.beneficialOwnersReport(asOf, threshold);
  const header = ['企业名称', '受益所有人', '穿透持股比例', '名义登记比例', '实际控制人', '控制人类型', '判定依据', '基准日'];
  const lines = [header.join(',')];
  for (const r of report.rows) {
    lines.push([
      r.companyName, r.ownerName, pctLabel(r.pct), pctLabel(r.legalPct),
      r.controller, r.controllerKind === 'group' ? '一致行动组' : r.controllerKind === 'person' ? '自然人' : '无实际控制人',
      r.basis, asOf ?? 'latest',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="beneficial-owners-${asOf ?? 'latest'}.csv"`);
  res.send('﻿' + lines.join('\n'));
}));

app.get('/api/export/ownership-matrix', wrap((req, res) => {
  const asOf = req.query.asOf ? String(req.query.asOf) : undefined;
  const { ownership } = service.evaluateOwnership(asOf);
  const names = namesOf();
  const header = ['主体ID', '主体名称', '公司ID', '公司名称', '穿透持股比例'];
  const lines = [header.join(',')];
  for (const p of ownership.persons) {
    for (const c of ownership.companies) {
      const pct = ownership.matrix.get(p)?.get(c) ?? 0;
      if (pct > 1e-9) lines.push([p, names.get(p), c, names.get(c), pct.toFixed(6)].map(v => `"${v}"`).join(','));
    }
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ownership-matrix.csv"');
  res.send('﻿' + lines.join('\n'));
}));

// ---------------- relations ----------------

app.get('/api/relations', (_req, res) => {
  const names = namesOf();
  res.json({
    items: service.state.relations.map(r => ({
      ...r,
      scopeName: names.get(r.scopeCompanyId),
      memberNames: r.memberEntityIds.map(m => names.get(m) ?? m),
      leaderName: r.leaderEntityId ? names.get(r.leaderEntityId) : null,
      nominalName: r.nominalEntityId ? names.get(r.nominalEntityId) : null,
      actualName: r.actualEntityId ? names.get(r.actualEntityId) : null,
    })),
  });
});

app.post('/api/relations', wrap((req, res) => {
  const body = req.body ?? {};
  const rel = service.addRelation({
    type: body.type,
    scopeCompanyId: body.scopeCompanyId,
    leaderEntityId: body.leaderEntityId ?? null,
    memberEntityIds: body.memberEntityIds ?? [],
    nominalEntityId: body.nominalEntityId ?? null,
    actualEntityId: body.actualEntityId ?? null,
    start: body.start ?? new Date().toISOString().slice(0, 10),
    end: body.end ?? null,
    note: body.note ?? '',
    createdBy: body.createdBy ?? 'console-user',
  });
  res.json({ ok: true, relation: rel });
}));

app.put('/api/relations/:id', wrap((req, res) => {
  const rel = service.updateRelation(String(req.params.id), req.body ?? {});
  res.json({ ok: true, relation: rel });
}));

app.delete('/api/relations/:id', wrap((req, res) => {
  const ok = service.deleteRelation(String(req.params.id));
  if (!ok) throw new Error('关系不存在');
  res.json({ ok: true });
}));

// ---------------- evaluation ----------------

app.get('/api/evaluate', wrap((_req, res) => {
  res.json(service.evaluateAgainstTruth());
}));

app.get('/api/evaluate/truth', wrap((_req, res) => {
  const truth = service.loadTruth();
  if (!truth) throw new Error('未找到基准数据');
  res.json({ controllers: truth.controllers, entityCount: truth.clusters.entities.length, recordMap: truth.recordMap });
}));

// ---------------- misc ----------------

app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(join(ROOT, 'public', 'index.html'));
});

const port = Number(process.env.PORT ?? 8399);
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`股权穿透分析系统: http://localhost:${port}`);
    console.log(`首次使用点击「载入演示数据」，或通过 HTTP 上传 CSV。`);
  });
}

export { app, service, ENTITY_PREFIX };
