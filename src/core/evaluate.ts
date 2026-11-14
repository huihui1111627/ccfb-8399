/** Reporting quality: compare system output against the independently stored truth. */
import { Entity } from './types.js';
import { ControllerResult, OwnershipResult } from './types.js';

export interface TruthCluster {
  entity_id: string;
  kind: 'company' | 'person';
  key: string;
  canonical_name: string;
  id_fragment?: string;
}

export interface TruthControllers {
  [snapshot: string]: {
    date: string;
    companies: Record<string, {
      controller: { kind: string; leader: string | null; members: string[]; pct: number };
      beneficial_owners: Array<{ person_id: string; pct: number }>;
      effective: Record<string, number>;
    }>;
  };
}

export interface RecordMap {
  companyRecords: Record<string, string>;
  personRecords: Record<string, string>;
  allCompanyHolderRecords: Record<string, string>;
}

export interface Bcubed {
  precision: number;
  recall: number;
  f1: number;
  records: number;
  correctPairs: number;
}

/** B-cubed precision/recall over predicted clusters vs. truth partitions. */
export function bcubed(predOf: Map<string, string>, trueOf: Map<string, string>): Bcubed {
  const ids = [...predOf.keys()].filter(k => trueOf.has(k));
  if (!ids.length) return { precision: 0, recall: 0, f1: 0, records: 0, correctPairs: 0 };
  const predGroups = new Map<string, Set<string>>();
  const trueGroups = new Map<string, Set<string>>();
  for (const id of ids) {
    const p = predOf.get(id)!;
    const t = trueOf.get(id)!;
    (predGroups.get(p) ?? predGroups.set(p, new Set()).get(p)!).add(id);
    (trueGroups.get(t) ?? trueGroups.set(t, new Set()).get(t)!).add(id);
  }
  let pSum = 0, rSum = 0;
  for (const id of ids) {
    const p = predGroups.get(predOf.get(id)!)!;
    const t = trueGroups.get(trueOf.get(id)!)!;
    let inter = 0;
    for (const x of p) if (t.has(x)) inter++;
    pSum += inter / p.size;
    rSum += inter / t.size;
  }
  const precision = pSum / ids.length;
  const recall = rSum / ids.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, records: ids.length, correctPairs: Math.round(pSum) };
}

export interface EntityEval {
  bcubed: Bcubed;
  /** true cluster key -> predicted cluster entity ids (should be exactly one) */
  splitTruth: Array<{ truth: string; predicted: string[]; records: number }>;
  /** predicted cluster -> true keys (should be exactly one) */
  mergedTruth: Array<{ predicted: string; truth: string[]; records: number }>;
  entitiesPredicted: number;
  entitiesTruth: number;
}

export function evaluateEntityResolution(
  entities: Entity[],
  holderTruth: Map<string, string>,
  companyTruth: Map<string, string>,
): { persons: EntityEval; companies: EntityEval } {
  const entityById = new Map(entities.map(e => [e.id, e]));
  const byRecord = new Map<string, string>();
  for (const e of entities) for (const rid of e.recordIds) byRecord.set(rid, e.id);

  const evalOne = (truth: Map<string, string>): EntityEval => {
    const predOf = new Map<string, string>();
    for (const rid of truth.keys()) {
      const p = byRecord.get(rid);
      if (p) predOf.set(rid, p);
    }
    const b = bcubed(predOf, truth);
    const trueToPred = new Map<string, Map<string, number>>();
    const predToTrue = new Map<string, Map<string, number>>();
    for (const [rid, pred] of predOf) {
      const t = truth.get(rid)!;
      if (!trueToPred.has(t)) trueToPred.set(t, new Map());
      if (!predToTrue.has(pred)) predToTrue.set(pred, new Map());
      trueToPred.get(t)!.set(pred, (trueToPred.get(t)!.get(pred) ?? 0) + 1);
      predToTrue.get(pred)!.set(t, (predToTrue.get(pred)!.get(t) ?? 0) + 1);
    }
    const splitTruth: EntityEval['splitTruth'] = [];
    for (const [t, m] of trueToPred) {
      if (m.size > 1) {
        splitTruth.push({ truth: t, predicted: [...m.entries()].map(([p, n]) => `${entityById.get(p)?.canonicalName ?? p}×${n}`), records: [...m.values()].reduce((a, b2) => a + b2, 0) });
      }
    }
    const mergedTruth: EntityEval['mergedTruth'] = [];
    for (const [p, m] of predToTrue) {
      if (m.size > 1) {
        mergedTruth.push({ predicted: entityById.get(p)?.canonicalName ?? p, truth: [...m.keys()], records: [...m.values()].reduce((a, b2) => a + b2, 0) });
      }
    }
    return {
      bcubed: b,
      splitTruth,
      mergedTruth,
      entitiesPredicted: predToTrue.size,
      entitiesTruth: trueToPred.size,
    };
  };

  return { persons: evalOne(holderTruth), companies: evalOne(companyTruth) };
}

