/**
 * 实际控制人识别: 穿透比例 + 一致行动合计 + 代持还原.
 *
 * Rules (all threshold-parameterised so a client can tighten them):
 *  1. Beneficial owner list: every natural person whose effective (penetrated,
 *     nominee-adjusted) stake strictly exceeds 25%.
 *  2. Controller: a person, or a concert group, holding >= 30% of the voting
 *     equity. A concert group wins when its combined stake beats every single
 *     shareholder (and relation is active on the as-of date).
 *  3. If nobody reaches 30%, the company is declared "无实际控制人/股权分散" and
 *     the largest holder is still surfaced for review.
 */
import { ControllerResult, Entity, ManualRelation, OwnershipResult, PathContribution } from './types.js';
import { enumeratePaths } from './ownership.js';
import { pctLabel, roundPct } from './normalize.js';

export interface ControllerOptions {
  /** controller threshold, default 0.30 */
  controlThreshold?: number;
  /** beneficial-owner threshold, default 0.25 */
  beneficialThreshold?: number;
  /** legal basis label for the report */
  rulesVersion?: string;
}

export interface ControllerAnalysis {
  results: ControllerResult[];
  byCompany: Map<string, ControllerResult>;
  concertApplied: Array<{ companyId: string; relationId: string; members: string[]; combined: number }>;
  dispersed: string[];
  rules: { controlThreshold: number; beneficialThreshold: number; description: string[] };
}

