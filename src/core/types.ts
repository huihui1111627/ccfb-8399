export type DatasetKind = 'companies' | 'holders' | 'changes';

export interface RawCompanyRecord {
  recordId: string;
  name: string;
  uscc: string;
  address: string;
  legalRep: string;
  establishedDate: string;
  capital: number | null;
  status: string;
  shortName: string;
  formerNames: string;
  source: string;
  snapshotDate: string;
}

export interface RawHolderRecord {
  recordId: string;
  companyName: string;
  holderName: string;
  holderType: string;
  idNumber: string;
  subscribedAmount: number | null;
  ratioText: string;
  ratio: number | null;
  holderAddress: string;
  position: string;
  effectiveDate: string;
  source: string;
}

export interface RawChangeRecord {
  recordId: string;
  companyName: string;
  uscc: string;
  changeDate: string;
  item: string;
  before: string;
  after: string;
  source: string;
}

export interface MappingConfig {
  /** logical field -> CSV column header */
  fields: Record<string, string>;
}

export type EntityKind = 'company' | 'person';

export interface Entity {
  id: string;
  kind: EntityKind;
  canonicalName: string;
  aliases: string[];
  uscc: string | null;
  addresses: string[];
  legalReps: string[];
  idFragments: string[];
  /** record ids contributing to this entity (registration rows + holder rows) */
  recordIds: string[];
  /** confidence 0..1 for inferred merges; 1 for strong evidence */
  confidence: number;
  evidence: MergeEvidence[];
  createdAt: string;
}

export interface MergeEvidence {
  rule: string;
  detail: string;
  confidence: number;
}

export interface OwnershipEdge {
  companyId: string;
  holderId: string;
  pct: number;
  effectiveDate: string;
  recordId: string;
  source: string;
  holderNameRaw: string;
  companyNameRaw: string;
}

export interface ManualRelation {
  id: string;
  type: 'concert' | 'nominee';
  scopeCompanyId: string;
  leaderEntityId?: string | null;
  memberEntityIds: string[];
  nominalEntityId?: string | null;
  actualEntityId?: string | null;
  start: string;
  end: string | null;
  note: string;
  createdBy: string;
  createdAt: string;
}

export interface ImportIssue {
  recordId: string;
  severity: 'warn' | 'error';
  message: string;
}

export interface Dataset {
  companies: RawCompanyRecord[];
  holders: RawHolderRecord[];
  changes: RawChangeRecord[];
  issues: ImportIssue[];
}

export interface PathContribution {
  nodes: Array<{ id: string; name: string; kind: EntityKind }>;
  pct: number;
  edges: Array<{ companyId: string; holderId: string; pct: number }>;
}

export interface OwnershipResult {
  /** person entity id -> company entity id -> effective pct (0..1) */
  matrix: Map<string, Map<string, number>>;
  /** nominee-adjusted legal (book) effective ownership, for comparison */
  legalMatrix?: Map<string, Map<string, number>>;
  /** effective dated direct holdings actually used (after nominee restatement) */
  direct?: Map<string, Map<string, number>>;
  companies: string[];
  persons: string[];
  cycles: string[][];
  diagnostics: {
    unbalancedCompanies: Array<{ companyId: string; sum: number; normalised: boolean }>;
    unresolvedHolderRecords: string[];
    iterativeConvergence?: { iterations: number; maxDelta: number };
  };
}

export interface ControllerResult {
  companyId: string;
  kind: 'person' | 'group' | 'none';
  leaderEntityId: string | null;
  memberEntityIds: string[];
  pct: number;
  basis: string;
  relationId: string | null;
  beneficialOwners: Array<{ entityId: string; pct: number; legalPct: number; path?: PathContribution }>;
  breakdown: Array<{ entityId: string; pct: number; legalPct: number }>;
}

export interface SnapshotOwnership {
  companyId: string;
  effective: Array<{ entityId: string; pct: number; legalPct: number }>;
}

