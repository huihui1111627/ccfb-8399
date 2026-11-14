export interface EntitySummary {
  id: string; kind: 'company' | 'person'; name: string; aliases: string[];
  uscc: string | null; addresses: string[]; idFragments: string[];
  legalReps: string[]; records: number; confidence: number;
  evidence: Array<{ rule: string; detail: string; confidence: number }>;
}

export interface GraphNode { id: string; name: string; kind: 'company' | 'person'; uscc: string | null; aliases: string[]; idFragments: string[]; confidence: number; controllerOf: string[]; }
export interface GraphEdge { companyId: string; holderId: string; pct: number; effectiveDate: string; source: string; recordId: string; }
export interface GraphRelation {
  id: string; type: 'concert' | 'nominee'; scopeCompanyId: string; scopeName: string;
  memberEntityIds: string[]; memberNames: string[]; leaderEntityId: string | null; leaderName: string | null;
  nominalEntityId: string | null; nominalName: string | null; actualEntityId: string | null; actualName: string | null;
  start: string; end: string | null; note: string;
}
export interface ControllerItem {
  companyId: string; companyName: string; kind: 'person' | 'group' | 'none'; leaderEntityId: string | null;
  leaderName: string | null; memberEntityIds: string[]; memberNames: string[]; pct: number; basis: string;
  relationId: string | null; beneficialOwners: Array<{ entityId: string; name: string; pct: number; legalPct: number }>;
  breakdown: Array<{ entityId?: string; name: string; pct: number; legalPct: number; kind?: string }>;
}

export interface GraphPayload {
  asOf: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  relations: GraphRelation[];
  cycles: string[][];
  controllers: ControllerItem[];
  diagnostics: {
    unbalancedCompanies: Array<{ companyId: string; sum: number; normalised: boolean }>;
    unresolvedHolderRecords?: string[];
    supersededRows?: number;
    droppedZero?: number;
    dispersed?: string[];
    iterativeConvergence?: { iterations: number; maxDelta: number };
  };
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(body.error ?? '请求失败');
  return body as T;
}

