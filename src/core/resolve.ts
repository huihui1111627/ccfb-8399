/**
 * 主体消歧: companies -> entity clusters by USCC / aliases, persons -> clusters by
 * ID fragments, role & address correlation. Conflict-first agglomeration so a
 * different ID always wins over a coincidentally equal name (or even address).
 */
import crypto from 'node:crypto';
import {
  Dataset, Entity, MergeEvidence, RawCompanyRecord, RawHolderRecord, RawChangeRecord,
} from './types.js';
import {
  addressKey, companyNameKey, coreCompanyName, extractIdFragment, idCompatibility, idRegion, idTail,
  isCompanyLikeName, isPersonLikeName, personNameKey, personNameSimilarity, stripCityPrefix,
  stripLegalSuffix, toHalfWidth,
} from './normalize.js';

export interface ResolutionOptions {
  /** manual decision: record ids that must be treated as the same person/company */
  forcedMerges?: Array<[string, string]>;
  /**
   * manual decision: each entry pulls the listed records out of the cluster they
   * would otherwise join and gives them their own subject.
   */
  forcedSplits?: Array<{ entityId: string; recordIds: string[]; note?: string }>;
  personMergeThreshold?: number;
}

export interface ResolutionResult {
  companies: Entity[];
  persons: Entity[];
  entities: Entity[];
  /** raw holder record id -> entity id */
  holderResolution: Map<string, string>;
  /** raw company record id -> company entity id */
  companyRecordResolution: Map<string, string>;
  unresolvedCompanies: Array<{ recordId: string; name: string }>;
  conflicts: Array<{ a: string; b: string; reason: string }>;
  diagnostics: {
    personNameGroups: Array<{ nameKey: string; entityIds: string[]; reason: string }>;
    recordsWithoutUscc: number;
    recordsMergedByAlias: number;
    personRecordsWithoutId: number;
  };
}

function hashId(prefix: string, seed: string): string {
  return `${prefix}-${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8)}`;
}

interface NameGroup { key: string; names: Set<string>; }

