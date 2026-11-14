/**
 * 股权穿透引擎.
 *
 * Effective ownership is the absorbing random-walk / Neumann-series definition
 *   U = D (I - C)^-1
 * where D holds direct person holdings and C holds corporate holdings. This is
 * exactly "sum over all ownership paths of the product of edge percentages",
 * which is well-defined (and finite) even with cycles and cross-holdings,
 * because every path step must be a real equity link.
 *
 * Two independent solvers are provided:
 *  - solveLinear: Gaussian elimination with partial pivoting (exact, cycle-safe)
 *  - solveIterative: endlessly re-distributing flow until the residual converges,
 *    reporting the convergence trace (used to demonstrate cyclic stability)
 * A DFS path enumerator additionally materialises the paths behind a number so
 * the UI can explain every basis point.
 */
import { Entity, ManualRelation, OwnershipEdge, OwnershipResult, PathContribution } from './types.js';
import { roundPct } from './normalize.js';

export interface BuildGraphOptions {
  /** Cut-off date (inclusive). Undefined = latest available. */
  asOf?: string;
  /** Include historical ownership rows whose effective date <= asOf (default true). */
  historical?: boolean;
}

export interface OwnershipRow {
  companyId: string;
  holderId: string;
  pct: number;
  effectiveDate: string;
  recordId: string;
  source: string;
  holderNameRaw: string;
  companyNameRaw: string;
}

export interface GraphBuild {
  edges: OwnershipEdge[];
  companies: string[];
  persons: string[];
  /** company -> holder -> pct (latest row at or before asOf) */
  direct: Map<string, Map<string, number>>;
  activeRelations: ManualRelation[];
  diagnostics: {
    unbalancedCompanies: Array<{ companyId: string; companyName: string; sum: number; normalised: boolean }>;
    droppedZero: number;
    supersededRows: number;
  };
}

/** Build the effective-dated ownership graph from raw rows. */
export function buildGraph(
  rows: OwnershipRow[],
  entities: Entity[],
  relations: ManualRelation[],
  options: BuildGraphOptions = {},
): GraphBuild {
  const byId = new Map(entities.map(e => [e.id, e]));
  const asOf = options.asOf;
  const companies = entities.filter(e => e.kind === 'company');
  const companyIds = companies.map(e => e.id);

  // For each (company, holder) keep the newest row <= asOf.
  const latest = new Map<string, OwnershipRow>();
  let superseded = 0;
  const sorted = [...rows].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  for (const r of sorted) {
    if (asOf && r.effectiveDate > asOf) { superseded++; continue; }
    const key = r.companyId + '|' + r.holderId;
    const prev = latest.get(key);
    if (!prev || prev.effectiveDate <= r.effectiveDate) latest.set(key, r);
  }

  const direct = new Map<string, Map<string, number>>();
  for (const c of companyIds) direct.set(c, new Map());
  let droppedZero = 0;
  for (const r of latest.values()) {
    if (!byId.has(r.holderId)) continue;
    if (r.pct <= 0) { droppedZero++; continue; }
    direct.get(r.companyId)!.set(r.holderId, roundPct(r.pct));
  }

  const activeRelations = relations.filter(rel => {
    if (!asOf) return rel.end === null;
    return rel.start <= asOf && (rel.end === null || rel.end >= asOf);
  });

  // balance diagnostics: sum of direct holders per company
  const unbalanced: GraphBuild['diagnostics']['unbalancedCompanies'] = [];
  for (const c of companyIds) {
    const m = direct.get(c)!;
    let sum = 0;
    for (const v of m.values()) sum += v;
    if (sum > 1.0000001 + 1e-9) {
      unbalanced.push({ companyId: c, companyName: byId.get(c)!.canonicalName, sum: roundPct(sum), normalised: true });
      for (const [h, v] of m) m.set(h, roundPct(v / sum));
    }
  }

  const edges: OwnershipEdge[] = [];
  for (const r of latest.values()) {
    const pct = direct.get(r.companyId)?.get(r.holderId);
    if (pct === undefined || pct <= 0) continue;
    edges.push({
      companyId: r.companyId,
      holderId: r.holderId,
      pct,
      effectiveDate: r.effectiveDate,
      recordId: r.recordId,
      source: r.source,
      holderNameRaw: r.holderNameRaw,
      companyNameRaw: r.companyNameRaw,
    });
  }

  const persons = entities.filter(e => e.kind === 'person').map(e => e.id);
  return {
    edges, companies: companyIds, persons, direct, activeRelations,
    diagnostics: { unbalancedCompanies: unbalanced, droppedZero, supersededRows: superseded },
  };
}