export const api = {
  meta: () => json<{
    counts: { companies: number; holders: number; changes: number; companyEntities: number; personEntities: number };
    imports: Array<{ at: string; kind: string; rows: number; issues: number; fileName: string }>;
    lastResolvedAt: string | null;
    hasTruth: boolean;
    relations: number;
    mappings: Record<string, { fields: Record<string, string> }>;
  }>('/api/meta'),
  loadDemo: () => json<{ imported: Array<{ kind: string; rows: number; issues: number }>; entities: { companies: number; persons: number } }>('/api/import/demo', { method: 'POST' }),
  reset: () => json<{ ok: boolean }>('/api/import/reset', { method: 'POST' }),
  importCsv: (kind: string, csv: string, fileName: string, mapping?: { fields: Record<string, string> }) =>
    json<{ imported: number; issues: Array<{ recordId: string; severity: string; message: string }>; entities: { companies: number; persons: number } }>(`/api/import/${kind}`, {
      method: 'POST', body: JSON.stringify({ csv, fileName, mapping }),
    }),
  saveMapping: (kind: string, fields: Record<string, string>) =>
    json<{ ok: boolean }>(`/api/mapping/${kind}`, { method: 'PUT', body: JSON.stringify({ fields }) }),
  englishPreset: () => json<{ mappings: Record<string, { fields: Record<string, string> }> }>('/api/mapping/companies/preset', { method: 'POST', body: JSON.stringify({ preset: 'english' }) }),
  entities: (q = '', kind = '') =>
    json<{
      companies: EntitySummary[]; persons: EntitySummary[];
      conflicts: Array<{ a: string; b: string; reason: string }>;
      diagnostics: { personNameGroups: Array<{ nameKey: string; entityIds: string[]; reason: string }>; recordsWithoutUscc: number; recordsMergedByAlias: number; personRecordsWithoutId: number };
      nameGroups: Array<{ name: string; entities: Array<{ id: string; records: number; idFragments: string[]; addresses: string[]; confidence: number }> }>;
      unresolved: Array<{ recordId: string; name: string }>;
    }>(`/api/entities?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kind)}`),
  entityDetail: (id: string) => json<{
    entity: Omit<EntitySummary, 'records'> & { recordIds: string[]; evidence: Array<{ rule: string; detail: string; confidence: number }> };
    holderRows: Array<{ recordId: string; companyNameRaw: string; holderNameRaw: string; idNumber: string; ratioText: string; ratio: number | null; address: string; position: string; effectiveDate: string; source: string }>;
    companyRows: Array<{ recordId: string; name: string; uscc: string; address: string; shortName: string; formerNames: string; source: string; snapshotDate: string }>;
    relations: GraphRelation[];
  }>(`/api/entities/${id}`),
  mergePreview: (id: string) => json<{ candidates: Array<{ id: string; name: string; score: number; reason: string; conflict: boolean }> }>(`/api/entities/${id}/merge-preview`),
  splitEntity: (id: string, recordIds: string[], note = '') =>
    json<{ ok: boolean; entities: { companies: number; persons: number } }>(`/api/entities/${id}/split`, { method: 'POST', body: JSON.stringify({ recordIds, note }) }),
  mergeEntities: (entityIds: string[], note = '') =>
    json<{ ok: boolean; entities: { companies: number; persons: number } }>('/api/entities/merge', { method: 'POST', body: JSON.stringify({ entityIds, note }) }),
  undoManualEdits: () => json<{ ok: boolean; entities: { companies: number; persons: number } }>('/api/entities/undo-manual', { method: 'POST', body: JSON.stringify({}) }),
  manualEdits: () => json<{
    merges: Array<{ id: string; kind: string; entityIds: string[]; names: string[]; note: string; createdAt: string }>;
    splits: Array<{ id: string; entityId: string; entityName: string; recordIds: string[]; note: string; createdAt: string }>;
  }>('/api/entities/manual-edits'),
  graph: (asOf?: string) => json<GraphPayload>(`/api/graph${asOf ? `?asOf=${asOf}` : ''}`),
  companyDetail: (id: string, asOf?: string) => json<{
    company: { id: string; name: string; uscc: string | null; aliases: string[] } | null;
    asOf: string | null; controller: ControllerItem | null;
    holders: Array<{ holderId: string; name: string; kind: string; pct: number; effective: number | null }>;
    effectiveRows: Array<{ companyId: string; name: string; pct: number }>;
    paths: Array<{ nodes: Array<{ id: string; name: string; kind: string }>; pct: number; pctLabel: string; edges: Array<{ companyId: string; holderId: string; pct: number }> }>;
    truncatedCyclePct: number; cycles: string[][];
    unbalanced: Array<{ companyId: string; companyName: string; sum: number }>;
  }>(`/api/company/${id}/detail${asOf ? `?asOf=${asOf}` : ''}`),
  controllers: (asOf?: string) => json<{
    asOf: string | null;
    rules: { controlThreshold: number; beneficialThreshold: number; description: string[] };
    items: Array<{ companyId: string; companyName: string; kind: string; leaderId: string | null; leaderName: string | null; members: Array<{ id: string; name: string }>; pct: number; basis: string; relationId: string | null; owners: Array<{ id: string; name: string; pct: number; legalPct: number }> }>;
    concert: Array<{ companyId: string; relationId: string; memberNames: string[]; combined: number }>;
  }>(`/api/controllers${asOf ? `?asOf=${asOf}` : ''}`),
  history: () => json<{ snapshots: Array<{ date: string; companies: number; personsWithHoldings: number; cycles: string[][]; dispersed: number; unbalanced: number }> }>('/api/history'),
  historyAt: (date: string) => json<{
    date: string; edges: Array<{ companyId: string; companyName: string; holderId: string; holderName: string; pct: number; effectiveDate: string }>;
    controllers: Array<{ companyId: string; companyName: string; kind: string; leaderName: string | null; pct: number; basis: string }>;
    cycles: string[][]; companies: number;
  }>(`/api/history/${date}`),
  relationList: () => json<{ items: GraphRelation[] }>('/api/relations'),
  addRelation: (payload: Record<string, unknown>) => json<{ ok: boolean }>('/api/relations', { method: 'POST', body: JSON.stringify(payload) }),
  deleteRelation: (id: string) => json<{ ok: boolean }>(`/api/relations/${id}`, { method: 'DELETE' }),
  evaluate: () => json<{
    available: boolean; reason?: string;
    entity: null | {
      persons: EntityEvalResult; companies: EntityEvalResult;
    };
    controllers: null | {
      rows: Array<{ snapshot: string; companyKey: string; companyName: string; expectedLeader: string | null; actualLeader: string | null; expectedPct: number; actualPct: number; match: boolean; pctDelta: number; ownerSetMatch: boolean; expectedOwners: string[]; actualOwners: string[] }>;
      accuracy: number; pctMae: number; ownerF1: number;
      bySnapshot: Array<{ snapshot: string; accuracy: number; total: number }>;
      confusion: Array<{ truth: string; predicted: string; count: number }>;
    };
    snapshotsCompared: string[]; generatedAt: string;
    truthNames?: Record<string, string>;
  }>('/api/evaluate'),
};

export interface EntityEvalResult {
  bcubed: { precision: number; recall: number; f1: number; records: number };
  splitTruth: Array<{ truth: string; predicted: string[]; records: number }>;
  mergedTruth: Array<{ predicted: string; truth: string[]; records: number }>;
  entitiesPredicted: number; entitiesTruth: number;
}

export const fmtPct = (v: number, digits = 2) => `${(v * 100).toFixed(digits)}%`;
export const fmtDate = (s: string | null | undefined) => s ? s.slice(0, 10) : '—';

export function toast(message: string, type: 'ok' | 'error' | 'info' = 'info') {
  const el = document.getElementById('toast')!;
  el.textContent = message;
  el.className = `toast show ${type === 'ok' ? 'ok' : type === 'error' ? 'error' : ''}`;
  window.clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => { el.className = 'toast'; }, 2600);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