/** Company clustering. */
function resolveCompanies(dataset: Dataset) {
  const records = dataset.companies;
  const changeAliases: Array<[string, string]> = [];
  for (const ch of dataset.changes) {
    if (/名称变更/.test(ch.item) && ch.before && ch.after) {
      changeAliases.push([companyNameKey(ch.before), companyNameKey(ch.after)]);
    }
  }

  // union-find over records
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (p !== x) { p = find(p); parent.set(x, p); }
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const r of records) parent.set(r.recordId, r.recordId);

  // 1) same non-empty USCC
  const byUscc = new Map<string, string[]>();
  for (const r of records) {
    if (!r.uscc) continue;
    const list = byUscc.get(r.uscc) ?? [];
    list.push(r.recordId);
    byUscc.set(r.uscc, list);
  }
  for (const list of byUscc.values()) for (let i = 1; i < list.length; i++) union(list[0], list[i]);

  // 2) alias edges from change records
  const nameToRecords = new Map<string, string[]>();
  for (const r of records) {
    const key = companyNameKey(r.name);
    const list = nameToRecords.get(key) ?? [];
    list.push(r.recordId);
    nameToRecords.set(key, list);
    for (const n of splitList(r.formerNames)) {
      const k = companyNameKey(n);
      const l2 = nameToRecords.get(k) ?? [];
      l2.push(r.recordId);
      nameToRecords.set(k, l2);
    }
    if (r.shortName) {
      const k = companyNameKey(r.shortName);
      const l3 = nameToRecords.get(k) ?? [];
      l3.push(r.recordId);
      nameToRecords.set(k, l3);
    }
  }
  for (const [a, b] of changeAliases) {
    const ra = nameToRecords.get(a), rb = nameToRecords.get(b);
    if (ra && rb) { union(ra[0], rb[0]); }
  }

  // 3) attach records without a USCC group by exact alias, then city-prefix + same address
  const buildEntities = () => {
    const groups = new Map<string, RawCompanyRecord[]>();
    for (const r of records) {
      const root = find(r.recordId);
      const list = groups.get(root) ?? [];
      list.push(r);
      groups.set(root, list);
    }
    return [...groups.values()];
  };

  const aliasEvidence = new Map<string, string>();
  let groups = buildEntities();
  const aliasesOf = (g: RawCompanyRecord[]) => {
    const set = new Set<string>();
    for (const r of g) {
      set.add(companyNameKey(r.name));
      for (const n of splitList(r.formerNames)) set.add(companyNameKey(n));
      if (r.shortName) set.add(companyNameKey(r.shortName));
    }
    return set;
  };
  const unnamedGroups = groups.filter(g => !g.some(r => r.uscc));
  const namedGroups = groups.filter(g => g.some(r => r.uscc));
  let mergedByAlias = 0;
  // Compare records without a USCC against the registered groups. Evidence, in
  // decreasing strength: identical name, identical alias, same core name (city /
  // legal suffix stripped) + same address, or one core name a prefix of the
  // other (short name) + same address. Different core names never merge.
  for (const g of unnamedGroups) {
    const names = aliasesOf(g);
    const cores = new Set([...names].map(coreCompanyName).filter(Boolean));
    const addrKeys = new Set(g.map(r => addressKey(r.address)).filter(Boolean));
    let best: { group: RawCompanyRecord[]; score: number; why: string } | null = null;
    for (const target of namedGroups) {
      const tNames = aliasesOf(target);
      const tCores = new Set([...tNames].map(coreCompanyName).filter(Boolean));
      const tAddr = new Set(target.map(r => addressKey(r.address)).filter(Boolean));
      const sameAddr = [...addrKeys].some(a => tAddr.has(a));
      let score = 0;
      let why = '';
      for (const n of names) if (tNames.has(n)) { score = 1; why = 'identical-name'; }
      for (const nc of cores) {
        for (const tc of tCores) {
          if (nc && nc === tc && sameAddr) { if (score < 0.95) { score = 0.95; why = 'core-name+address'; } }
          else if (sameAddr && (isAbbrevOf(tc, nc) || isAbbrevOf(nc, tc))) {
            if (score < 0.85) { score = 0.85; why = 'abbrev+address'; }
          }
        }
      }
      if (score > 0 && (!best || score > best.score)) best = { group: target, score, why };
    }
    if (best && best.score >= 0.85) {
      union(g[0].recordId, best.group[0].recordId);
      mergedByAlias++;
      aliasEvidence.set(best.group[0].recordId, best.why);
    }
  }

  groups = buildEntities();
  const recordResolution = new Map<string, string>();
  const entities: Entity[] = [];
  for (const g of groups) {
    const id = hashId('CO', g.map(r => r.uscc || r.name).sort()[0] + '|' + g.map(r => r.name).sort()[0]);
    // Canonical name: prefer the *current* registered name (latest snapshot, with
    // a USCC); a former name must never win just because it is longer.
    const best = [...g].sort((a, b) => {
      const score = (r: RawCompanyRecord) => {
        let v = 0;
        if (r.uscc) v += 4;
        if (/有限公司|合伙企业|集团/.test(r.name)) v += 3;
        // later snapshot wins; annual-report / third-party rows are secondary
        const snap = r.snapshotDate || '1990-01-01';
        v += Math.min(3, Number(snap.slice(0, 4)) - 1990) / 3;
        if (r.source === '工商公示') v += 2;
        return v;
      };
      return score(b) - score(a);
    })[0];
    const aliases = new Set<string>([best.name]);
    const addresses = new Set<string>();
    const legalReps = new Set<string>();
    for (const r of g) {
      if (r.name) aliases.add(r.name);
      for (const n of splitList(r.formerNames)) aliases.add(n);
      if (r.shortName) aliases.add(r.shortName);
      if (r.address) addresses.add(r.address);
      if (r.legalRep) legalReps.add(personNameKey(r.legalRep));
    }
    const hasUscc = g.some(r => r.uscc);
    const aliasWhy = aliasEvidence.get(g[0].recordId);
    entities.push({
      id,
      kind: 'company',
      canonicalName: best.name,
      aliases: [...aliases],
      uscc: g.find(r => r.uscc)?.uscc ?? null,
      addresses: [...addresses],
      legalReps: [...legalReps],
      idFragments: [],
      recordIds: g.map(r => r.recordId),
      confidence: hasUscc ? 1 : 0.72,
      evidence: [{
        rule: hasUscc ? 'uscc' : 'name-address',
        detail: hasUscc
          ? `统一社会信用代码 ${g.find(r => r.uscc)?.uscc}${aliasWhy ? `；另有 ${g.length - 1} 条无代码记录按 ${aliasWhy} 归并` : ''}`
          : '无统一社会信用代码，按名称+地址归并',
        confidence: hasUscc ? 1 : 0.72,
      }],
      createdAt: '',
    });
    for (const r of g) recordResolution.set(r.recordId, id);
  }

  return { entities, recordResolution, mergedByAlias, recordsWithoutUscc: records.filter(r => !r.uscc).length };
}