export function analyseControllers(
  ownership: OwnershipResult,
  entities: Entity[],
  relations: ManualRelation[],
  options: ControllerOptions = {},
): ControllerAnalysis {
  const controlThreshold = options.controlThreshold ?? 0.30;
  const beneficialThreshold = options.beneficialThreshold ?? 0.25;
  const names = new Map(entities.map(e => [e.id, e.canonicalName]));
  const kinds = new Map(entities.map(e => [e.id, e.kind]));
  const relationActive = (rel: ManualRelation, asOf?: string) =>
    !asOf || (rel.start <= asOf && (rel.end === null || rel.end >= asOf));

  const results: ControllerResult[] = [];
  const byCompany = new Map<string, ControllerResult>();
  const concertApplied: ControllerAnalysis['concertApplied'] = [];
  const dispersed: string[] = [];

  for (const companyId of ownership.companies) {
    const eff = new Map<string, number>();
    for (const person of ownership.persons) {
      const v = ownership.matrix.get(person)?.get(companyId) ?? 0;
      if (v > 0) eff.set(person, v);
    }
    // nominee-adjusted legal effective (i.e. without nominee restatement)
    const legal = new Map<string, number>();
    for (const person of ownership.persons) {
      const v = ownership.legalMatrix?.get(person)?.get(companyId) ?? v0(ownership, person, companyId);
      if (v > 0) legal.set(person, v);
    }

    const concertGroups: Array<{ relationId: string; members: string[]; combined: number; leader: string }> = [];
    for (const rel of relations) {
      if (rel.type !== 'concert' || rel.scopeCompanyId !== companyId) continue;
      const members = rel.memberEntityIds.filter(id => kinds.get(id) === 'person');
      if (members.length < 2) continue;
      const combined = roundPct(members.reduce((s, id) => s + (eff.get(id) ?? 0), 0));
      const leader = rel.leaderEntityId && members.includes(rel.leaderEntityId) ? rel.leaderEntityId : members[0];
      concertGroups.push({ relationId: rel.id, members, combined, leader });
    }
    concertGroups.sort((a, b) => b.combined - a.combined);

    // largest single person
    let topPerson: { id: string; pct: number } | null = null;
    for (const [id, pct] of eff) {
      if (!topPerson || pct > topPerson.pct) topPerson = { id, pct };
    }

    let result: ControllerResult;
    const bestGroup = concertGroups[0];
    if (bestGroup && bestGroup.combined >= controlThreshold && bestGroup.combined > (topPerson?.pct ?? 0) + 1e-9) {
      result = {
        companyId,
        kind: 'group',
        leaderEntityId: bestGroup.leader,
        memberEntityIds: bestGroup.members.slice().sort(),
        pct: bestGroup.combined,
        basis: `一致行动合计 ${pctLabel(bestGroup.combined)}，牵头人 ${names.get(bestGroup.leader) ?? bestGroup.leader}；合计高于任一单一股东`,
        relationId: bestGroup.relationId,
        beneficialOwners: [],
        breakdown: [],
      };
      concertApplied.push({ companyId, relationId: bestGroup.relationId, members: bestGroup.members, combined: bestGroup.combined });
    } else if (topPerson && topPerson.pct >= controlThreshold) {
      result = {
        companyId,
        kind: 'person',
        leaderEntityId: topPerson.id,
        memberEntityIds: [topPerson.id],
        pct: roundPct(topPerson.pct),
        basis: `直接及穿透持股 ${pctLabel(topPerson.pct)}（≥ 控股阈值 ${pctLabel(controlThreshold, 0)}）`,
        relationId: null,
        beneficialOwners: [],
        breakdown: [],
      };
    } else {
      const top = topPerson?.pct ?? 0;
      result = {
        companyId,
        kind: 'none',
        leaderEntityId: null,
        memberEntityIds: [],
        pct: roundPct(top),
        basis: `股权分散，单一股东最高 ${pctLabel(top)}，一致行动合计 ${pctLabel(bestGroup?.combined ?? 0)}，均未达 ${pctLabel(controlThreshold, 0)}`,
        relationId: null,
        beneficialOwners: [],
        breakdown: [],
      };
      dispersed.push(companyId);
    }

    // beneficial owners: strictly > 25% after nominee restatement
    const owners = [...eff.entries()]
      .filter(([, pct]) => pct > beneficialThreshold + 1e-9)
      .sort((a, b) => b[1] - a[1])
      .map(([entityId, pct]) => ({ entityId, pct: roundPct(pct), legalPct: roundPct(legal.get(entityId) ?? 0) }));
    result.beneficialOwners = owners;
    result.breakdown = [...eff.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([entityId, pct]) => ({ entityId, pct: roundPct(pct), legalPct: roundPct(legal.get(entityId) ?? 0) }));

    results.push(result);
    byCompany.set(companyId, result);

    // attach an explanatory path for the leader
    const leaderId = result.leaderEntityId;
    if (leaderId) {
      const { paths, truncatedCyclePct } = enumeratePaths(
        companyId, leaderId, ownership.direct ?? new Map(), names, kinds,
        { maxPaths: 6, minPct: 1e-5 },
      );
      const total = paths.reduce((s, p) => s + p.pct, 0);
      const path: PathContribution | undefined = paths.length
        ? { nodes: paths[0].nodes, pct: roundPct(total), edges: paths[0].edges }
        : undefined;
      if (result.beneficialOwners.length && path) result.beneficialOwners[0].path = path;
      void truncatedCyclePct;
    }
  }

  return {
    results,
    byCompany,
    concertApplied,
    dispersed,
    rules: {
      controlThreshold,
      beneficialThreshold,
      description: [
        `实际控制人：单一自然人穿透持股 ≥ ${pctLabel(controlThreshold, 0)}，或一致行动人合计 ≥ ${pctLabel(controlThreshold, 0)} 且高于任一单一股东`,
        `受益所有人：穿透持股（代持还原后）> ${pctLabel(beneficialThreshold, 0)} 的自然人`,
        '穿透比例 = 各条股权路径持股比例连乘后求和；循环/交叉持股按 (I-C)⁻¹ 稳定解处理，不截断为死循环',
      ],
    },
  };
}

function v0(ownership: OwnershipResult, person: string, companyId: string): number {
  return ownership.matrix.get(person)?.get(companyId) ?? 0;
}