export interface ControllerEvalRow {
  snapshot: string;
  companyKey: string;
  companyName: string;
  expectedLeader: string | null;
  actualLeader: string | null;
  expectedPct: number;
  actualPct: number;
  match: boolean;
  pctDelta: number;
  ownerSetMatch: boolean;
  expectedOwners: string[];
  actualOwners: string[];
}

export interface ControllerEval {
  rows: ControllerEvalRow[];
  accuracy: number;
  pctMae: number;
  ownerF1: number;
  bySnapshot: Array<{ snapshot: string; date: string; accuracy: number; total: number }>;
  confusion: Array<{ truth: string; predicted: string; count: number }>;
}

/**
 * Map predicted entities back to truth person keys via the majority truth key of
 * their contributing records, then compare leader identity + beneficial owners.
 */
export function evaluateControllers(
  truth: TruthControllers,
  predictions: Array<{
    snapshot: string;
    date: string;
    companyKey: string;
    companyName: string;
    controllers: Map<string, ControllerResult>;
    ownership: OwnershipResult;
    entityToTruth: (entityId: string) => string | null;
  }>,
): ControllerEval {
  const rows: ControllerEvalRow[] = [];
  for (const pred of predictions) {
    const t = truth[pred.snapshot];
    if (!t) continue;
    const truthCo = t.companies[pred.companyKey];
    if (!truthCo) continue;
    const actual = pred.controllers.get(pred.companyName);
    const actualLeader = actual?.leaderEntityId ? pred.entityToTruth(actual.leaderEntityId) : null;
    const expectedLeader = truthCo.controller.leader;
    const expectedOwners = truthCo.beneficial_owners.map(o => o.person_id).sort();
    // all predicted persons that resolve to truth keys and exceed 25%
    const actualOwners: string[] = [];
    for (const [entityId, farms] of pred.ownership.matrix) {
      const pct = farms.get(pred.companyName) ?? 0;
      if (pct > 0.25) {
        const key = pred.entityToTruth(entityId);
        if (key) actualOwners.push(key);
      }
    }
    actualOwners.sort();
    const sameSet = expectedOwners.length === actualOwners.length && expectedOwners.every((k, i) => k === actualOwners[i]);
    rows.push({
      snapshot: pred.snapshot,
      companyKey: pred.companyKey,
      companyName: pred.companyName,
      expectedLeader,
      actualLeader,
      expectedPct: truthCo.controller.pct,
      actualPct: actual?.pct ?? 0,
      match: expectedLeader === actualLeader,
      pctDelta: Math.abs((actual?.pct ?? 0) - truthCo.controller.pct),
      ownerSetMatch: sameSet,
      expectedOwners,
      actualOwners,
    });
  }
  const bySnapshotMap = new Map<string, { date: string; total: number; correct: number }>();
  for (const r of rows) {
    const cur = bySnapshotMap.get(r.snapshot) ?? { date: '', total: 0, correct: 0 };
    cur.total++;
    if (r.match) cur.correct++;
    bySnapshotMap.set(r.snapshot, cur);
  }
  const confusionMap = new Map<string, number>();
  for (const r of rows) {
    if (r.match) continue;
    const key = `${r.expectedLeader ?? '无'} → ${r.actualLeader ?? '无'}`;
    confusionMap.set(key, (confusionMap.get(key) ?? 0) + 1);
  }
  const tp = rows.reduce((s, r) => {
    const e = new Set(r.expectedOwners);
    const a = new Set(r.actualOwners);
    let inter = 0;
    for (const x of e) if (a.has(x)) inter++;
    return s + inter;
  }, 0);
  const eCount = rows.reduce((s, r) => s + r.expectedOwners.length, 0);
  const aCount = rows.reduce((s, r) => s + r.actualOwners.length, 0);
  const precision = aCount ? tp / aCount : 1;
  const recall = eCount ? tp / eCount : 1;
  return {
    rows,
    accuracy: rows.length ? rows.filter(r => r.match).length / rows.length : 0,
    pctMae: rows.length ? rows.reduce((s, r) => s + r.pctDelta, 0) / rows.length : 0,
    ownerF1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    bySnapshot: [...bySnapshotMap.entries()].map(([snapshot, v]) => ({ snapshot, date: v.date, accuracy: v.correct / v.total, total: v.total })),
    confusion: [...confusionMap.entries()].map(([k, count]) => {
      const [truth2, predicted] = k.split(' → ');
      return { truth: truth2, predicted, count };
    }).sort((a, b) => b.count - a.count),
  };
}