/** Apply manual nominee arrangements: move a nominee's holding to the actual owner. */
export function applyNominees(
  direct: Map<string, Map<string, number>>,
  relations: ManualRelation[],
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [co, row] of direct) out.set(co, new Map(row));
  for (const rel of relations) {
    if (rel.type !== 'nominee' || !rel.nominalEntityId || !rel.actualEntityId) continue;
    const co = rel.scopeCompanyId;
    const row = out.get(co);
    if (!row) continue;
    const pct = row.get(rel.nominalEntityId) ?? 0;
    if (pct <= 0) continue;
    row.set(rel.nominalEntityId, 0);
    row.set(rel.actualEntityId, roundPct((row.get(rel.actualEntityId) ?? 0) + pct));
  }
  return out;
}

/** Detect cycles among corporate holdings (each SCC with >1 node, or a self loop). */
export function findCycles(companyIds: string[], direct: Map<string, Map<string, number>>, entityNames: Map<string, string>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  const successors = (id: string): string[] => {
    const row = direct.get(id);
    if (!row) return [];
    return [...row.entries()].filter(([, p]) => p > 0).map(([h]) => h).filter(h => direct.has(h));
  };

  const strongConnect = (v: string) => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const w of successors(v)) {
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      const selfLoop = comp.length === 1 && successors(comp[0]).includes(comp[0]);
      if (comp.length > 1 || selfLoop) result.push(comp.reverse().map(id => entityNames.get(id) ?? id));
    }
  };

  for (const id of companyIds) if (!index.has(id)) strongConnect(id);
  return result;
}

function toIndex(companies: string[]): { idx: Map<string, number>; n: number } {
  const idx = new Map<string, number>();
  companies.forEach((c, i) => idx.set(c, i));
  return { idx, n: companies.length };
}

/** M = I - C, with C[i][j] = share of company j held by company i. */
function buildSystem(companies: string[], direct: Map<string, Map<string, number>>): Float64Array {
  const { idx, n } = toIndex(companies);
  const M = new Float64Array(n * n);
  for (let i = 0; i < n; i++) M[i * n + i] = 1;
  for (const [companyId, row] of direct) {
    const j = idx.get(companyId);
    if (j === undefined) continue;
    for (const [holderId, pct] of row) {
      const i = idx.get(holderId);
      if (i === undefined || pct <= 0) continue;
      // x_j = direct_j + sum_i pct_{i->j} x_i  =>  M[j][i] = -pct
      M[j * n + i] -= pct;
    }
  }
  return M;
}

export interface LinearSolution {
  /** personId -> companyId -> pct */
  matrix: Map<string, Map<string, number>>;
  /** companyId -> direct person holdings column (sum may be < 1) */
  residuals: Map<string, number>;
}

function gaussianSolve(M: Float64Array, n: number, b: Float64Array): Float64Array {
  const A = M.slice();
  const x = b.slice();
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r * n + col]) > Math.abs(A[pivot * n + col])) pivot = r;
    }
    if (Math.abs(A[pivot * n + col]) < 1e-14) continue; // singular column: leave as is
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const t = A[col * n + k]; A[col * n + k] = A[pivot * n + k]; A[pivot * n + k] = t;
      }
      const t = x[col]; x[col] = x[pivot]; x[pivot] = t;
    }
    const pv = A[col * n + col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r * n + col] / pv;
      if (f === 0) continue;
      for (let k = col; k < n; k++) A[r * n + k] -= f * A[col * n + k];
      x[r] -= f * x[col];
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = A[i * n + i];
    out[i] = Math.abs(d) < 1e-14 ? 0 : x[i] / d;
  }
  return out;
}

