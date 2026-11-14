/**
 * Application service: owns the imported dataset, entity resolution, dated
 * ownership evaluation, manual relations, and the evaluation against truth.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppState, DEFAULT_MAPPINGS, Dataset, ENGLISH_MAPPINGS, Entity, ManualRelation,
  OwnershipResult, DatasetKind, ControllerResult, ManualMerge, ManualSplit,
} from './core/types.js';
import { parseCsv } from './core/csv.js';
import { emptyDataset, mapChanges, mapCompanies, mapHolders, mergeDataset } from './core/import.js';
import { resolveEntities, ResolutionResult } from './core/resolve.js';
import { buildGraph, buildOwnershipResult, OwnershipRow, enumeratePaths } from './core/ownership.js';
import { analyseControllers, ControllerAnalysis } from './core/controllers.js';
import {
  ControllerEval, RecordMap, TruthControllers, evaluateControllers, evaluateEntityResolution,
} from './core/evaluate.js';
import { companyNameKey, coreCompanyName } from './core/normalize.js';

// src/service.ts -> workspace root (dist/server.js also resolves to workspace root)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface SnapshotSummary {
  date: string;
  label: string;
  companies: number;
  personsWithHoldings: number;
  cycles: string[][];
  dispersed: number;
  unbalanced: number;
}

export interface EvaluateReport {
  available: boolean;
  reason?: string;
  entity: ReturnType<typeof evaluateEntityResolution> | null;
  controllers: ControllerEval | null;
  snapshotsCompared: string[];
  generatedAt: string;
}

export class EquityService {
  state: AppState;
  resolution: ResolutionResult | null = null;
  relationDefaultsApplied = false;

  constructor() {
    this.state = {
      dataset: emptyDataset(),
      entities: [],
      relations: [],
      merges: [],
      splits: [],
      mappings: {
        companies: structuredClone(DEFAULT_MAPPINGS.companies),
        holders: structuredClone(DEFAULT_MAPPINGS.holders),
        changes: structuredClone(DEFAULT_MAPPINGS.changes),
      },
      imports: [],
      lastResolvedAt: null,
    };
  }

  // ---------- import ----------

  ingestCsv(kind: DatasetKind, text: string, fileName: string, mappingOverride?: AppState['mappings'][DatasetKind]) {
    const mapping = mappingOverride ?? this.state.mappings[kind];
    const parsed = parseCsv(text);
    if (!parsed.rows.length) throw new Error('CSV 为空或无法解析');
    let result;
    if (kind === 'companies') result = mapCompanies(parsed, mapping);
    else if (kind === 'holders') result = mapHolders(parsed, mapping);
    else result = mapChanges(parsed, mapping);
    const before = this.rowCount(kind);
    this.state.dataset = mergeDataset(
      this.state.dataset,
      { [kind]: result.rows } as unknown as Partial<Record<DatasetKind, unknown[]>>,
      result.issues,
    );
    const after = this.rowCount(kind);
    this.state.imports.push({
      at: new Date().toISOString(), kind, rows: after - before,
      issues: result.issues.length, fileName,
    });
    this.invalidate();
    return { imported: result.rows.length, issues: result.issues, headers: parsed.headers };
  }

  rowCount(kind: DatasetKind): number {
    return this.state.dataset[kind].length;
  }

  /** Load the bundled demo files. */
  loadDemo() {
    const dir = join(ROOT, 'data', 'samples');
    const files: Array<[DatasetKind, string]> = [
      ['companies', 'companies.csv'],
      ['holders', 'holders.csv'],
      ['changes', 'changes.csv'],
    ];
    const imported: Array<{ kind: DatasetKind; rows: number; issues: number }> = [];
    for (const [kind, file] of files) {
      const path = join(dir, file);
      if (!existsSync(path)) throw new Error(`缺少演示数据文件 ${path}，请先运行 npm run dataset`);
      const r = this.ingestCsv(kind, readFileSync(path, 'utf8'), file);
      imported.push({ kind, rows: r.imported, issues: r.issues.length });
    }
    this.loadDefaultRelationsFromTruth();
    this.resolve();
    return imported;
  }

  /** Manual relations seeded from the scenario's hand-confirmed facts. */
  loadDefaultRelationsFromTruth() {
    if (this.relationDefaultsApplied) return;
    const path = join(ROOT, 'data', 'seed', 'scenario.json');
    if (!existsSync(path)) return;
    const scenario = JSON.parse(readFileSync(path, 'utf8')) as {
      relations: Array<{
        id: string; type: 'concert' | 'nominee'; scope: string; leader: string | null;
        members: string[]; nominal?: string; actual?: string;
        start: string; end: string | null; note: string;
      }>;
      companies: Record<string, { name: string }>;
      persons: Record<string, { name: string; idfrag: string }>;
    };
    this.resolve();
    const entities = this.state.entities;
    const findCompany = (scenarioKey: string) => {
      const name = scenario.companies[scenarioKey]?.name;
      if (!name) return null;
      return entities.find(e => e.kind === 'company' && (e.canonicalName === name ||
        e.aliases.some(a => companyNameKey(a) === companyNameKey(name)) ||
        coreCompanyName(e.canonicalName) === coreCompanyName(name))) ?? null;
    };
    // Locate persons by their ID fragment (region + tail), not by name: the
    // whole point of this dataset is that names are ambiguous. These facts are
    // hand-authored in scenario.json; nothing here reads the generated ground truth.
    const findPerson = (scenarioKey: string) => {
      const meta = scenario.persons[scenarioKey];
      if (!meta) return null;
      const normalized = (f: string) => f.toUpperCase().replace(/[^0-9A-Z*]/g, '');
      const want = normalized(meta.idfrag);
      const candidates = entities.filter(e => e.kind === 'person' && e.canonicalName === meta.name);
      const exact = candidates.find(e => e.idFragments.some(f => normalized(f) === want));
      if (exact) return exact;
      const region = want.slice(0, 6);
      const tail = want.slice(-4);
      return candidates.find(e => e.idFragments.some(f => {
        const n = normalized(f);
        return n.slice(0, 6) === region && n.slice(-4) === tail;
      })) ?? null;
    };
    for (const r of scenario.relations) {
      const scope = findCompany(r.scope);
      if (!scope) continue;
      const members = r.members.map(findPerson).filter((x): x is Entity => Boolean(x));
      if (!members.length) continue;
      const rel: ManualRelation = {
        id: r.id,
        type: r.type,
        scopeCompanyId: scope.id,
        leaderEntityId: r.leader ? findPerson(r.leader)?.id ?? null : null,
        memberEntityIds: members.map(m => m.id),
        nominalEntityId: r.nominal ? findPerson(r.nominal)?.id ?? null : null,
        actualEntityId: r.actual ? findPerson(r.actual)?.id ?? null : null,
        start: r.start,
        end: r.end,
        note: r.note,
        createdBy: 'demo-seed',
        createdAt: new Date().toISOString(),
      };
      if (!this.state.relations.some(x => x.id === rel.id)) this.state.relations.push(rel);
    }
    this.relationDefaultsApplied = true;
    this.invalidate(false);
    this.resolve();
  }

  invalidate(reResolve = true) {
    if (reResolve) this.resolution = null;
  }

  resolve() {
    this.cachedHolderCompanyMap = null;
    const forcedMerges: Array<[string, string]> = [];
    for (const m of this.state.merges) {
      const records = this.recordIdsForEntities(m.entityIds);
      for (let i = 1; i < records.length; i++) forcedMerges.push([records[0], records[i]]);
    }
    this.resolution = resolveEntities(this.state.dataset, {
      forcedMerges,
      forcedSplits: this.state.splits.map(s => ({ entityId: s.entityId, recordIds: s.recordIds, note: s.note })),
    });
    this.state.entities = this.resolution.entities;
    this.state.lastResolvedAt = new Date().toISOString();
    // drop relations that point at entities that no longer exist
    const ids = new Set(this.state.entities.map(e => e.id));
    this.state.relations = this.state.relations.filter(r =>
      ids.has(r.scopeCompanyId) && r.memberEntityIds.every(m => ids.has(m)) &&
      (!r.nominalEntityId || ids.has(r.nominalEntityId)) && (!r.actualEntityId || ids.has(r.actualEntityId)));
    return this.resolution;
  }

  /** Record ids currently attached to the given entity ids (before the next resolve). */
  recordIdsForEntities(entityIds: string[]): string[] {
    const current = this.state.entities.length ? this.state.entities : (this.resolution?.entities ?? []);
    const out: string[] = [];
    for (const id of entityIds) {
      const e = current.find(x => x.id === id);
      if (e) out.push(...e.recordIds);
    }
    return out;
  }

  mergeEntities(entityIds: string[], note = '') {
    if (entityIds.length < 2) throw new Error('合并至少需要选择两个主体');
    const entities = entityIds.map(id => this.state.entities.find(e => e.id === id));
    if (entities.some(e => !e)) throw new Error('主体不存在');
    const kinds = new Set(entities.map(e => e!.kind));
    if (kinds.size > 1) throw new Error('企业与自然人不能互相合并');
    const merge: ManualMerge = {
      id: `MM-${Date.now().toString(36)}`,
      kind: [...kinds][0] as 'company' | 'person',
      entityIds,
      note,
      createdAt: new Date().toISOString(),
    };
    this.state.merges.push(merge);
    this.resolve();
    return merge;
  }

  splitEntity(entityId: string, recordIds: string[], note = '') {
    if (!recordIds.length) throw new Error('请选择要拆出的记录');
    const entity = this.state.entities.find(e => e.id === entityId);
    if (!entity) throw new Error('主体不存在');
    if (recordIds.length >= entity.recordIds.length) throw new Error('不能把主体的全部记录拆出，请直接删除或改名');
    const split: ManualSplit = {
      id: `MS-${Date.now().toString(36)}`,
      entityId,
      recordIds,
      note,
      createdAt: new Date().toISOString(),
    };
    this.state.splits.push(split);
    // a previously forced merge might fight the split; drop overlapping merges
    this.state.merges = this.state.merges.filter(m => !m.entityIds.includes(entityId));
    this.resolve();
    return split;
  }

  clearManualEdits() {
    this.state.merges = [];
    this.state.splits = [];
    this.resolve();
  }

  ensureResolved(): ResolutionResult {
    if (!this.resolution) return this.resolve();
    return this.resolution;
  }

  // ---------- ownership ----------

  /** All dated ownership rows resolved to entity ids (latest write wins per record). */
  ownershipRows(): OwnershipRow[] {
    const res = this.ensureResolved();
    const rows: OwnershipRow[] = [];
    const holderRecordCompany = this.holderRecordCompanyMap();
    for (const h of this.state.dataset.holders) {
      const companyId = holderRecordCompany.get(h.recordId);
      if (!companyId) continue;
      const holderId = res.holderResolution.get(h.recordId);
      if (!holderId) continue;
      if (h.ratio === null || h.ratio < 0 || !h.effectiveDate) continue;
      rows.push({
        companyId,
        holderId,
        pct: h.ratio,
        effectiveDate: h.effectiveDate,
        recordId: h.recordId,
        source: h.source,
        holderNameRaw: h.holderName,
        companyNameRaw: h.companyName,
      });
    }
    return rows;
  }

  private cachedHolderCompanyMap: Map<string, string> | null = null;
  private cachedHolderCompanyKey = '';

  /** Cache the holder-row -> company-entity mapping; invalidated on import/resolve. */
  holderRecordCompanyMap(): Map<string, string> {
    const key = `${this.state.lastResolvedAt ?? ''}|${this.state.dataset.holders.length}`;
    if (this.cachedHolderCompanyMap && this.cachedHolderCompanyKey === key) return this.cachedHolderCompanyMap;
    const map = new Map<string, string>();
    for (const h of this.state.dataset.holders) {
      const companyId = this.companyEntityForHolderRecord(h.recordId);
      if (companyId) map.set(h.recordId, companyId);
    }
    this.cachedHolderCompanyMap = map;
    this.cachedHolderCompanyKey = key;
    return map;
  }

  private companyEntityForHolderRecord(recordId: string): string | null {
    const holderRecord = this.state.dataset.holders.find(h => h.recordId === recordId);
    if (!holderRecord) return null;
    const res = this.ensureResolved();
    // company entity containing a company record whose name matches the holder row's 企业名称
    const target = companyNameKey(holderRecord.companyName);
    const targetCore = coreCompanyName(target);
    for (const e of res.companies) {
      if (e.aliases.some(a => companyNameKey(a) === target)) return e.id;
      if (coreCompanyName(e.canonicalName) === targetCore) return e.id;
    }
    // city-prefixed / short-name variants: a registered alias whose core name the
    // raw string starts with (深圳市星海控股 vs 星海控股), but never across
    // different company cores.
    for (const e of res.companies) {
      for (const a of [e.canonicalName, ...e.aliases]) {
        const aliasCore = coreCompanyName(a);
        if (!aliasCore || !targetCore) continue;
        if (targetCore.startsWith(aliasCore) || aliasCore.startsWith(targetCore)) return e.id;
      }
    }
    return null;
  }

  evaluateOwnership(asOf?: string, solver: 'linear' | 'iterative' = 'linear'): {
    ownership: OwnershipResult & { direct: Map<string, Map<string, number>>; activeRelations: ManualRelation[] };
    analysis: ControllerAnalysis;
    graph: ReturnType<typeof buildGraph>;
  } {
    const res = this.ensureResolved();
    const names = new Map(res.entities.map(e => [e.id, e.canonicalName]));
    const graph = buildGraph(this.ownershipRows(), res.entities, this.state.relations, { asOf });
    const ownership = buildOwnershipResult(graph, names, { solver });
    const analysis = analyseControllers(ownership, res.entities, graph.activeRelations);
    void names;
    return { ownership, analysis, graph };
  }

  /** Full lattice for one company, with explainable paths. */
  companyDetail(companyId: string, asOf?: string) {
    const res = this.ensureResolved();
    const { ownership, analysis, graph } = this.evaluateOwnership(asOf);
    const controller = analysis.byCompany.get(companyId) ?? null;
    const names = new Map(res.entities.map(e => [e.id, e.canonicalName]));
    const kinds = new Map(res.entities.map(e => [e.id, e.kind]));
    const holders = [...(ownership.direct.get(companyId) ?? new Map<string, number>())]
      .map(([holderId, pct]) => ({
        holderId,
        name: names.get(holderId) ?? holderId,
        kind: kinds.get(holderId) ?? 'company',
        pct,
        effective: ownership.matrix.get(holderId)?.get(companyId) ?? null,
      }))
      .sort((a, b) => b.pct - a.pct);
    const effectiveRows = ownership.companies.map(c => ({
      companyId: c,
      name: names.get(c) ?? c,
      pct: ownership.matrix.get(companyId)?.get(c) ?? 0,
    })).filter(r => r.pct > 1e-9).sort((a, b) => b.pct - a.pct);
    const paths = controller?.leaderEntityId
      ? enumeratePaths(companyId, controller.leaderEntityId, ownership.direct, names, kinds, { maxPaths: 30, minPct: 1e-5 })
      : { paths: [], truncatedCyclePct: 0, visitedCycleNodes: [] };
    return {
      company: res.entities.find(e => e.id === companyId) ?? null,
      asOf: asOf ?? null,
      holders,
      controller,
      effectiveRows,
      paths: paths.paths,
      truncatedCyclePct: paths.truncatedCyclePct,
      cycles: ownership.cycles,
      unbalanced: graph.diagnostics.unbalancedCompanies,
    };
  }

  listSnapshots(): SnapshotSummary[] {
    const relations = this.state.relations;
    const dates = new Set<string>();
    for (const h of this.state.dataset.holders) if (h.effectiveDate) dates.add(h.effectiveDate);
    for (const c of this.state.dataset.changes) if (c.changeDate) dates.add(c.changeDate);
    for (const r of relations) { dates.add(r.start); if (r.end) dates.add(r.end); }
    const sorted = [...dates].sort();
    // temporal breakpoints: dates at which the resolved ownership changes, plus year-end
    const interesting = new Set<string>();
    let lastSig = '';
    for (const d of sorted) {
      const { ownership } = this.evaluateOwnership(d);
      const sig = ownership.companies.map(c => {
        const ctrl = [...ownership.matrix.entries()]
          .map(([p, m]) => [p, m.get(c) ?? 0] as [string, number])
          .sort((a, b) => b[1] - a[1])[0];
        return `${c}:${ctrl?.[0] ?? '-'}:${(ctrl?.[1] ?? 0).toFixed(4)}`;
      }).join('|');
      if (sig !== lastSig) { interesting.add(d); lastSig = sig; }
    }
    for (const y of [2019, 2020, 2021, 2022, 2023, 2024]) interesting.add(`${y}-12-31`);
    const today = new Date().toISOString().slice(0, 10);
    interesting.add(today);
    return [...interesting].filter(d => d >= '2019-01-01' && d <= today).sort().map(date => {
      const { ownership, analysis, graph } = this.evaluateOwnership(date);
      return {
        date,
        label: date,
        companies: ownership.companies.length,
        personsWithHoldings: [...ownership.matrix.entries()].filter(([, m]) => [...m.values()].some(v => v > 1e-9)).length,
        cycles: ownership.cycles,
        dispersed: analysis.dispersed.length,
        unbalanced: graph.diagnostics.unbalancedCompanies.length,
      };
    });
  }

  /** Beneficial-owner list export (> 25% by default). */
  beneficialOwnersReport(asOf?: string, threshold = 0.25) {
    const res = this.ensureResolved();
    const { ownership, analysis } = this.evaluateOwnership(asOf);
    const names = new Map(res.entities.map(e => [e.id, e.canonicalName]));
    const rows: Array<{
      companyId: string; companyName: string; ownerId: string; ownerName: string;
      pct: number; legalPct: number; controller: string; controllerKind: string; basis: string;
    }> = [];
    for (const companyId of ownership.companies) {
      const ctrl = analysis.byCompany.get(companyId);
      for (const owner of ctrl?.beneficialOwners ?? []) {
        if (owner.pct <= threshold + 1e-9) continue;
        rows.push({
          companyId,
          companyName: names.get(companyId) ?? companyId,
          ownerId: owner.entityId,
          ownerName: names.get(owner.entityId) ?? owner.entityId,
          pct: owner.pct,
          legalPct: owner.legalPct,
          controller: ctrl?.leaderEntityId ? names.get(ctrl.leaderEntityId) ?? '' : '',
          controllerKind: ctrl?.kind ?? 'none',
          basis: ctrl?.basis ?? '',
        });
      }
    }
    return { rows, asOf: asOf ?? null, threshold };
  }

  // ---------- relations ----------

  addRelation(input: Omit<ManualRelation, 'id' | 'createdAt' | 'createdBy'> & { id?: string; createdBy?: string }): ManualRelation {
    const rel: ManualRelation = {
      ...input,
      id: input.id ?? `MR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdBy: input.createdBy ?? 'console-user',
      createdAt: new Date().toISOString(),
    };
    if (rel.type === 'concert' && rel.memberEntityIds.length < 2) throw new Error('一致行动关系至少需要两名成员');
    if (rel.type === 'nominee' && (!rel.nominalEntityId || !rel.actualEntityId)) throw new Error('代持关系需要指定名义持有人和实际出资人');
    if (rel.memberEntityIds.length === 0 && rel.type === 'nominee') {
      throw new Error('代持关系需要至少一名成员');
    }
    this.state.relations.push(rel);
    return rel;
  }

  updateRelation(id: string, patch: Partial<ManualRelation>) {
    const rel = this.state.relations.find(r => r.id === id);
    if (!rel) throw new Error('关系不存在');
    Object.assign(rel, patch, { id: rel.id });
    return rel;
  }

  deleteRelation(id: string) {
    const before = this.state.relations.length;
    this.state.relations = this.state.relations.filter(r => r.id !== id);
    return before !== this.state.relations.length;
  }

  // ---------- evaluation against stored truth ----------

  loadTruth() {
    const truthDir = join(ROOT, 'data', 'truth');
    const ctrlPath = join(truthDir, 'controllers.json');
    const clusterPath = join(truthDir, 'clusters.json');
    const mapPath = join(truthDir, 'record_map.json');
    if (![ctrlPath, clusterPath, mapPath].every(existsSync)) return null;
    return {
      controllers: JSON.parse(readFileSync(ctrlPath, 'utf8')) as TruthControllers,
      clusters: JSON.parse(readFileSync(clusterPath, 'utf8')) as {
        entities: Array<{ entity_id: string; kind: 'company' | 'person'; key: string; canonical_name: string }>;
      },
      recordMap: JSON.parse(readFileSync(mapPath, 'utf8')) as RecordMap,
    };
  }

  evaluateAgainstTruth(): EvaluateReport & { truthNames?: Record<string, string> } {
    const truth = this.loadTruth();
    if (!truth) {
      return { available: false, reason: '未找到 data/truth 下的基准数据，请先运行 npm run dataset && npm run ground-truth', entity: null, controllers: null, snapshotsCompared: [], generatedAt: new Date().toISOString() };
    }
    const res = this.ensureResolved();
    const holderTruth = new Map(Object.entries(truth.recordMap.personRecords));
    for (const [rid, key] of Object.entries(truth.recordMap.allCompanyHolderRecords)) {
      // company holders scored only in the company partition
      void rid; void key;
    }
    const companyTruth = new Map(Object.entries(truth.recordMap.companyRecords));
    const entity = evaluateEntityResolution(res.entities, holderTruth, companyTruth);

    // truth key of an entity = majority of its records' truth keys
    const truthKeyByEntity = new Map<string, string>();
    for (const e of res.entities) {
      const counts = new Map<string, number>();
      for (const rid of e.recordIds) {
        const k = holderTruth.get(rid) ?? companyTruth.get(rid);
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      if (counts.size) truthKeyByEntity.set(e.id, [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    }
    const entityToTruth = (id: string) => truthKeyByEntity.get(id) ?? null;

    // map truth company key -> entity id (majority over company records)
    const companyEntityByKey = new Map<string, string>();
    const keyCounts = new Map<string, Map<string, number>>();
    for (const [rid, key] of companyTruth) {
      const ent = res.companyRecordResolution.get(rid);
      if (!ent) continue;
      if (!keyCounts.has(key)) keyCounts.set(key, new Map());
      keyCounts.get(key)!.set(ent, (keyCounts.get(key)!.get(ent) ?? 0) + 1);
    }
    for (const [key, counts] of keyCounts) {
      companyEntityByKey.set(key, [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    }

    const snapshotsCompared: string[] = [];
    const predictions = [];
    for (const [snapshot, block] of Object.entries(truth.controllers)) {
      const { ownership, analysis } = this.evaluateOwnership(block.date);
      const controllers = new Map<string, ControllerResult>();
      for (const [companyId, ctrl] of analysis.byCompany) controllers.set(companyId, ctrl);
      // rename map keys to entity ids is already the case
      const comps: Array<[string, string]> = [];
      for (const [key, entityId] of companyEntityByKey) comps.push([key, entityId]);
      // evaluate per truth company by matching entity id
      for (const key of Object.keys(block.companies)) {
        const entityId = companyEntityByKey.get(key);
        if (!entityId) continue;
        predictions.push({
          snapshot, date: block.date, companyKey: key, companyName: entityId,
          controllers, ownership, entityToTruth,
        });
      }
      snapshotsCompared.push(snapshot);
    }
    const controllers = evaluateControllers(truth.controllers, predictions);
    const truthNames: Record<string, string> = {};
    for (const e of truth.clusters.entities) truthNames[e.key] = e.canonical_name;
    return {
      available: true,
      entity,
      controllers,
      snapshotsCompared,
      truthNames,
      generatedAt: new Date().toISOString(),
    };
  }

  exportState() {
    return {
      mappings: this.state.mappings,
      relations: this.state.relations,
      imports: this.state.imports,
      counts: {
        companies: this.state.dataset.companies.length,
        holders: this.state.dataset.holders.length,
        changes: this.state.dataset.changes.length,
        entities: this.state.entities.length,
      },
    };
  }

  useDefaultMappings() {
    this.state.mappings = {
      companies: structuredClone(DEFAULT_MAPPINGS.companies),
      holders: structuredClone(DEFAULT_MAPPINGS.holders),
      changes: structuredClone(DEFAULT_MAPPINGS.changes),
    };
  }

  useEnglishMappings() {
    this.state.mappings = {
      companies: structuredClone(ENGLISH_MAPPINGS.companies),
      holders: structuredClone(ENGLISH_MAPPINGS.holders),
      changes: structuredClone(ENGLISH_MAPPINGS.changes),
    };
  }
}
