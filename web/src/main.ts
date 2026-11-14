import { api, fmtPct, toast, el, GraphPayload, EntitySummary } from './api.js';
import { OwnershipGraph } from './graph.js';

type Page = 'import' | 'entities' | 'graph' | 'controllers' | 'accuracy';
const state = {
  page: 'import' as Page,
  graph: null as OwnershipGraph | null,
  graphPayload: null as GraphPayload | null,
  focusedNode: null as string | null,
  selectedEntityId: null as string | null,
  mergeSelection: [] as string[],
  entityCache: { companies: [] as EntitySummary[], persons: [] as EntitySummary[] },
  historySelection: null as string | null,
  selectedDate: '',
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];

// ---------------- nav ----------------

function showPage(page: Page) {
  state.page = page;
  $$('.tab').forEach(t => t.classList.toggle('active', (t as HTMLButtonElement).dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'entities') void loadEntities();
  if (page === 'graph') void loadGraph();
  if (page === 'controllers') void loadControllers();
  if (page === 'accuracy') void runEval();
}
$('#tabs').addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest('.tab') as HTMLButtonElement | null;
  if (btn?.dataset.page) showPage(btn.dataset.page as Page);
});

// ---------------- meta / load demo ----------------

async function refreshMeta() {
  const meta = await api.meta();
  const badge = $('#datasetBadge');
  if (!meta.counts.companies && !meta.counts.holders) {
    badge.textContent = '未载入数据';
    badge.className = 'badge muted';
  } else {
    badge.textContent = `${meta.counts.companies} 企业记录 · ${meta.counts.holders} 持股记录 · ${meta.counts.companyEntities}/${meta.counts.personEntities} 主体`;
    badge.className = 'badge ok';
  }
  $('#clockDate').textContent = meta.lastResolvedAt ? `最近消歧 ${new Date(meta.lastResolvedAt).toLocaleString('zh-CN')}` : '';
  renderImportLog(meta.imports);
  const issues = collectIssues();
  $('#issueCount').textContent = String(issues.length);
  renderIssues(issues);
  return meta;
}

let issueBuffer: Array<{ recordId: string; severity: string; message: string }> = [];
function collectIssues() { return issueBuffer; }
function renderIssues(issues: Array<{ recordId: string; severity: string; message: string }>) {
  const box = $('#issueList');
  box.innerHTML = '';
  if (!issues.length) {
    box.className = 'log-list empty-state';
    box.textContent = '未发现字段/数值异常';
    return;
  }
  box.className = 'log-list';
  for (const issue of issues.slice(0, 80)) {
    const row = el('div', `log-row ${issue.severity}`);
    row.innerHTML = `<span class="time">${issue.recordId}</span><span>${issue.message}</span>`;
    box.appendChild(row);
  }
}
function renderImportLog(imports: Array<{ at: string; kind: string; rows: number; issues: number; fileName: string }>) {
  const box = $('#importLog');
  box.innerHTML = '';
  if (!imports.length) { box.className = 'log-list empty-state'; box.textContent = '尚无导入记录'; return; }
  box.className = 'log-list';
  const labels: Record<string, string> = { companies: '企业登记', holders: '股东持股', changes: '变更记录' };
  for (const imp of [...imports].reverse()) {
    const row = el('div', 'log-row');
    row.innerHTML = `<span class="time">${new Date(imp.at).toLocaleTimeString('zh-CN')}</span>
      <span>${labels[imp.kind] ?? imp.kind} · ${imp.fileName} · 新增 ${imp.rows} 行</span>
      <span class="${imp.issues ? 'warn' : 'ok'}" style="margin-left:auto">${imp.issues ? imp.issues + ' 条提示' : '无异常'}</span>`;
    box.appendChild(row);
  }
}

$('#loadDemoBtn').addEventListener('click', async () => {
  try {
    toast('正在载入演示数据并执行消歧…');
    const r = await api.loadDemo();
    toast(`已导入 ${r.imported.map(x => x.rows).reduce((a, b) => a + b, 0)} 行，归并为 ${r.entities.companies} 家企业 / ${r.entities.persons} 名自然人`, 'ok');
    issueBuffer = [];
    await refreshMeta();
    await loadEntities();
    await loadGraph();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
});

$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('确认清空当前会话中的所有导入数据？')) return;
  await api.reset();
  issueBuffer = [];
  state.graphPayload = null;
  state.entityCache = { companies: [], persons: [] };
  await refreshMeta();
  $('#entityList').className = 'entity-list empty-state';
  $('#entityList').textContent = '载入数据后显示归并结果';
  $('#entityDetail').className = 'empty-state';
  $('#entityDetail').textContent = '选择左侧主体查看归并证据、来源记录与人工拆分。';
  $('#controllerList').className = 'controller-list empty-state';
  $('#controllerList').textContent = '载入数据后自动识别';
  toast('已清空', 'ok');
});

$('#stateBtn').addEventListener('click', async () => {
  const meta = await api.meta();
  alert(JSON.stringify(meta, null, 2));
});

// ---------------- import UI ----------------

const FIELD_LABELS: Record<string, Record<string, string>> = {
  companies: {
    recordId: '记录ID', name: '企业名称', uscc: '统一社会信用代码', address: '注册地址',
    legalRep: '法定代表人', establishedDate: '成立日期', capital: '注册资本', status: '登记状态',
    shortName: '简称', formerNames: '曾用名', source: '数据来源', snapshotDate: '快照日期',
  },
  holders: {
    recordId: '记录ID', companyName: '企业名称', holderName: '股东名称', holderType: '股东类型',
    idNumber: '证件号码', subscribedAmount: '认缴出资额', ratio: '出资比例', holderAddress: '股东地址',
    position: '任职', effectiveDate: '变更日期', source: '数据来源',
  },
  changes: {
    recordId: '变更ID', companyName: '企业名称', uscc: '统一社会信用代码', changeDate: '变更日期',
    item: '变更事项', before: '变更前', after: '变更后', source: '数据来源',
  },
};