export interface SolveOptions {
  persons: string[];
  /** threshold below which numbers are treated as zero */
  epsilon?: number;
}

export function solveLinear(
  companies: string[],
  direct: Map<string, Map<string, number>>,
  options: SolveOptions,
): LinearSolution {
  const { idx, n } = toIndex(companies);
  const M = buildSystem(companies, direct);
  const matrix = new Map<string, Map<string, number>>();
  const eps = options.epsilon ?? 1e-12;
  for (const person of options.persons) {
    const b = new Float64Array(n);
    for (const [companyId, row] of direct) {
      const pct = row.get(person) ?? 0;
      if (pct <= 0) continue;
      const j = idx.get(companyId);
      if (j !== undefined) b[j] += pct;
    }
    if (b.every(v => v === 0)) { matrix.set(person, new Map()); continue; }
    const sol = gaussianSolve(M, n, b);
    const row = new Map<string, number>();
    companies.forEach((c, j) => {
      if (sol[j] > eps) row.set(c, roundPct(sol[j]));
    });
    matrix.set(person, row);
  }
  // residual check: total direct ownership per company should be <= 1
  const residuals = new Map<string, number>();
  for (const c of companies) {
    let sum = 0;
    for (const row of direct.get(c)?.values() ?? []) sum += row;
    residuals.set(c, roundPct(sum));
  }
  return { matrix, residuals };
}

export interface IterativeSolution {
  matrix: Map<string, Map<string, number>>;
  iterations: number;
  maxDelta: number;
  converged: boolean;
  trace: Array<{ iteration: number; maxDelta: number }>;
}

/** Fixed-point flow propagation: works for arbitrary cycles, reports convergence. */
export function solveIterative(
  companies: string[],
  direct: Map<string, Map<string, number>>,
  options: SolveOptions & { maxIterations?: number; tolerance?: number },
): IterativeSolution {
  const { n } = toIndex(companies);
  const eps = options.epsilon ?? 1e-12;
  const tol = options.tolerance ?? 1e-10;
  const maxIter = options.maxIterations ?? 1000;
  // col[person][j] = ownership attributed so far
  const cols = new Map<string, Float64Array>();
  for (const p of options.persons) {
    const v = new Float64Array(n);
    for (const [c, row] of direct) {
      const j = companies.indexOf(c);
      if (j >= 0) v[j] = row.get(p) ?? 0;
    }
    cols.set(p, v);
  }
  const idx = toIndex(companies).idx;
  const trace: Array<{ iteration: number; maxDelta: number }> = [];
  let maxDelta = 0;
  let iterations = 0;
  let converged = false;
  for (let it = 1; it <= maxIter; it++) {
    iterations = it;
    let delta = 0;
    for (const [p, cur] of cols) {
      const next = cur.slice();
      for (const [companyId, row] of direct) {
        const j = idx.get(companyId)!;
        let inflow = 0;
        for (const [holderId, pct] of row) {
          const i = idx.get(holderId);
          if (i === undefined) continue;
          inflow += pct * cur[i];
        }
        next[j] = (row.get(p) ?? 0) + inflow;
      }
      for (let j = 0; j < n; j++) delta = Math.max(delta, Math.abs(next[j] - cur[j]));
      cols.set(p, next);
    }
    maxDelta = delta;
    if (it <= 5 || it % 10 === 0 || delta < tol) trace.push({ iteration: it, maxDelta: delta });
    if (delta < tol) { converged = true; break; }
  }
  const matrix = new Map<string, Map<string, number>>();
  for (const [p, v] of cols) {
    const row = new Map<string, number>();
    companies.forEach((c, j) => { if (v[j] > 1e-9) row.set(c, roundPct(v[j])); });
    matrix.set(p, row);
  }
  void eps; void n;
  return { matrix, iterations, maxDelta, converged, trace };
}

/**
 * Enumerate ownership paths person -> ... -> target with the product of edge
 * percentages. Cycles are truncated at the first repeated node; the truncated
 * remainder is reported separately so the UI can explain the "loop cut".
 */