function splitList(s: string): string[] {
  if (!s) return [];
  return s.split(/[;；,，|]/).map(x => x.trim()).filter(Boolean);
}

interface PersonObs {
  recordId: string;
  nameKey: string;
  nameRaw: string;
  idFragment: string;
  addressKey: string;
  /** names (normalised) of the companies in whose cap table this obs appears */
  companies: string[];
  positions: string[];
  dates: string[];
  isLegalRep: boolean;
  /** operator-supplied name for a manually split record */
  displayName?: string;
}

function resolvePersons(
  dataset: Dataset,
  companyIdOfHolderRecord: Map<string, string>,
  isKnownCompany: (raw: string) => boolean,
  options: ResolutionOptions,
  trace?: (m: string) => void,
) {
  const obs: PersonObs[] = [];
  const threshold = options.personMergeThreshold ?? 0.5;
  // Each manual split is a *group*: the records the operator pulled out keep
  // their own identity and must never fall back into the source cluster.
  const splitTagByRecord = new Map<string, string>();
  const splitNameByRecord = new Map<string, string>();
  for (const split of options.forcedSplits ?? []) {
    for (const rid of split.recordIds) {
      splitTagByRecord.set(rid, split.entityId);
      if (split.note) splitNameByRecord.set(rid, split.note);
    }
  }
  const forcedSplits = new Set(splitTagByRecord.keys());
  const forcedMerges = options.forcedMerges ?? [];
  for (const h of dataset.holders) {
    if (isKnownCompany(h.holderName)) continue;
    // Structured holder types are authoritative: 企业法人/合伙 never becomes a person.
    if (/(企业|法人|公司|机构|合伙|合伙)/.test(h.holderType) && !/自然人|个人/.test(h.holderType)) continue;
    const typeSaysCompany = /(企业|法人|公司|机构|合伙)/.test(h.holderType) && !/自然人|个人/.test(h.holderType);
    if (typeSaysCompany && !isPersonLikeName(h.holderName)) continue;
    if (!isPersonLikeName(h.holderName)) continue;
    const nameKey = personNameKey(h.holderName);
    if (!nameKey) continue;
    obs.push({
      recordId: h.recordId,
      nameKey,
      nameRaw: h.holderName,
      idFragment: splitTagByRecord.has(h.recordId)
        ? `SPLIT-${splitTagByRecord.get(h.recordId)}`
        : extractIdFragment(h.holderName, h.idNumber),
      displayName: splitNameByRecord.get(h.recordId),
      addressKey: addressKey(h.holderAddress),
      companies: [companyIdOfHolderRecord.get(h.recordId) ?? companyNameKey(h.companyName)],
      positions: h.position ? [h.position] : [],
      dates: h.effectiveDate ? [h.effectiveDate] : [],
      isLegalRep: false,
    });
  }
  for (const c of dataset.companies) {
    if (!c.legalRep) continue;
    const nameKey = personNameKey(c.legalRep);
    if (!nameKey) continue;
    obs.push({
      recordId: `LEGAL:${c.recordId}`,
      nameKey,
      nameRaw: c.legalRep,
      idFragment: '',
      addressKey: '',
      companies: [companyIdOfHolderRecord.get('LEGAL:' + c.recordId) ?? companyNameKey(c.name)],
      positions: ['法定代表人'],
      dates: [c.snapshotDate].filter(Boolean),
      // legal-rep rows never carry an address: do not count them as "no ID"
      // evidence against an explicit same-address merge
      isLegalRep: true,
    });
  }

  const forcedMergePairs = new Set(forcedMerges.map(p => p.join('|')));
  const forcedMergeRev = new Set(forcedMerges.map(p => p.slice().reverse().join('|')));

  const allEntities: Entity[] = [];
  const holderResolution = new Map<string, string>();
  const groupsDiagnostics: ResolutionResult['diagnostics']['personNameGroups'] = [];
  const conflicts: ResolutionResult['conflicts'] = [];
  let recordsWithoutId = 0;

  // Manual merges cross the name gate by design (e.g. a person registered under
  // an alias). Give every forced pair a shared synthetic name group first.
  const mergeGroup = new Map<string, string>();
  for (const [a, b] of forcedMerges) {
    const ga = mergeGroup.get(a) ?? a;
    const gb = mergeGroup.get(b) ?? b;
    const root = [ga, gb].sort()[0];
    for (const [k, v] of mergeGroup) if (v === ga || v === gb) mergeGroup.set(k, root);
    mergeGroup.set(a, root);
    mergeGroup.set(b, root);
  }

  // Group observations by *exact normalised display name* first. Only identical
  // names are candidates for the same natural person; fuzzy name similarity is
  // reported for manual review but never auto-merges.
  const byName = new Map<string, PersonObs[]>();
  for (const o of obs) {
    const list = byName.get(o.nameKey) ?? [];
    list.push(o);
    byName.set(o.nameKey, list);
  }

  for (const [nameKey, list] of byName) {
    // Cluster within this name:
    //  1. identical / wildcard-compatible ID fragments fuse unconditionally
    //  2. observations without an ID attach to the strongest compatible cluster
    //     (same region+tail, same company + same role, same address), but never
    //     to a cluster with a conflicting ID
    //  3. observations with conflicting IDs stay in separate clusters
    type Clu = PersonCluster;
    let clusters: Clu[] = list.map(o => ({
      members: [o],
      ids: new Set(o.idFragment ? [o.idFragment] : []),
      addr: new Map(o.addressKey ? [[o.addressKey, 1]] : []),
      companies: new Set(o.companies.map(c => 'co|' + c)),
      positions: new Set(o.positions),
      names: new Set([o.nameKey]),
    }));

    const idConflicts = (a: Clu, b: Clu): boolean => {
      for (const x of a.ids) for (const y of b.ids) if (idCompatibility(x, y) === 'conflict') return true;
      return false;
    };
    const manuallyMerged = (a: Clu, b: Clu): boolean =>
      a.members.some(m => b.members.some(n =>
        forcedMergePairs.has(m.recordId + '|' + n.recordId) || forcedMergeRev.has(m.recordId + '|' + n.recordId)));
    const idSupports = (a: Clu, b: Clu): 'full' | 'tail' | null => {
      for (const x of a.ids) for (const y of b.ids) {
        const c = idCompatibility(x, y);
        if (c === 'same-full') return 'full';
        if (c === 'same-tail') return 'tail';
      }
      return null;
    };
    const scorePair = (a: Clu, b: Clu): { score: number; evidence: MergeEvidence[] } => {
      const ev: MergeEvidence[] = [];
      let score = 0;
      if (!namesCompatible(a.names, b.names)) return { score: 0, evidence: [] };
      const idSup = idSupports(a, b);
      if (idSup === 'full') {
        score = 1;
        ev.push({ rule: 'id-full-match', detail: '证件号（掩码按通配）一致', confidence: 1 });
      } else if (idSup === 'tail') {
        const x = [...a.ids][0], y = [...b.ids][0];
        const sameRegion = idRegion(x) !== '' && idRegion(x) === idRegion(y);
        score = Math.max(score, sameRegion ? 0.9 : 0.35);
        ev.push({
          rule: sameRegion ? 'id-region-tail' : 'id-tail-only',
          detail: sameRegion ? `证件号前6位与后4位一致（${idRegion(x)}…${idTail(x)}）` : `仅证件号后4位一致（${idTail(x)}）`,
          confidence: sameRegion ? 0.9 : 0.35,
        });
      }
      const sharedCompanies = [...a.companies].filter(x => b.companies.has(x));
      if (sharedCompanies.length) {
        const samePos = [...a.positions].some(p => b.positions.has(p));
        score = Math.max(score, samePos ? 0.82 : 0.6);
        ev.push({
          rule: samePos ? 'same-company-role' : 'same-company',
          detail: `同任职于 ${sharedCompanies.slice(0, 3).map(c => c.replace('co|', '')).join('、')}${samePos ? '，职务相同' : ''}`,
          confidence: samePos ? 0.78 : 0.6,
        });
      }
      const sharedAddr = [...a.addr.keys()].some(x => b.addr.has(x));
      if (sharedAddr) {
        score = Math.max(score, 0.6);
        ev.push({ rule: 'same-address', detail: '股东地址相同', confidence: 0.6 });
      }
      score = Math.max(score, 0.3);
      ev.push({ rule: 'same-name', detail: `名称相同：${nameKey}`, confidence: 0.3 });
      if (idConflicts(a, b)) {
        return { score: 0, evidence: [...ev, { rule: 'id-conflict', detail: '证件号存在冲突位，禁止合并', confidence: 1 }] };
      }
      return { score, evidence: ev };
    };

    for (let guard = 0; guard < 2000; guard++) {
      let best: { i: number; j: number; score: number } | null = null;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const splitA = clusters[i].members.some(m => forcedSplits.has(m.recordId));
          const splitB = clusters[j].members.some(m => forcedSplits.has(m.recordId));
          if (splitA && splitB) continue;
          const pair = scorePair(clusters[i], clusters[j]);
          if (pair.score >= threshold && (!best || pair.score > best.score)) best = { i, j, score: pair.score };
        }
      }
      if (!best) break;
      clusters = mergeClusters(clusters, best.i, best.j);
    }

    // A person known only as a legal representative on a stale/historic company
    // row carries no ownership information; do not emit a standalone entity for
    // them (they attach to a real owner cluster when the name/ID matches).
    clusters = clusters.filter(c => c.members.some(m => !m.isLegalRep || m.idFragment));
    // forced merges are definite even across display names / ID conflicts
    for (let guard = 0; guard < clusters.length; guard++) {
      const mergedGroups = new Set<string>();
      let changed = false;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const ga = clusters[i].members.map(m => mergeGroup.get(m.recordId) ?? m.recordId);
          const gb = clusters[j].members.map(m => mergeGroup.get(m.recordId) ?? m.recordId);
          const shared = ga.filter(x => gb.includes(x) && mergeGroup.has(x));
          if (shared.length && !mergedGroups.has(shared[0])) {
            mergedGroups.add(shared[0]);
            clusters = mergeClusters(clusters, i, j);
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
      if (!changed) break;
    }
    if (clusters.length > 1) {
      conflicts.push({
        a: nameKey, b: nameKey,
        reason: `同名「${nameKey}」按证件号拆分为 ${clusters.length} 个自然人以避免误并`,
      });
    }
    recordsWithoutId += list.filter(o => !o.idFragment && !o.isLegalRep).length;

    for (const clu of clusters) {
      const ids = [...clu.ids];
      const manualName = clu.members.map(m => m.displayName).find(Boolean);
      const id = hashId('PE', `${manualName ?? nameKey}|${ids.slice().sort()[0] ?? clu.members[0].recordId}`);
      const canonical = manualName ?? nameKey;
      const aliases = [...new Set(clu.members.map(m => m.nameRaw))];
      const evidence: MergeEvidence[] = [];
      if (ids.length) evidence.push({ rule: 'id-fragment', detail: `证件片段 ${ids.join(' / ')}`, confidence: 1 });
      const addr = [...clu.addr.keys()];
      if (addr.length) evidence.push({ rule: 'address', detail: `关联地址 ${addr.slice(0, 2).join(' / ')}`, confidence: 0.6 });
      const comps = [...clu.companies].map(c => c.replace('co|', ''));
      evidence.push({ rule: 'company-role', detail: `出现于 ${comps.slice(0, 5).join('、')}${comps.length > 5 ? ' 等' : ''}`, confidence: 0.5 });
      if (ids.length === 0) evidence.push({ rule: 'no-id', detail: '无证件号，仅按名称/任职/地址推断', confidence: 0.4 });
      const ent: Entity = {
        id, kind: 'person', canonicalName: canonical, aliases,
        uscc: null, addresses: addr, legalReps: [], idFragments: ids,
        recordIds: clu.members.map(m => m.recordId),
        confidence: ids.length ? 0.92 : 0.55,
        evidence, createdAt: '',
      };
      allEntities.push(ent);
      for (const m of clu.members) {
        if (!m.isLegalRep) holderResolution.set(m.recordId, id);
      }
    }
    if (clusters.length === 1 && clusters[0].members.length > 1) {
      groupsDiagnostics.push({
        nameKey, entityIds: [hashId('PE', `${nameKey}|${[...clusters[0].ids].sort()[0] ?? clusters[0].members[0].recordId}`)],
        reason: `${clusters[0].members.length} 条同名记录按证件片段/任职/地址归并为同一自然人`,
      });
    }
  }

  return { entities: allEntities, holderResolution, groupsDiagnostics, conflicts, recordsWithoutId };
}