async function initMappings() {
  const meta = await api.meta();
  for (const kind of ['companies', 'holders', 'changes']) {
    const editor = document.querySelector(`.mapping-editor[data-kind="${kind}"]`) as HTMLElement;
    editor.innerHTML = '';
    const fields = meta.mappings[kind].fields;
    for (const [logical, header] of Object.entries(fields)) {
      const row = el('div', 'mapping-row');
      row.innerHTML = `<label>${FIELD_LABELS[kind][logical] ?? logical}</label>`;
      const input = document.createElement('input');
      input.value = header;
      input.dataset.logical = logical;
      input.addEventListener('change', () => void saveMapping(kind));
      row.appendChild(input);
      editor.appendChild(row);
    }
  }
}
async function saveMapping(kind: string) {
  const editor = document.querySelector(`.mapping-editor[data-kind="${kind}"]`) as HTMLElement;
  const fields: Record<string, string> = {};
  editor.querySelectorAll('input').forEach(inp => {
    fields[(inp as HTMLInputElement).dataset.logical!] = (inp as HTMLInputElement).value.trim();
  });
  await api.saveMapping(kind, fields);
  toast(`${kind} 字段映射已保存`, 'ok');
}

for (const card of $$('.import-card')) {
  const kind = (card as HTMLElement).dataset.kind!;
  const fileInput = card.querySelector('.file-input') as HTMLInputElement;
  const drop = card.querySelector('.drop-zone') as HTMLElement;
  const result = card.querySelector('.import-result') as HTMLElement;
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void upload(kind, f, result);
  });
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    drop.classList.remove('drag');
    const f = ev.dataTransfer?.files?.[0];
    if (f) void upload(kind, f, result);
  });
}

async function upload(kind: string, file: File, resultBox: HTMLElement) {
  try {
    const text = await file.text();
    const editor = document.querySelector(`.mapping-editor[data-kind="${kind}"]`) as HTMLElement;
    const fields: Record<string, string> = {};
    editor.querySelectorAll('input').forEach(inp => {
      fields[(inp as HTMLInputElement).dataset.logical!] = (inp as HTMLInputElement).value.trim();
    });
    const r = await api.importCsv(kind, text, file.name, { fields });
    issueBuffer.push(...r.issues);
    resultBox.innerHTML = `<div class="ok">✓ ${file.name}：导入 ${r.imported} 行，主体 ${r.entities.companies} 企业 / ${r.entities.persons} 自然人</div>`;
    if (r.issues.length) {
      resultBox.innerHTML += `<div class="warn">${r.issues.length} 条提示，详见下方数据质量列表</div>`;
    }
    await refreshMeta();
  } catch (err) {
    resultBox.innerHTML = `<div class="warn">✗ ${(err as Error).message}</div>`;
    toast((err as Error).message, 'error');
  }
}

// ---------------- entities ----------------

async function loadEntities() {
  const q = ($('#entitySearch') as HTMLInputElement).value;
  const kind = ($('#entityKindFilter') as HTMLSelectElement).value;
  const data = await api.entities(q, kind);
  state.entityCache = { companies: data.companies, persons: data.persons };
  $('#entityStats').textContent = `${data.companies.length} 企业 / ${data.persons.length} 自然人`;
  const list = $('#entityList');
  list.innerHTML = '';
  if (!data.companies.length && !data.persons.length) {
    list.className = 'entity-list empty-state';
    list.textContent = '没有匹配的主体';
    return;
  }
  list.className = 'entity-list';
  const groups: Array<[string, EntitySummary[]]> = [
    ['自然人（含同名拆分）', data.persons],
    ['企业主体', data.companies],
  ];
  for (const [title, members] of groups) {
    if (!members.length) continue;
    const head = el('div', 'entity-group-head');
    head.textContent = `${title} · ${members.length}`;
    list.appendChild(head);
    for (const e of members) list.appendChild(renderEntityRow(e));
  }
  if (state.selectedEntityId) {
    const current = [...list.querySelectorAll('.entity-row')].find(r => (r as HTMLElement).dataset.entityId === state.selectedEntityId) as HTMLElement | undefined;
    current?.classList.add('selected');
  }

  // conflicts / homonyms
  renderConflicts(data);
  if (state.page === 'entities') void loadManualEdits();
  syncMergeSelection();
}

function renderEntityRow(e: EntitySummary): HTMLElement {
  {
    const row = el('div', `entity-row ${e.kind}`);
    row.dataset.entityId = e.id;
    const icon = e.kind === 'person' ? '人' : '企';
    const metaBits = [
      e.kind === 'person' ? (e.idFragments[0] ?? '无证件号') : (e.uscc ?? '无统一代码'),
      e.aliases.length > 1 ? `${e.aliases.length} 种写法` : '',
      e.addresses[0] ? e.addresses[0].slice(0, 18) : '',
    ].filter(Boolean).join(' · ');
    row.innerHTML = `<div class="icon">${icon}</div>
      <div><div class="name">${escapeHtml(e.name)}</div><div class="meta">${escapeHtml(metaBits)}</div></div>
      <div class="count">${e.records} 记录</div>`;
    row.addEventListener('click', (ev) => {
      const multi = ev.metaKey || ev.ctrlKey || (ev as MouseEvent).shiftKey;
      if (multi) {
        if (state.mergeSelection.includes(e.id)) {
          state.mergeSelection = state.mergeSelection.filter(x => x !== e.id);
        } else {
          if (state.mergeSelection.length && state.mergeSelection[0] !== e.id) {
            const first = state.entityCache.persons.concat(state.entityCache.companies).find(x => x.id === state.mergeSelection[0]);
            if (first && first.kind !== e.kind) { toast('企业与自然人不能混合合并', 'error'); return; }
          }
          state.mergeSelection.push(e.id);
        }
        syncMergeSelection();
        void selectEntity(e.id, row);
      } else {
        state.mergeSelection = [e.id];
        syncMergeSelection();
        void selectEntity(e.id, row);
      }
    });
    return row;
  }
}

