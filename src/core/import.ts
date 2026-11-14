import {
  DatasetKind, Dataset, ImportIssue, MappingConfig, RawCompanyRecord, RawHolderRecord, RawChangeRecord,
} from './types.js';
import { ParsedCsv, parseAmount, parseDate, parseRatio } from './csv.js';

function cell(row: Record<string, string>, mapping: MappingConfig, logical: string): string {
  const header = mapping.fields[logical];
  if (!header) return '';
  return (row[header] ?? '').trim();
}

function requireHeader(parsed: ParsedCsv, mapping: MappingConfig, logical: string, issues: ImportIssue[], kind: DatasetKind) {
  const header = mapping.fields[logical];
  if (!header) {
    issues.push({ recordId: '-', severity: 'error', message: `${kind}: 字段映射缺少 ${logical}` });
    return false;
  }
  if (!parsed.headers.includes(header)) {
    issues.push({ recordId: '-', severity: 'error', message: `${kind}: CSV 中找不到列「${header}」（对应 ${logical}），可用列：${parsed.headers.slice(0, 12).join('、')}` });
    return false;
  }
  return true;
}

export interface ImportOneResult<T> {
  rows: T[];
  issues: ImportIssue[];
}

export function mapCompanies(parsed: ParsedCsv, mapping: MappingConfig, fallbackIdPrefix = 'CR'): ImportOneResult<RawCompanyRecord> {
  const issues: ImportIssue[] = [];
  const required = ['recordId', 'name', 'uscc', 'address', 'legalRep', 'establishedDate', 'capital', 'status', 'shortName', 'formerNames', 'source', 'snapshotDate'];
  for (const f of ['recordId', 'name']) {
    if (!requireHeader(parsed, mapping, f, issues, 'companies')) return { rows: [], issues };
  }
  let seq = 0;
  const rows: RawCompanyRecord[] = [];
  const seenIds = new Set<string>();
  for (const row of parsed.rows) {
    const name = cell(row, mapping, 'name');
    if (!name) {
      issues.push({ recordId: cell(row, mapping, 'recordId') || '-', severity: 'warn', message: '公司记录缺少企业名称，已跳过' });
      continue;
    }
    let recordId = cell(row, mapping, 'recordId');
    if (!recordId) recordId = `${fallbackIdPrefix}-AUTO-${String(++seq).padStart(4, '0')}`;
    if (seenIds.has(recordId)) { recordId = `${recordId}-DUP${++seq}`; issues.push({ recordId, severity: 'warn', message: '记录ID重复，已自动加后缀' }); }
    seenIds.add(recordId);
    const capitalRaw = cell(row, mapping, 'capital');
    const established = parseDate(cell(row, mapping, 'establishedDate'));
    if (!established && cell(row, mapping, 'establishedDate')) {
      issues.push({ recordId, severity: 'warn', message: `成立日期无法解析：${cell(row, mapping, 'establishedDate')}` });
    }
    rows.push({
      recordId,
      name,
      uscc: cell(row, mapping, 'uscc').toUpperCase(),
      address: cell(row, mapping, 'address'),
      legalRep: cell(row, mapping, 'legalRep'),
      establishedDate: established ?? '',
      capital: parseAmount(capitalRaw),
      status: cell(row, mapping, 'status'),
      shortName: cell(row, mapping, 'shortName'),
      formerNames: cell(row, mapping, 'formerNames'),
      source: cell(row, mapping, 'source'),
      snapshotDate: parseDate(cell(row, mapping, 'snapshotDate')) ?? '',
    });
  }
  void required;
  return { rows, issues };
}