export function enumeratePaths(
  targetCompanyId: string,
  personId: string,
  direct: Map<string, Map<string, number>>,
  entityNames: Map<string, string>,
  entityKinds: Map<string, string>,
  opts: { maxPaths?: number; maxDepth?: number; minPct?: number } = {},
): { paths: PathContribution[]; truncatedCyclePct: number; visitedCycleNodes: string[][] } {
  const maxPaths = opts.maxPaths ?? 200;
  const maxDepth = opts.maxDepth ?? 12;
  const minPct = opts.minPct ?? 1e-6;
  const paths: PathContribution[] = [];
  let truncatedCyclePct = 0;
  const visitedCycleNodes: string[][] = [];

  // For a target company, find shareholders recursively.
  const shareRow = (companyId: string) => {
    const row = direct.get(companyId);
    return row ? [...row.entries()].filter(([, p]) => p > 0) : [];
  };

  const walk = (companyId: string, factor: number, trail: string[], edgeTrail: PathContribution['edges']) => {
    if (paths.length >= maxPaths) return;
    for (const [holderId, pct] of shareRow(companyId)) {
      const nextFactor = factor * pct;
      if (nextFactor < minPct) continue;
      if (trail.includes(holderId)) {
        const names = trail.concat(holderId);
        void names;
        // cycle: record the truncated tail once
        const cyc = trail.slice(trail.indexOf(holderId));
        const sig = cyc.concat(holderId).join('>');
        if (!visitedCycleNodes.some(v => v.join('>') === sig)) {
          visitedCycleNodes.push(cyc.concat(holderId));
          truncatedCyclePct += nextFactor;
        }
        continue;
      }
      if (trail.length >= maxDepth) continue;
      const names = trail.concat(holderId);
      const nextEdges = edgeTrail.concat([{ companyId, holderId, pct }]);
      if (holderId === personId) {
        paths.push({
          nodes: [personId, ...names.slice().reverse()].map(id => ({
            id, name: entityNames.get(id) ?? id, kind: (entityKinds.get(id) ?? 'company') as 'company' | 'person',
          })),
          pct: roundPct(nextFactor),
          edges: nextEdges,
        });
      } else if (entityKinds.get(holderId) === 'company') {
        walk(holderId, nextFactor, names, nextEdges);
      }
    }
  };

  walk(targetCompanyId, 1, [targetCompanyId], []);
  return { paths, truncatedCyclePct: roundPct(truncatedCyclePct), visitedCycleNodes };
}

export function buildOwnershipResult(
  graph: GraphBuild,
  entityNames: Map<string, string>,
  options: { solver?: 'linear' | 'iterative' } = {},
): OwnershipResult & { direct: Map<string, Map<string, number>>; activeRelations: ManualRelation[] } {
  const direct = applyNominees(graph.direct, graph.activeRelations);
  const legalSolution = solveLinear(graph.companies, graph.direct, { persons: graph.persons });
  const solver = options.solver ?? 'linear';
  let matrix: Map<string, Map<string, number>>;
  let iterativeInfo: { iterations: number; maxDelta: number } | undefined;
  if (solver === 'iterative') {
    const it = solveIterative(graph.companies, direct, { persons: graph.persons });
    matrix = it.matrix;
    iterativeInfo = { iterations: it.iterations, maxDelta: it.maxDelta };
  } else {
    matrix = solveLinear(graph.companies, direct, { persons: graph.persons }).matrix;
  }
  const cycles = findCycles(graph.companies, graph.direct, entityNames);
  return {
    matrix,
    legalMatrix: legalSolution.matrix,
    companies: graph.companies,
    persons: graph.persons,
    cycles,
    diagnostics: {
      unbalancedCompanies: graph.diagnostics.unbalancedCompanies.map(u => ({ companyId: u.companyId, sum: u.sum, normalised: u.normalised })),
      unresolvedHolderRecords: [],
      iterativeConvergence: iterativeInfo,
    },
    direct,
    activeRelations: graph.activeRelations,
  };
}