function renderConflicts(data: Awaited<ReturnType<typeof api.entities>>) {
  const conflictBox = $('#conflictList');
  conflictBox.innerHTML = '';
  const groups = data.nameGroups ?? [];
  const extraConflicts = data.conflicts.filter(c => !groups.some(g => g.name === c.a)).length;
  $('#conflictBadge').textContent = String(groups.length + extraConflicts);
  if (!groups.length && !data.conflicts.length) {
    conflictBox.className = 'log-list empty-state';
    conflictBox.textContent = '未发现同名冲突';
    return;
  }
  conflictBox.className = 'log-list';
  for (const g of groups) {
    const row = el('div', 'log-row warn');
    row.innerHTML = `<strong>同名「${escapeHtml(g.name)}」</strong><span>按证件片段/任职/地址拆分为 ${g.entities.length} 个自然人：` +
      g.entities.map(e => `${e.records} 条记录 · ${e.idFragments[0] ?? '无证件号'}`).join('； ') + '</span>';
    conflictBox.appendChild(row);
  }
  const groupNames = new Set(groups.map(g => g.name));
  for (const c of data.conflicts) {
    if (groupNames.has(c.a)) continue;
    const row = el('div', 'log-row');
    row.textContent = c.reason;
    conflictBox.appendChild(row);
  }
}