export function mapHolders(parsed: ParsedCsv, mapping: MappingConfig, fallbackIdPrefix = 'EQ'): ImportOneResult<RawHolderRecord> {
  const issues: ImportIssue[] = [];
  for (const f of ['recordId', 'companyName', 'holderName', 'ratio', 'effectiveDate']) {
    if (!requireHeader(parsed, mapping, f, issues, 'holders')) return { rows: [], issues };
  }
  let seq = 0;
  const rows: RawHolderRecord[] = [];
  for (const row of parsed.rows) {
    const companyName = cell(row, mapping, 'companyName');
    const holderName = cell(row, mapping, 'holderName');
    if (!companyName || !holderName) {
      issues.push({ recordId: cell(row, mapping, 'recordId') || '-', severity: 'warn', message: '股东记录缺少企业名称或股东名称，已跳过' });
      continue;
    }
    let recordId = cell(row, mapping, 'recordId');
    if (!recordId) recordId = `${fallbackIdPrefix}-AUTO-${String(++seq).padStart(4, '0')}`;
    const ratioText = cell(row, mapping, 'ratio');
    const ratio = parseRatio(ratioText);
    if (ratio === null) {
      issues.push({ recordId, severity: 'warn', message: `出资比例无法解析：${ratioText}` });
    } else if (ratio < 0 || ratio > 1.0000001) {
      issues.push({ recordId, severity: 'warn', message: `出资比例超出 0-100%：${ratioText}` });
    }
    const effective = parseDate(cell(row, mapping, 'effectiveDate'));
    if (!effective) issues.push({ recordId, severity: 'warn', message: `持股变更日期无法解析：${cell(row, mapping, 'effectiveDate')}` });
    rows.push({
      recordId,
      companyName,
      holderName,
      holderType: cell(row, mapping, 'holderType'),
      idNumber: cell(row, mapping, 'idNumber'),
      subscribedAmount: parseAmount(cell(row, mapping, 'subscribedAmount')),
      ratioText,
      ratio,
      holderAddress: cell(row, mapping, 'holderAddress'),
      position: cell(row, mapping, 'position'),
      effectiveDate: effective ?? '',
      source: cell(row, mapping, 'source'),
    });
  }
  return { rows, issues };
}

export function mapChanges(parsed: ParsedCsv, mapping: MappingConfig, fallbackIdPrefix = 'CH'): ImportOneResult<RawChangeRecord> {
  const issues: ImportIssue[] = [];
  for (const f of ['recordId', 'companyName', 'changeDate', 'item']) {
    if (!requireHeader(parsed, mapping, f, issues, 'changes')) return { rows: [], issues };
  }
  let seq = 0;
  const rows: RawChangeRecord[] = [];
  for (const row of parsed.rows) {
    const companyName = cell(row, mapping, 'companyName');
    const item = cell(row, mapping, 'item');
    if (!companyName || !item) {
      issues.push({ recordId: cell(row, mapping, 'recordId') || '-', severity: 'warn', message: '变更记录缺少企业名称或变更事项，已跳过' });
      continue;
    }
    let recordId = cell(row, mapping, 'recordId');
    if (!recordId) recordId = `${fallbackIdPrefix}-AUTO-${String(++seq).padStart(4, '0')}`;
    const changeDate = parseDate(cell(row, mapping, 'changeDate'));
    if (!changeDate) issues.push({ recordId, severity: 'warn', message: `变更日期无法解析：${cell(row, mapping, 'changeDate')}` });
    rows.push({
      recordId,
      companyName,
      uscc: cell(row, mapping, 'uscc').toUpperCase(),
      changeDate: changeDate ?? '',
      item,
      before: cell(row, mapping, 'before'),
      after: cell(row, mapping, 'after'),
      source: cell(row, mapping, 'source'),
    });
  }
  return { rows, issues };
}

export function mergeDataset(base: Dataset, incoming: Partial<Record<DatasetKind, unknown[]>>, issues: ImportIssue[]): Dataset {
  return {
    companies: dedupe(base.companies.concat((incoming.companies ?? []) as RawCompanyRecord[])),
    holders: dedupe(base.holders.concat((incoming.holders ?? []) as RawHolderRecord[])),
    changes: dedupe(base.changes.concat((incoming.changes ?? []) as RawChangeRecord[])),
    issues: base.issues.concat(issues),
  };
}

function dedupe<T extends { recordId: string }>(rows: T[]): T[] {
  const map = new Map<string, T>();
  for (const r of rows) {
    const prev = map.get(r.recordId);
    if (!prev) map.set(r.recordId, r);
    else {
      // prefer the row with more non-empty fields
      const score = (o: T) => Object.values(o).filter(v => v !== '' && v !== null && v !== undefined).length;
      if (score(r) > score(prev)) map.set(r.recordId, r);
    }
  }
  return [...map.values()];
}

export function emptyDataset(): Dataset {
  return { companies: [], holders: [], changes: [], issues: [] };
}