export interface ManualMerge {
  id: string;
  kind: 'company' | 'person';
  /** entities the operator decided are the same subject */
  entityIds: string[];
  note: string;
  createdAt: string;
}

export interface ManualSplit {
  id: string;
  entityId: string;
  /** records to pull out of the cluster into a new subject */
  recordIds: string[];
  /** display name for the new subject (the note doubles as its name) */
  note: string;
  createdAt: string;
}

export interface AppState {
  dataset: Dataset;
  entities: Entity[];
  relations: ManualRelation[];
  merges: ManualMerge[];
  splits: ManualSplit[];
  mappings: Record<DatasetKind, MappingConfig>;
  imports: Array<{ at: string; kind: DatasetKind; rows: number; issues: number; fileName: string }>;
  lastResolvedAt: string | null;
}

export const ENTITY_PREFIX: Record<EntityKind, string> = { company: 'CO', person: 'PE' };

export const DEFAULT_MAPPINGS: Record<DatasetKind, MappingConfig> = {
  companies: {
    fields: {
      recordId: '记录ID', name: '企业名称', uscc: '统一社会信用代码', address: '注册地址',
      legalRep: '法定代表人', establishedDate: '成立日期', capital: '注册资本(万元)',
      status: '登记状态', shortName: '简称', formerNames: '曾用名', source: '数据来源',
      snapshotDate: '快照日期',
    },
  },
  holders: {
    fields: {
      recordId: '记录ID', companyName: '企业名称', holderName: '股东名称', holderType: '股东类型',
      idNumber: '证件号码', subscribedAmount: '认缴出资额(万元)', ratio: '出资比例',
      holderAddress: '股东地址', position: '任职', effectiveDate: '变更日期', source: '数据来源',
    },
  },
  changes: {
    fields: {
      recordId: '变更ID', companyName: '企业名称', uscc: '统一社会信用代码',
      changeDate: '变更日期', item: '变更事项', before: '变更前', after: '变更后', source: '数据来源',
    },
  },
};

export const ENGLISH_MAPPINGS: Record<DatasetKind, MappingConfig> = {
  companies: {
    fields: {
      recordId: 'record_id', name: 'company_name', uscc: 'uscc', address: 'address',
      legalRep: 'legal_rep', establishedDate: 'established_date', capital: 'registered_capital',
      status: 'status', shortName: 'short_name', formerNames: 'former_names', source: 'source',
      snapshotDate: 'snapshot_date',
    },
  },
  holders: {
    fields: {
      recordId: 'record_id', companyName: 'company_name', holderName: 'holder_name',
      holderType: 'holder_type', idNumber: 'id_number', subscribedAmount: 'subscribed_amount',
      ratio: 'equity_ratio', holderAddress: 'holder_address', position: 'position',
      effectiveDate: 'change_date', source: 'source',
    },
  },
  changes: {
    fields: {
      recordId: 'record_id', companyName: 'company_name', uscc: 'uscc',
      changeDate: 'change_date', item: 'change_item', before: 'before', after: 'after', source: 'source',
    },
  },
};

export const FIELD_LABELS: Record<DatasetKind, Record<string, string>> = {
  companies: {
    recordId: '记录ID', name: '企业名称', uscc: '统一社会信用代码', address: '注册地址',
    legalRep: '法定代表人', establishedDate: '成立日期', capital: '注册资本(万元)',
    status: '登记状态', shortName: '简称', formerNames: '曾用名', source: '数据来源',
    snapshotDate: '快照日期',
  },
  holders: {
    recordId: '记录ID', companyName: '企业名称', holderName: '股东名称', holderType: '股东类型',
    idNumber: '证件号码', subscribedAmount: '认缴出资额(万元)', ratio: '出资比例',
    holderAddress: '股东地址', position: '任职', effectiveDate: '变更日期', source: '数据来源',
  },
  changes: {
    recordId: '变更ID', companyName: '企业名称', uscc: '统一社会信用代码', changeDate: '变更日期',
    item: '变更事项', before: '变更前', after: '变更后', source: '数据来源',
  },
};