async function selectEntity(id: string, row: HTMLElement) {
  state.selectedEntityId = id;
  $$('.entity-row').forEach(r => r.classList.remove('selected'));
  const target = [...document.querySelectorAll('.entity-row')].find(r => (r as HTMLElement).dataset.entityId === id) as HTMLElement | undefined;
  (target ?? row).classList.add('selected');
  const data = await api.entityDetail(id);
  const e = data.entity;
  $('#entityDetailBadge').textContent = `${e.kind === 'person' ? '自然人' : '企业'} · ${e.recordIds.length} 条记录`;
  $('#entityDetailBadge').className = `tag ${e.kind === 'person' ? '' : 'muted'}`;
  const box = $('#entityDetail');
  box.className = '';
  box.innerHTML = `
    <h3 style="font-size:16px;margin-bottom:4px">${escapeHtml(e.name)}</h3>
    <div style="font-size:12px;color:var(--ink-3)">${e.uscc ? '统一社会信用代码 ' + e.uscc : (e.idFragments.join(' / ') || '无证件号')} · 归并置信度 ${(e.confidence * 100).toFixed(0)}%</div>
    <div style="margin-top:10px;font-size:12.5px"><strong>别名/写法：</strong>${e.aliases.map(escapeHtml).join('、')}</div>
    ${e.addresses.length ? `<div style="margin-top:4px;font-size:12.5px"><strong>关联地址：</strong>${e.addresses.map(escapeHtml).join('；')}</div>` : ''}
    <div class="card-subhead"><h3>归并证据</h3></div>
    <div class="evidence">
      ${e.evidence.map(v => `<div class="evidence-item"><div class="bar" style="opacity:${v.confidence}"></div>
        <div><div style="font-size:12.5px">${escapeHtml(v.detail)}</div>
        <div style="font-size:11.5px;color:var(--ink-3)">规则 ${v.rule} · 置信度 ${(v.confidence * 100).toFixed(0)}%</div></div></div>`).join('')}
    </div>
    ${data.holderRows.length ? `<div class="card-subhead"><h3>来源持股记录（${data.holderRows.length}）</h3></div>
      <div style="max-height:230px;overflow:auto"><table class="record-table">
      <thead><tr><th>记录</th><th>企业</th><th>股东写法</th><th>证件</th><th>比例</th><th>日期</th><th>操作</th></tr></thead>
      <tbody>${data.holderRows.map(h => `<tr>
        <td>${h.recordId}</td><td>${escapeHtml(h.companyNameRaw)}</td><td>${escapeHtml(h.holderNameRaw)}</td>
        <td>${escapeHtml(h.idNumber || '—')}</td><td>${escapeHtml(h.ratioText)}</td><td>${h.effectiveDate}</td>
        <td><button class="btn ghost" style="padding:2px 7px;font-size:11.5px" data-split="${h.recordId}">拆出</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}
    ${data.companyRows.length ? `<div class="card-subhead"><h3>企业登记记录（${data.companyRows.length}）</h3></div>
      <div style="max-height:200px;overflow:auto"><table class="record-table">
      <thead><tr><th>记录</th><th>名称</th><th>统一代码</th><th>地址</th><th>曾用名</th><th>来源</th></tr></thead>
      <tbody>${data.companyRows.map(c => `<tr><td>${c.recordId}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.uscc || '—')}</td>
        <td>${escapeHtml(c.address || '—')}</td><td>${escapeHtml(c.formerNames || '—')}</td><td>${c.source}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
  `;
  box.querySelectorAll('[data-split]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const recordId = (btn as HTMLElement).dataset.split!;
      if (!confirm(`将记录 ${recordId} 拆分为独立主体？`)) return;
      // give the split subject a distinct operator-facing name tied to the record
      const sourceRecord = data.holderRows.find(h => h.recordId === recordId);
      const tail = (sourceRecord?.idNumber ?? '').replace(/[^0-9A-Za-z]/g, '').slice(-4);
      const suffix = tail ? ` · 尾号${tail}` : '';
      const name = `${e.name}（拆分${suffix} / ${recordId}）`;
      await api.splitEntity(id, [recordId], name);
      toast(`已拆出 ${recordId}，已重新消歧`, 'ok');
      state.mergeSelection = [];
      await loadEntities();
      await refreshMeta();
      const still = state.entityCache.persons.find(e => e.id === id) ?? state.entityCache.companies.find(e => e.id === id);
      if (still) await selectEntity(id, row);
    });
  });
}

$('#entitySearch').addEventListener('input', debounce(() => void loadEntities(), 250));
$('#entityKindFilter').addEventListener('change', () => void loadEntities());
$('#entityRefresh').addEventListener('click', async () => {
  await refreshMeta();
  await loadEntities();
  toast('已重新消歧', 'ok');
});

// ---------------- graph ----------------

async function loadGraph(force = false) {
  if (!state.graph) {
    const svg = $('#graphSvg') as unknown as SVGSVGElement;
    state.graph = new OwnershipGraph(svg, $('#graphTip'), {
      mode: ('all') as 'all' | 'company',
      focused: null,
      onSelect: (id) => void handleNodeSelect(id),
      onExpand: (id) => void handleExpand(id),
    });
  }
  if (state.graphPayload && !force) { state.graph.render(); return; }
  const dateInput = $('#graphDate') as HTMLInputElement;
  const asOf = state.selectedDate || dateInput.value || undefined;
  try {
    const payload = await api.graph(asOf || undefined);
    state.graphPayload = payload;
    if (asOf) dateInput.value = asOf;
    state.graph.setData(payload);
    const sumCtrl = payload.controllers.filter(c => c.kind !== 'none').length;
    $('#graphStats').textContent = `${payload.nodes.length} 主体 · ${payload.edges.length} 持股边 · ${sumCtrl} 家已识别实控人 · ${payload.cycles.length} 组交叉持股`;
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function handleNodeSelect(id: string | null) {
  state.focusedNode = id;
  state.graph?.highlight(id);
  const box = $('#nodeDetail');
  if (!id || !state.graphPayload) {
    $('#selectedNodeBadge').textContent = '未选择';
    box.className = 'empty-state';
    box.textContent = '点击图中节点查看持股链路、穿透比例与环路说明。';
    return;
  }
  const node = state.graphPayload.nodes.find(n => n.id === id)!;
  $('#selectedNodeBadge').textContent = node.kind === 'person' ? '自然人' : '企业';
  box.className = '';
  const related = state.graphPayload.edges.filter(e => e.companyId === id || e.holderId === id);
  const ids = new Set([id]);
  for (const e of related) { ids.add(e.companyId); ids.add(e.holderId); }
  const names = new Map(state.graphPayload.nodes.map(n => [n.id, n.name]));
  box.innerHTML = `
    <h3 style="font-size:16px">${escapeHtml(node.name)}</h3>
    <div style="font-size:12px;color:var(--ink-3)">${node.uscc ?? (node.kind === 'person' ? '自然人' : '无统一代码')}</div>
    ${node.aliases.length > 1 ? `<div style="font-size:12px;margin-top:6px;color:var(--ink-2)">别名：${node.aliases.map(escapeHtml).join('、')}</div>` : ''}
    <div class="card-subhead"><h3>直接关联（${related.length}）</h3></div>
    <div style="display:flex;flex-direction:column;gap:5px">
      ${related.map(e => {
        const from = names.get(e.holderId) ?? e.holderId;
        const to = names.get(e.companyId) ?? e.companyId;
        const arrow = e.holderId === id ? '持出 →' : '← 持有';
        return `<div style="font-size:12.5px;display:flex;justify-content:space-between;gap:8px;padding:5px 7px;background:#f7f9fb;border-radius:6px">
          <span>${escapeHtml(e.holderId === id ? to : from)}</span>
          <span style="font-variant-numeric:tabular-nums">${arrow} ${fmtPct(e.pct)}</span></div>`;
      }).join('') || '<div class="empty-state" style="padding:8px 0">无直接持股关系</div>'}
    </div>
    ${node.kind === 'company' ? `<div class="card-subhead"><h3>穿透与实控人</h3></div>${await companySummaryHtml(id)}` : ''}
    <div style="margin-top:14px"><button class="btn ghost" id="expandBtn">聚焦上下游</button></div>
  `;
  box.querySelector('#expandBtn')?.addEventListener('click', () => void handleExpand(id));
}

async function companySummaryHtml(id: string) {
  try {
    const d = await api.companyDetail(id, state.selectedDate || undefined);
    const ctrl = d.controller;
    if (!ctrl) return '<div class="empty-state" style="padding:8px 0">暂无</div>';
    return `
      <div style="font-size:12.5px;line-height:1.7">
        <div><strong>实际控制人：</strong>${ctrl.leaderName ? escapeHtml(ctrl.leaderName) : '无实际控制人（股权分散）'}
          <span class="tag ${ctrl.kind === 'none' ? 'warn' : 'good'}">${fmtPct(ctrl.pct)}</span></div>
        <div style="color:var(--ink-2);font-size:12px;margin-top:3px">${escapeHtml(ctrl.basis)}</div>
        ${ctrl.memberNames.length > 1 ? `<div style="margin-top:4px">一致行动成员：${ctrl.memberNames.map(escapeHtml).join('、')}</div>` : ''}
        <div style="margin-top:8px"><strong>穿透持股（前 ${Math.min(ctrl.breakdown.length, 6)}）</strong></div>
        ${ctrl.breakdown.slice(0, 6).map(b => `<div style="display:flex;justify-content:space-between;font-variant-numeric:tabular-nums">
          <span>${escapeHtml(b.name)}${b.kind === 'person' ? '' : '（企业）'}</span><span>${fmtPct(b.pct)}</span></div>`).join('')}
        ${d.paths.length ? `<div class="card-subhead"><h3>最长穿透路径</h3></div>
          ${d.paths.slice(0, 4).map(p => `<div style="font-size:11.8px;color:var(--ink-2);margin-bottom:4px">
            ${p.nodes.map(n => escapeHtml(n.name)).reverse().join(' → ')} <strong>${fmtPct(p.pct)}</strong></div>`).join('')}` : ''}
        ${d.truncatedCyclePct > 0 ? `<div style="font-size:11.8px;color:var(--warn);margin-top:4px">环路截断残值 ${fmtPct(d.truncatedCyclePct)}，已计入稳定解</div>` : ''}
      </div>`;
  } catch {
    return '<div class="empty-state">加载失败</div>';
  }
}

async function handleExpand(id: string) {
  state.graph?.focusOn(id);
  state.graph?.highlight(id);
  await handleNodeSelect(id);
}

$('#graphFit').addEventListener('click', () => { state.graph?.fit(); state.graph?.highlight(null); state.focusedNode = null; void handleNodeSelect(null); });
$('#zoomIn').addEventListener('click', () => state.graph?.zoom(1.25));
$('#zoomOut').addEventListener('click', () => state.graph?.zoom(0.8));
$('#zoomFit').addEventListener('click', () => state.graph?.fit());
($('#graphMode') as HTMLSelectElement).addEventListener('change', (ev) => {
  state.graph?.setOptions({ mode: (ev.target as HTMLSelectElement).value as 'all' | 'company' });
});
$('#graphDate').addEventListener('change', async () => {
  state.selectedDate = ($('#graphDate') as HTMLInputElement).value;
  await loadGraph(true);
});
$('#graphDemoCycle').addEventListener('click', () => {
  const cycle = state.graphPayload?.cycles[0];
  if (!cycle?.length || !state.graphPayload) { toast('当前时点没有交叉持股', 'info'); return; }
  const id = state.graphPayload.nodes.find(n => n.name === cycle[0])?.id;
  if (id) { void handleExpand(id); toast(`交叉持股：${cycle.join(' ⇄ ')}`, 'info'); }
});

// ---------------- controllers / relations / history ----------------

function renderRelationForm() {
  const form = $('#relationForm');
  const companies = state.entityCache.companies.length ? state.entityCache.companies
    : state.graphPayload?.nodes.filter(n => n.kind === 'company').map(n => ({ id: n.id, name: n.name } as EntitySummary)) ?? [];
  const persons = state.entityCache.persons.length ? state.entityCache.persons
    : state.graphPayload?.nodes.filter(n => n.kind === 'person').map(n => ({ id: n.id, name: n.name } as EntitySummary)) ?? [];
  form.innerHTML = `
    <label class="field"><span>关系类型</span>
      <select id="relType"><option value="concert">一致行动</option><option value="nominee">代持</option></select></label>
    <label class="field"><span>适用企业</span><select id="relScope">${companies.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></label>
    <div class="field full"><span>成员（一致行动：≥2 人；代持：实际出资人）</span>
      <div class="member-picker" id="relMembers">${persons.map(p => `<label><input type="checkbox" value="${p.id}">${escapeHtml(p.name)} <span class="frag">${escapeHtml(p.idFragments?.[0] ?? '')}</span></label>`).join('')}</div>
    </div>
    <label class="field" id="leaderField"><span>牵头人</span>
      <select id="relLeader">${persons.map(p => `<option value="${p.id}">${escapeHtml(p.name)} ${escapeHtml(p.idFragments?.[0] ?? '')}</option>`).join('')}</select></label>
    <label class="field" id="nominalField" style="display:none"><span>名义持有人</span>
      <select id="relNominal">${persons.map(p => `<option value="${p.id}">${escapeHtml(p.name)} ${escapeHtml(p.idFragments?.[0] ?? '')}</option>`).join('')}</select></label>
    <label class="field"><span>生效日期</span><input id="relStart" type="date" class="input" value="${new Date().toISOString().slice(0, 10)}"></label>
    <label class="field"><span>失效日期（可空）</span><input id="relEnd" type="date" class="input"></label>
    <label class="field full"><span>说明</span><textarea id="relNote" placeholder="例如：2022 年签署的一致行动协议，或某主体代持关系及依据"></textarea></label>
    <div class="relation-actions"><button class="btn primary" id="relSubmit">补录关系</button></div>
  `;
  ($('#relType') as HTMLSelectElement).addEventListener('change', (ev) => {
    const nominee = (ev.target as HTMLSelectElement).value === 'nominee';
    ($('#leaderField') as HTMLElement).style.display = nominee ? 'none' : '';
    ($('#nominalField') as HTMLElement).style.display = nominee ? '' : 'none';
  });
  $('#relSubmit').addEventListener('click', async () => {
    const type = ($('#relType') as HTMLSelectElement).value;
    const scope = ($('#relScope') as HTMLSelectElement).value;
    const members = [...document.querySelectorAll('#relMembers input:checked')].map(i => (i as HTMLInputElement).value);
    if (!scope) { toast('请选择适用企业', 'error'); return; }
    if (type === 'concert' && members.length < 2) { toast('一致行动至少选择两名成员', 'error'); return; }
    if (type === 'nominee' && members.length !== 1) { toast('代持关系请选择一名实际出资人', 'error'); return; }
    try {
      await api.addRelation({
        type, scopeCompanyId: scope, memberEntityIds: members,
        leaderEntityId: type === 'concert' ? ($('#relLeader') as HTMLSelectElement).value : null,
        nominalEntityId: type === 'nominee' ? ($('#relNominal') as HTMLSelectElement).value : null,
        actualEntityId: type === 'nominee' ? members[0] : null,
        start: ($('#relStart') as HTMLInputElement).value || undefined,
        end: ($('#relEnd') as HTMLInputElement).value || null,
        note: ($('#relNote') as HTMLTextAreaElement).value,
      });
      toast('关系已补录，实控人将按新关系重算', 'ok');
      await loadControllers(true);
      await loadGraph(true);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  });
}

async function loadControllers(force = false) {
  void force;
  if (!state.entityCache.companies.length) {
    const data = await api.entities('', '');
    state.entityCache = { companies: data.companies, persons: data.persons };
  }
  renderRelationForm();
  const date = ($('#ctrlDate') as HTMLInputElement).value || state.selectedDate || undefined;
  const ctrlThreshold = ($('#ctrlThreshold') as HTMLInputElement).value;
  const boThreshold = ($('#boThreshold') as HTMLInputElement).value;
  const data = await api.controllers(date);
  const list = $('#controllerList');
  list.innerHTML = '';
  list.className = 'controller-list';
  $('#controllerCount').textContent = `${data.items.length} 家 · 阈值 ${ctrlThreshold}% / ${boThreshold}%`;
  for (const item of data.items) {
    const row = el('div', 'controller-row');
    const kindLabel = item.kind === 'group' ? '一致行动组' : item.kind === 'person' ? '自然人' : '无实际控制人';
    const tagClass = item.kind === 'none' ? 'warn' : item.kind === 'group' ? '' : 'good';
    row.innerHTML = `
      <div class="top"><span class="name">${escapeHtml(item.companyName)}</span>
        <span class="tag ${tagClass}">${kindLabel} · ${fmtPct(item.pct)}</span></div>
      <div class="leader">${item.leaderName ? '实际控制人：<strong>' + escapeHtml(item.leaderName) + '</strong>' : escapeHtml(item.basis)}</div>
      <div style="font-size:11.8px;color:var(--ink-3);margin-top:4px">${escapeHtml(item.basis)}</div>
      <div class="owner-chips">${item.owners.map(o => `<span class="owner-chip over">${escapeHtml(o.name)} ${fmtPct(o.pct)}</span>`).join('') || '<span class="owner-chip">无自然人超过 25%</span>'}</div>`;
    row.addEventListener('click', () => {
      state.selectedDate = date ?? '';
      showPage('graph');
      setTimeout(() => { void handleExpand(item.companyId); }, 350);
    });
    list.appendChild(row);
  }

  // history strip
  const history = await api.history();
  const strip = $('#historyStrip');
  strip.innerHTML = '';
  for (const snap of history.snapshots) {
    const chip = el('button', `history-chip${state.historySelection === snap.date ? ' selected' : ''}`);
    chip.innerHTML = `<span class="date">${snap.date}</span><span class="meta">${snap.companies} 企业 · ${snap.cycles.length} 处交叉</span>`;
    chip.addEventListener('click', () => void showHistory(snap.date));
    strip.appendChild(chip);
  }

  // relation list
  const rels = await api.relationList();
  const relBox = $('#relationList');
  relBox.innerHTML = '';
  if (!rels.items.length) { relBox.className = 'relation-list empty-state'; relBox.textContent = '暂无人工录入的关系'; }
  else {
    relBox.className = 'relation-list';
    for (const r of rels.items) {
      const div = el('div', `relation-item ${r.type}`);
      div.innerHTML = `<div><strong>${r.type === 'concert' ? '一致行动' : '代持'}</strong> · ${escapeHtml(r.scopeName)}
        <div style="font-size:11.8px;color:var(--ink-3)">${r.type === 'concert'
          ? '成员：' + r.memberNames.map(escapeHtml).join('、') + '（牵头 ' + escapeHtml(r.leaderName ?? '') + '）'
          : escapeHtml(r.nominalName ?? '') + ' 代 ' + escapeHtml(r.actualName ?? '') + ' 持有'}</div>
        <div style="font-size:11.5px;color:var(--ink-3)">${r.start} 起${r.end ? ' · 至 ' + r.end : ''}${r.note ? ' · ' + escapeHtml(r.note) : ''}</div></div>
        <button class="remove" title="删除">×</button>`;
      div.querySelector('.remove')!.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await api.deleteRelation(r.id);
        toast('已删除，实控人重新计算', 'ok');
        await loadControllers(true);
        await loadGraph(true);
      });
      relBox.appendChild(div);
    }
  }
}

async function showHistory(date: string) {
  state.historySelection = date;
  $$('.history-chip').forEach(c => c.classList.toggle('selected', c.textContent?.includes(date)));
  const data = await api.historyAt(date);
  const box = $('#historyView');
  box.className = '';
  box.innerHTML = `
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:12px">
      <span class="tag">${data.date}</span>
      <span style="font-size:12.5px;color:var(--ink-2)">${data.companies} 家企业 · ${data.edges.length} 条当期持股边 · ${data.cycles.length} 处交叉持股</span>
      <button class="btn ghost" id="viewGraphAt" style="padding:4px 10px;font-size:12px">在股权图中查看</button>
    </div>
    <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:16px">
      <div class="table-card" style="box-shadow:none"><h3 style="font-size:13.5px;margin-bottom:8px">当期股权结构（持股边）</h3>
        <table class="data-table"><thead><tr><th>企业</th><th>股东</th><th class="num">比例</th><th>生效日</th></tr></thead>
        <tbody>${data.edges.map(e => `<tr><td>${escapeHtml(e.companyName)}</td><td>${escapeHtml(e.holderName)}</td><td class="num">${fmtPct(e.pct)}</td><td>${e.effectiveDate}</td></tr>`).join('')}</tbody></table></div>
      <div class="table-card" style="box-shadow:none"><h3 style="font-size:13.5px;margin-bottom:8px">当期实际控制人</h3>
        <table class="data-table"><thead><tr><th>企业</th><th>实际控制人</th><th class="num">比例</th><th>状态</th></tr></thead>
        <tbody>${data.controllers.map(c => `<tr><td>${escapeHtml(c.companyName)}</td><td>${escapeHtml(c.leaderName ?? '—')}</td>
          <td class="num">${fmtPct(c.pct)}</td><td>${c.kind === 'none' ? '<span class="tag warn">分散</span>' : c.kind === 'group' ? '<span class="tag">一致行动</span>' : '<span class="tag good">自然人</span>'}</td></tr>`).join('')}</tbody></table></div>
    </div>
    ${data.cycles.length ? `<div style="margin-top:12px;font-size:12.5px;color:var(--warn)">交叉持股：${data.cycles.map(c => c.join(' ⇄ ')).map(escapeHtml).join('；')}</div>` : ''}
  `;
  $('#viewGraphAt').addEventListener('click', () => {
    ($('#graphDate') as HTMLInputElement).value = date;
    state.selectedDate = date;
    state.graphPayload = null;
    showPage('graph');
  });
  $('#historyDatePrimer').textContent = date;
}

$('#ctrlDate').addEventListener('change', () => void loadControllers(true));
$('#exportBoBtn').addEventListener('click', () => {
  const date = ($('#ctrlDate') as HTMLInputElement).value || state.selectedDate;
  const threshold = ($('#boThreshold') as HTMLInputElement).value;
  window.open(`/api/export/beneficial-owners?threshold=${threshold}${date ? `&asOf=${date}` : ''}`, '_blank');
});
$('#exportMatrixBtn').addEventListener('click', () => window.open('/api/export/ownership-matrix', '_blank'));

// ---------------- accuracy ----------------

async function runEval() {
  const root = $('#accuracyRoot');
  try {
    const r = await api.evaluate();
    if (!r.available) {
      root.className = 'accuracy-root empty-state';
      root.textContent = r.reason ?? '基准数据不可用';
      return;
    }
    root.className = 'accuracy-root';
    const p = r.entity!.persons.bcubed;
    const c = r.entity!.companies.bcubed;
    const ctrl = r.controllers!;
    root.innerHTML = `
      <div class="metric-grid">
        <div class="metric"><div class="label">自然人消歧 B³ F1</div><div class="value good">${(p.f1 * 100).toFixed(1)}%</div>
          <div class="hint">${p.records} 条股东记录 · 精确率 ${(p.precision * 100).toFixed(1)}% · 召回率 ${(p.recall * 100).toFixed(1)}%</div></div>
        <div class="metric"><div class="label">企业归并 B³ F1</div><div class="value good">${(c.f1 * 100).toFixed(1)}%</div>
          <div class="hint">${c.records} 条企业记录 · ${r.entity!.companies.entitiesPredicted}/${r.entity!.companies.entitiesTruth} 主体</div></div>
        <div class="metric"><div class="label">实际控制人准确率</div><div class="value good">${(ctrl.accuracy * 100).toFixed(1)}%</div>
          <div class="hint">${ctrl.rows.length} 个企业×时点样本 · 比例平均误差 ${(ctrl.pctMae * 100).toFixed(2)}pp</div></div>
        <div class="metric"><div class="label">受益所有人清单 F1</div><div class="value good">${(ctrl.ownerF1 * 100).toFixed(1)}%</div>
          <div class="hint">与独立基准的主体集合比对</div></div>
      </div>
      <div class="table-card">
        <h3 style="font-size:14px;margin-bottom:10px">按快照时点</h3>
        <table class="data-table"><thead><tr><th>时点</th><th class="num">样本</th><th class="num">准确率</th></tr></thead>
        <tbody>${ctrl.bySnapshot.map(s => `<tr><td>${s.snapshot}</td><td class="num">${s.total}</td><td class="num">${(s.accuracy * 100).toFixed(1)}%</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="table-card">
        <h3 style="font-size:14px;margin-bottom:10px">实控人比对明细</h3>
        <table class="data-table"><thead><tr>
          <th>时点</th><th>企业</th><th>基准实控人</th><th>系统识别</th><th class="num">基准比例</th><th class="num">系统比例</th><th>受益所有人集合</th><th>结果</th></tr></thead>
          <tbody>${ctrl.rows.map(row => `<tr>
            <td>${row.snapshot}</td><td title="${escapeHtml(row.companyKey)}">${escapeHtml(r.truthNames?.[row.companyKey] ?? row.companyKey)}</td>
            <td title="${escapeHtml(row.expectedLeader ?? '')}">${escapeHtml(row.expectedLeader ? (r.truthNames?.[row.expectedLeader] ?? row.expectedLeader) : '无')}</td>
            <td class="${row.match ? '' : 'miss'}" title="${escapeHtml(row.actualLeader ?? '')}">${escapeHtml(row.actualLeader ? (r.truthNames?.[row.actualLeader] ?? row.actualLeader) : '无')}</td>
            <td class="num">${(row.expectedPct * 100).toFixed(2)}%</td><td class="num">${(row.actualPct * 100).toFixed(2)}%</td>
            <td>${row.ownerSetMatch ? '<span class="pass">一致</span>' : '<span class="miss">不一致</span>'}</td>
            <td>${row.match ? '<span class="pass">✓</span>' : '<span class="miss">✗</span>'}</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="table-card">
        <h3 style="font-size:14px;margin-bottom:10px">主体归并差异</h3>
        ${!r.entity!.persons.splitTruth.length && !r.entity!.persons.mergedTruth.length
          ? '<div style="font-size:12.5px;color:var(--good)">自然人与企业归并结果均与基准完全一致。</div>'
          : `<table class="data-table"><thead><tr><th>类型</th><th>基准主体</th><th>系统结果</th><th class="num">记录</th></tr></thead><tbody>
            ${r.entity!.persons.splitTruth.map(s => `<tr><td class="miss">被拆分</td><td>${s.truth}</td><td>${s.predicted.join(' / ')}</td><td class="num">${s.records}</td></tr>`).join('')}
            ${r.entity!.persons.mergedTruth.map(s => `<tr><td class="miss">被误并</td><td>${escapeHtml(s.predicted)}</td><td>${s.truth.join(' / ')}</td><td class="num">${s.records}</td></tr>`).join('')}
          </tbody></table>`}
        <div style="font-size:11.8px;color:var(--ink-3);margin-top:10px">基准数据独立存放于 data/truth（由独立的稠密矩阵求解生成），系统仅通过 /api/evaluate 读取比对。</div>
      </div>
    `;
  } catch (err) {
    root.className = 'accuracy-root empty-state';
    root.textContent = (err as Error).message;
  }
}

$('#evalBtn').addEventListener('click', () => void runEval());

// ---------------- manual merge / split ----------------

function syncMergeSelection() {
  const ids = new Set(state.mergeSelection);
  $$('.entity-row').forEach(r => {
    const id = (r as HTMLElement).dataset.entityId;
    r.classList.toggle('multi', Boolean(id && ids.has(id)));
  });
  const btn = $('#entityMerge') as HTMLButtonElement;
  btn.disabled = state.mergeSelection.length < 2;
  btn.textContent = `合并所选 (${state.mergeSelection.length})`;
}

$('#entityMerge').addEventListener('click', async () => {
  if (state.mergeSelection.length < 2) return;
  if (!confirm(`确认把所选 ${state.mergeSelection.length} 个主体合并为同一主体？（将影响穿透与实控人结果）`)) return;
  try {
    const r = await api.mergeEntities(state.mergeSelection, '人工确认同名主体');
    toast(`已合并，当前 ${r.entities.companies} 企业 / ${r.entities.persons} 自然人`, 'ok');
    state.mergeSelection = [];
    state.selectedEntityId = null;
    await loadEntities();
    await loadManualEdits();
    await refreshMeta();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
});

$('#entityUndo').addEventListener('click', async () => {
  const r = await api.undoManualEdits();
  toast(`已撤销人工调整，${r.entities.companies} 企业 / ${r.entities.persons} 自然人`, 'ok');
  state.mergeSelection = [];
  await loadEntities();
  await loadManualEdits();
  await refreshMeta();
});

async function loadManualEdits() {
  const box = $('#manualList');
  try {
    const data = await api.manualEdits();
    const total = data.merges.length + data.splits.length;
    $('#manualBadge').textContent = String(total);
    $('#manualBadge').className = `tag ${total ? 'warn' : 'muted'}`;
    box.innerHTML = '';
    if (!total) {
      box.className = 'log-list empty-state';
      box.textContent = '尚无人工合并或拆分';
      return;
    }
    box.className = 'log-list';
    for (const m of data.merges) {
      const row = el('div', 'log-row warn');
      row.innerHTML = `<strong>合并</strong><span>${m.names.map(escapeHtml).join(' + ')} ${m.note ? '· ' + escapeHtml(m.note) : ''}</span>`;
      box.appendChild(row);
    }
    for (const sp of data.splits) {
      const row = el('div', 'log-row warn');
      row.innerHTML = `<strong>拆分</strong><span>${escapeHtml(sp.entityName)} 拆出 ${sp.recordIds.length} 条记录（${sp.recordIds.map(escapeHtml).join('、')}）</span>`;
      box.appendChild(row);
    }
  } catch {
    box.className = 'log-list empty-state';
    box.textContent = '人工调整记录加载失败';
  }
}

// ---------------- utils ----------------

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}
function debounce(fn: () => void, ms: number) {
  let t: number | undefined;
  return () => { window.clearTimeout(t); t = window.setTimeout(fn, ms); };
}

// ---------------- boot ----------------

(async function boot() {
  await refreshMeta();
  await initMappings();
  const meta = await api.meta();
  if (meta.counts.companies || meta.counts.holders) {
    await loadEntities();
  }
  ($('#graphDate') as HTMLInputElement).value = new Date().toISOString().slice(0, 10);
  ($('#ctrlDate') as HTMLInputElement).value = new Date().toISOString().slice(0, 10);
  showPage('import');
})();