/** one is a meaningful prefix of the other (short name vs full name). */
function isAbbrevOf(short: string, full: string): boolean {
  if (!short || !full || short.length >= full.length) return false;
  if (short.length < 2) return false;
  return full.startsWith(short);
}

/** Same normalised name (or one is a strict substring and short enough to be an abbreviation). */
function namesCompatible(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) for (const y of b) {
    if (x === y) return true;
    if (personNameSimilarity(x, y) >= 0.9) return true;
  }
  return false;
}

interface PersonCluster {
  members: PersonObs[];
  ids: Set<string>;
  addr: Map<string, number>;
  companies: Set<string>;
  positions: Set<string>;
  names: Set<string>;
}

function mergeClusters<T extends PersonCluster>(clusters: T[], i: number, j: number): T[] {
  const a = clusters[i], b = clusters[j];
  const addr = new Map(a.addr);
  for (const [k, v] of b.addr) addr.set(k, (addr.get(k) ?? 0) + v);
  const merged = {
    members: [...a.members, ...b.members],
    ids: new Set([...a.ids, ...b.ids]),
    addr,
    companies: new Set([...a.companies, ...b.companies]),
    positions: new Set([...a.positions, ...b.positions]),
    names: new Set([...a.names, ...b.names]),
  } as unknown as T;
  const out = [...clusters];
  out[i] = merged;
  out.splice(j, 1);
  return out;
}

