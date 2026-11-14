/** CSV parsing with quote handling, BOM strip, delimiter sniffing. */

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  delimiter: string;
}

function sniffDelimiter(firstLine: string): string {
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const firstNewline = text.indexOf('\n');
  const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
  const delimiter = sniffDelimiter(firstLine);

  const cells: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      cells.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); cells.push(row); }

  const nonEmpty = cells.filter(r => r.some(c => c.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [], delimiter };
  const headers = nonEmpty[0].map(h => h.trim());
  const rows = nonEmpty.slice(1).map(r => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
    return obj;
  });
  return { headers, rows, delimiter };
}

/** Normalise a ratio string: '60%', '60.00%', '0.6', '0.6000', '60' (percent-only feed). */
export function parseRatio(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s,%％]/g, '');
  if (!cleaned) return null;
  const direct = Number(cleaned);
  if (!Number.isFinite(direct)) return null;
  const hasPercent = /[%％]/.test(raw);
  let v = hasPercent ? direct / 100 : direct;
  if (!hasPercent && direct > 1.0000001) v = direct / 100;
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 1e8) / 1e8;
}

export function parseAmount(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,\s万万元]/g, '');
  if (!cleaned) return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

/** Normalise dates from yyyy-mm-dd, yyyy/mm/dd, yyyy年m月d日, yyyymmdd. */
export function parseDate(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(t);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