/** Public entry point. */
export function resolveEntities(dataset: Dataset, options: ResolutionOptions = {}): ResolutionResult {
  const co = resolveCompanies(dataset);
  const companies = co.entities;
  const companyByName = new Map<string, Entity>();
  for (const e of companies) {
    for (const a of e.aliases) {
      const k = companyNameKey(a);
      companyByName.set(k, e);
      companyByName.set(companyNameKey(stripCityPrefix(k)), e);
    }
  }

  // resolve each holder record to a company entity (the company whose cap table it is)
  const holderRecordCompany = new Map<string, string>();
  const unresolvedHolderCompanies: Array<{ recordId: string; name: string }> = [];
  for (const h of dataset.holders) {
    let e = companyByName.get(companyNameKey(h.companyName)) ?? companyByName.get(companyNameKey(stripCityPrefix(h.companyName)));
    if (!e) {
      const trimmed = companyNameKey(h.companyName).replace(/[()]/g, '');
      e = companyByName.get(trimmed) ?? companyByName.get(companyNameKey(stripCityPrefix(trimmed)));
    }
    if (e) holderRecordCompany.set(h.recordId, e.id);
    else unresolvedHolderCompanies.push({ recordId: h.recordId, name: h.companyName });
  }
  // change records too (for history)
  for (const c of dataset.changes) {
    const k = companyNameKey(c.companyName);
    companyByName.get(k) ?? companyByName.get(companyNameKey(stripCityPrefix(k)));
  }

  // holder records that are companies resolve against company entities
  const companyByExactAlias = new Map<string, Entity>();
  for (const e of companies) {
    for (const a of e.aliases) {
      const k = companyNameKey(a);
      const core = coreCompanyName(k);
      companyByExactAlias.set(k, e);
      companyByExactAlias.set(companyNameKey(stripCityPrefix(k)), e);
      companyByExactAlias.set('core|' + core, e);
      companyByExactAlias.set('core|' + companyNameKey(stripCityPrefix(core)), e);
    }
  }
  const isKnownCompany = (raw: string): boolean => {
    const k = companyNameKey(raw);
    if (companyByExactAlias.has(k) || companyByExactAlias.has(companyNameKey(stripCityPrefix(k)))) return true;
    // a registered holder may be written as a short name that merely prefixes
    // the registered core name (启明汇智 vs 启明汇智科技), so test both directions
    const core = coreCompanyName(k);
    for (const [key, value] of companyByExactAlias) {
      if (!key.startsWith('core|')) continue;
      const registered = key.slice(5);
      if (registered && core && (registered.startsWith(core) || core.startsWith(registered)) && core.length >= 2) return true;
      void value;
    }
    return false;
  };
  const per = resolvePersons(dataset, holderRecordCompany, isKnownCompany, options);
  const unresolvedHolders: Array<{ recordId: string; name: string }> = [];
  for (const h of dataset.holders) {
    if (per.holderResolution.has(h.recordId)) continue;
    const typeSaysCompany = /(企业|法人|公司|机构|合伙)/.test(h.holderType) && !/自然人|个人/.test(h.holderType);
    if (!typeSaysCompany && isPersonLikeName(h.holderName) && !isCompanyLikeName(h.holderName)) {
      // person not captured (rare) -> force person entity
      const key = personNameKey(h.holderName);
      const id = hashId('PE', key);
      let ent = per.entities.find(e => e.id === id);
      if (!ent) {
        ent = {
          id, kind: 'person', canonicalName: key, aliases: [h.holderName], uscc: null,
          addresses: h.holderAddress ? [addressKey(h.holderAddress)] : [], legalReps: [], idFragments: [],
          recordIds: [], confidence: 0.4, evidence: [{ rule: 'fallback', detail: '仅按名称建立主体', confidence: 0.4 }], createdAt: '',
        };
        per.entities.push(ent);
      }
      ent.recordIds.push(h.recordId);
      per.holderResolution.set(h.recordId, id);
      continue;
    }
    const k = companyNameKey(h.holderName);
    const k2 = companyNameKey(stripCityPrefix(k));
    let ent = companyByExactAlias.get(k) ?? companyByExactAlias.get(k2);
    if (!ent) {
      const core = coreCompanyName(k);
      for (const [key, value] of companyByExactAlias) {
        if (!key.startsWith('core|')) continue;
        const registered = key.slice(5);
        if (registered && core && (registered.startsWith(core) || core.startsWith(registered)) && core.length >= 2) { ent = value; break; }
      }
    }
    if (ent) {
      per.holderResolution.set(h.recordId, ent.id);
      ent.recordIds.push(h.recordId);
    } else {
      unresolvedHolders.push({ recordId: h.recordId, name: h.holderName });
      // create placeholder company entity so graph is still complete
      const id = hashId('CO', 'unknown|' + k);
      const placeholder: Entity = {
        id, kind: 'company', canonicalName: stripNoise(h.holderName), aliases: [h.holderName], uscc: null,
        addresses: h.holderAddress ? [addressKey(h.holderAddress)] : [], legalReps: [], idFragments: [],
        recordIds: [h.recordId], confidence: 0.35,
        evidence: [{ rule: 'unregistered-holder', detail: '登记库中无对应企业记录，暂按名称建立主体', confidence: 0.35 }], createdAt: '',
      };
      if (!per.entities.find(e => e.id === id)) per.entities.push(placeholder as unknown as Entity);
      per.holderResolution.set(h.recordId, id);
    }
  }

  const entities = [...companies, ...per.entities];
  return {
    companies,
    persons: per.entities,
    entities,
    holderResolution: per.holderResolution,
    companyRecordResolution: co.recordResolution,
    unresolvedCompanies: [...unresolvedHolderCompanies, ...unresolvedHolders],
    conflicts: per.conflicts,
    diagnostics: {
      personNameGroups: per.groupsDiagnostics,
      recordsWithoutUscc: co.recordsWithoutUscc,
      recordsMergedByAlias: co.mergedByAlias,
      personRecordsWithoutId: per.recordsWithoutId,
    },
  };
}

function stripNoise(s: string): string { return s.replace(/\s+/g, ''); }
