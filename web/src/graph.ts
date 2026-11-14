/** Force-directed-ish layered equity graph with pan / wheel-zoom / expand. */
import { GraphEdge, GraphNode, GraphPayload } from './api.js';

interface Positioned { id: string; x: number; y: number; vx: number; vy: number; node: GraphNode; }

export interface GraphViewOptions {
  onSelect: (id: string | null) => void;
  onExpand: (id: string) => void;
  mode: 'all' | 'company';
  focused: string | null;
}

const NODE_R = 13;
const PERSON_R = 11;

export class OwnershipGraph {
  private svg: SVGSVGElement;
  private tip: HTMLElement;
  private viewBox = { x: 0, y: 0, w: 1000, h: 660 };
  private nodes = new Map<string, Positioned>();
  private edges: GraphEdge[] = [];
  private payload: GraphPayload | null = null;
  private opts: GraphViewOptions;
  private dragging = false;
  private dragStart = { x: 0, y: 0, vx: 0, vy: 0 };
  private dragNode: Positioned | null = null;
  private neighborSet = new Set<string>();

  constructor(svg: SVGSVGElement, tip: HTMLElement, opts: GraphViewOptions) {
    this.svg = svg;
    this.tip = tip;
    this.opts = opts;
    this.bindInteractions();
  }

  setOptions(patch: Partial<GraphViewOptions>) {
    this.opts = { ...this.opts, ...patch };
    this.render();
  }

  private visibleEdges(): GraphEdge[] {
    if (!this.payload) return [];
    if (this.opts.mode === 'company') {
      const companies = new Set(this.payload.nodes.filter(n => n.kind === 'company').map(n => n.id));
      return this.payload.edges.filter(e => companies.has(e.holderId));
    }
    return this.payload.edges;
  }

  private visibleNodes(): Map<string, GraphNode> {
    const out = new Map<string, GraphNode>();
    if (!this.payload) return out;
    for (const n of this.payload.nodes) {
      if (this.opts.mode === 'company' && n.kind === 'person') continue;
      out.set(n.id, n);
    }
    // drop isolated noise only when the graph is large
    const edges = this.visibleEdges();
    if (out.size > 45) {
      const connected = new Set<string>();
      for (const e of edges) { connected.add(e.companyId); connected.add(e.holderId); }
      for (const id of [...out.keys()]) if (!connected.has(id)) out.delete(id);
    }
    return out;
  }

  setData(payload: GraphPayload) {
    this.payload = payload;
    this.layout();
    this.fit();
    this.render();
  }

  /** Layered layout: persons on the left, companies by ownership depth to the right. */
  private layout() {
    if (!this.payload) return;
    const visible = this.visibleNodes();
    const edges = this.visibleEdges();
    // Depth of each company = longest ownership chain reaching it. Cycles are
    // first condensed into SCCs so cross-holdings do not make depth diverge.
    const companyIds = [...visible.values()].filter(n => n.kind === 'company').map(n => n.id);
    const holderAdj = new Map<string, Set<string>>();
    for (const id of companyIds) holderAdj.set(id, new Set());
    for (const e of edges) {
      if (!visible.has(e.holderId)) continue;
      if (visible.get(e.holderId)!.kind !== 'company') continue;
      if (!holderAdj.has(e.companyId)) continue;
      holderAdj.get(e.companyId)!.add(e.holderId);
    }
    // Tarjan SCC over the "held-by" graph
    let counter = 0;
    const idx = new Map<string, number>(); const low = new Map<string, number>();
    const stack: string[] = []; const onStack = new Set<string>();
    const sccOf = new Map<string, number>();
    let sccCount = 0;
    const strong = (v: string) => {
      idx.set(v, counter); low.set(v, counter); counter++;
      stack.push(v); onStack.add(v);
      for (const w of holderAdj.get(v) ?? []) {
        if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
      if (low.get(v) === idx.get(v)) {
        while (true) {
          const w = stack.pop()!; onStack.delete(w); sccOf.set(w, sccCount);
          if (w === v) break;
        }
        sccCount++;
      }
    };
    for (const c of companyIds) if (!idx.has(c)) strong(c);
    const sccDepth = new Map<number, number>();
    const compHolders = new Map<number, Set<number>>();
    for (let i = 0; i < sccCount; i++) { compHolders.set(i, new Set()); sccDepth.set(i, 0); }
    for (const [company, holders] of holderAdj) {
      const a = sccOf.get(company)!;
      for (const h of holders) {
        const b = sccOf.get(h)!;
        if (a !== b) compHolders.get(a)!.add(b);
      }
    }
    for (let iter = 0; iter < sccCount + 2; iter++) {
      let changed = false;
      for (const [a, holders] of compHolders) {
        let d = sccDepth.get(a)!;
        for (const b of holders) d = Math.max(d, sccDepth.get(b)! + 1);
        if (d !== sccDepth.get(a)) { sccDepth.set(a, d); changed = true; }
      }
      if (!changed) break;
    }
    const depth = new Map<string, number>();
    for (const c of companyIds) depth.set(c, sccDepth.get(sccOf.get(c)!) ?? 0);

    const layers = new Map<number, string[]>();
    for (const n of visible.values()) {
      const d = n.kind === 'person' ? 0 : (depth.get(n.id) ?? 0) + 1;
      if (!layers.has(d)) layers.set(d, []);
      layers.get(d)!.push(n.id);
    }
    const maxDepth = Math.max(...layers.keys(), 1);
    const widestLayer = Math.max(...[...layers.values()].map(l => l.length), 1);
    const width = Math.max(1000, 250 * (maxDepth + 1));
    // keep the layout roughly 16:9 so it fills the panel instead of collapsing
    const height = Math.max(620, Math.min(widestLayer * 74, width * 0.66));
    this.viewBox = { x: 0, y: 0, w: width, h: height };
    const old = this.nodes;
    this.nodes = new Map();
    const layerKeys = [...layers.keys()].sort((a, b) => a - b);
    for (const d of layerKeys) {
      const ids = layers.get(d)!.sort((a, b) => {
        const na = visible.get(a)!; const nb = visible.get(b)!;
        return na.name.localeCompare(nb.name, 'zh');
      });
      const x = 70 + (d * (width - 140)) / Math.max(maxDepth, 1);
      // spread vertically but keep a pleasant density (not one full-height stack)
      const columnHeight = Math.min(height - 80, ids.length * 62);
      const startY = (height - columnHeight) / 2;
      const spacing = ids.length > 1 ? columnHeight / (ids.length - 1) : 0;
      ids.forEach((id, i) => {
        const prev = old.get(id);
        const targetY = startY + i * spacing;
        this.nodes.set(id, {
          id, node: visible.get(id)!,
          x: prev?.x ?? x, y: prev?.y ?? targetY,
          vx: x, vy: targetY,
        });
      });
    }
    // settle with a few relaxation passes
    this.relax(edges, 220);
  }

  private relax(edges: GraphEdge[], iterations: number) {
    const nodes = [...this.nodes.values()];
    // remember the layered target so relaxation only nudges, never destroys layers
    const target = new Map(nodes.map(n => [n.id, { x: n.vx, y: n.vy }]));
    const index = new Map(nodes.map(n => [n.id, n]));
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      if (!index.has(e.companyId) || !index.has(e.holderId)) continue;
      (adj.get(e.companyId) ?? adj.set(e.companyId, []).get(e.companyId)!).push(e.holderId);
      (adj.get(e.holderId) ?? adj.set(e.holderId, []).get(e.holderId)!).push(e.companyId);
    }
    const disp = new Map<string, { x: number; y: number }>(nodes.map(n => [n.id, { x: 0, y: 0 }]));
    for (let it = 0; it < iterations; it++) {
      const cooling = 1 - it / iterations;
      for (const d of disp.values()) { d.x = 0; d.y = 0; }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = (i % 2 ? 1 : -1); dy = (j % 2 ? 1 : -1); d2 = 1; }
          const maxRepel = 210;
          if (d2 > maxRepel * maxRepel) continue;
          const d = Math.sqrt(d2);
          const force = (1500 / d2) * cooling;
          disp.get(a.id)!.x += (dx / d) * force;
          disp.get(a.id)!.y += (dy / d) * force;
          disp.get(b.id)!.x -= (dx / d) * force;
          disp.get(b.id)!.y -= (dy / d) * force;
        }
      }
      for (const n of nodes) {
        const t = target.get(n.id)!;
        const d = disp.get(n.id)!;
        // anchor spring back to the layer slot keeps the reading order stable
        n.x += d.x + (t.x - n.x) * 0.12;
        n.y += d.y + (t.y - n.y) * 0.12;
        n.x = Math.max(50, Math.min(this.viewBox.w - 50, n.x));
        n.y = Math.max(40, Math.min(this.viewBox.h - 40, n.y));
      }
    }
    // final snap most of the way back to targets so columns stay readable
    for (const n of nodes) {
      const t = target.get(n.id)!;
      n.x = n.x * 0.55 + t.x * 0.45;
      n.y = n.y * 0.55 + t.y * 0.45;
    }
  }

  /** Fit all nodes with padding, preserving the container's aspect ratio. */
  fit() {
    const nodes = [...this.nodes.values()];
    const rect = this.svg.getBoundingClientRect();
    const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 16 / 9;
    if (!nodes.length) {
      this.viewBox = { x: 0, y: 0, w: 1000, h: 1000 / aspect };
      this.applyViewBox();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      // leave room for the label drawn to the right of each circle
      minX = Math.min(minX, n.x - 40);
      minY = Math.min(minY, n.y - 34);
      maxX = Math.max(maxX, n.x + 190);
      maxY = Math.max(maxY, n.y + 34);
    }
    const pad = 26;
    let w = maxX - minX + pad * 2;
    let h = maxY - minY + pad * 2;
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.viewBox = { x: cx - w / 2, y: cy - h / 2, w, h };
    this.applyViewBox();
  }

  private applyViewBox() {
    const { x, y, w, h } = this.viewBox;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }

  zoom(factor: number, cx?: number, cy?: number) {
    const { x, y, w, h } = this.viewBox;
    const nw = Math.max(180, Math.min(5000, w / factor));
    const nh = Math.max(120, Math.min(4000, h / factor));
    const px = cx ?? x + w / 2;
    const py = cy ?? y + h / 2;
    this.viewBox = {
      x: px - (px - x) * (nw / w),
      y: py - (py - y) * (nh / h),
      w: nw, h: nh,
    };
    this.applyViewBox();
  }

  focusOn(id: string) {
    const n = this.nodes.get(id);
    if (!n) return;
    const { w, h } = this.viewBox;
    this.viewBox = { x: n.x - w / 2, y: n.y - h / 2, w, h };
    this.applyViewBox();
  }

  private bindInteractions() {
    this.svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      const px = this.viewBox.x + ((ev.clientX - rect.left) / rect.width) * this.viewBox.w;
      const py = this.viewBox.y + ((ev.clientY - rect.top) / rect.height) * this.viewBox.h;
      this.zoom(ev.deltaY < 0 ? 1.12 : 0.89, px, py);
    }, { passive: false });

    this.svg.addEventListener('mousedown', (ev) => {
      const target = ev.target as Element;
      const nodeEl = target.closest('[data-node-id]') as SVGElement | null;
      if (nodeEl) {
        const id = nodeEl.getAttribute('data-node-id')!;
        this.dragNode = this.nodes.get(id) ?? null;
      }
      this.dragging = true;
      this.dragStart = { x: ev.clientX, y: ev.clientY, vx: this.viewBox.x, vy: this.viewBox.y };
    });

    window.addEventListener('mousemove', (ev) => {
      if (!this.dragging) return;
      const rect = this.svg.getBoundingClientRect();
      const scale = this.viewBox.w / rect.width;
      if (this.dragNode) {
        const n = this.dragNode;
        n.x = Math.max(30, Math.min(this.viewBox.w - 30, n.x + (ev.clientX - this.dragStart.x) * scale));
        n.y = Math.max(24, Math.min(this.viewBox.h - 24, n.y + (ev.clientY - this.dragStart.y) * scale));
        this.dragStart.x = ev.clientX; this.dragStart.y = ev.clientY;
        this.render();
      } else {
        this.viewBox.x = this.dragStart.vx - (ev.clientX - this.dragStart.x) * scale;
        this.viewBox.y = this.dragStart.vy - (ev.clientY - this.dragStart.y) * scale;
        this.applyViewBox();
      }
    });

    window.addEventListener('mouseup', (ev) => {
      if (this.dragging && Math.abs(ev.clientX - this.dragStart.x) < 3 && Math.abs(ev.clientY - this.dragStart.y) < 3) {
        const target = ev.target as Element;
        const nodeEl = target.closest('[data-node-id]') as SVGElement | null;
        if (nodeEl) {
          const id = nodeEl.getAttribute('data-node-id')!;
          this.opts.onSelect(id);
          return;
        }
        this.opts.onSelect(null);
      }
      this.dragging = false;
      this.dragNode = null;
    });

    this.svg.addEventListener('dblclick', (ev) => {
      const target = ev.target as Element;
      const nodeEl = target.closest('[data-node-id]') as SVGElement | null;
      if (nodeEl) this.opts.onExpand(nodeEl.getAttribute('data-node-id')!);
    });
  }

  /** Distinct display label: append the ID tail when two persons share a name. */
  private displayLabels(): Map<string, string> {
    const counts = new Map<string, number>();
    for (const n of this.payload?.nodes ?? []) counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
    const out = new Map<string, string>();
    for (const n of this.payload?.nodes ?? []) {
      let label = n.name;
      if (n.kind === 'person' && (counts.get(n.name) ?? 0) > 1) {
        const frag = n.idFragments?.[0] ?? '';
        const tail = frag.replace(/[^0-9A-Za-z]/g, '').slice(-4);
        label = tail ? `${n.name}·${tail}` : `${n.name}·?`;
      }
      out.set(n.id, label);
    }
    return out;
  }

  private nodeColor(n: GraphNode, cycleIds: Set<string>, controllerIds: Set<string>): string {
    if (cycleIds.has(n.id)) return '#b8404a';
    if (n.kind === 'person' && controllerIds.has(n.id)) return '#1f8a5b';
    return n.kind === 'person' ? '#2c5f9e' : '#6e7f95';
  }

  render() {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    if (!this.payload) {
      this.applyViewBox();
      return;
    }
    const visible = this.visibleNodes();
    const labels = this.displayLabels();
    const edges = this.visibleEdges().filter(e => visible.has(e.companyId) && visible.has(e.holderId));
    const cycleIds = new Set<string>();
    const nameToId = new Map(this.payload.nodes.map(n => [n.name, n.id]));
    for (const cycle of this.payload.cycles) for (const name of cycle) {
      const id = nameToId.get(name);
      if (id) cycleIds.add(id);
    }
    const controllerIds = new Set<string>();
    for (const c of this.payload.controllers) if (c.leaderEntityId) controllerIds.add(c.leaderEntityId);

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    // edges behind nodes
    for (const e of edges) {
      const a = this.nodes.get(e.holderId);
      const b = this.nodes.get(e.companyId);
      if (!a || !b) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - 18;
      path.setAttribute('d', `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`);
      const emphasis = this.opts.focused && (e.holderId === this.opts.focused || e.companyId === this.opts.focused);
      const cycleEdge = cycleIds.has(e.holderId) && cycleIds.has(e.companyId);
      path.setAttribute('class', 'edge');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', cycleEdge ? '#d98d94' : emphasis ? '#4c8bd6' : '#c3ccd8');
      path.setAttribute('stroke-width', String(Math.max(1.1, Math.min(5, 0.9 + e.pct * 9))));
      path.setAttribute('marker-end', 'url(#arrow)');
      if (!emphasis && this.opts.focused) path.setAttribute('opacity', '0.4');
      // label density control: at overview zoom only show material edges
      const zoomedIn = this.viewBox.w < 1200;
      const showLabel = emphasis || zoomedIn || e.pct >= 0.15;
      let label: SVGTextElement | null = null;
      if (showLabel) {
        label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', String(mx));
        label.setAttribute('y', String(my));
        label.setAttribute('class', 'edge-label');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('opacity', emphasis || zoomedIn ? '1' : '0.75');
        label.textContent = `${(e.pct * 100).toFixed(e.pct < 0.01 ? 2 : 1)}%`;
      }
      const tipEdge = `${labels.get(a.id) ?? a.node.name} → ${labels.get(b.id) ?? b.node.name}：${(e.pct * 100).toFixed(2)}%（${e.effectiveDate}，${e.source}）`;
      path.addEventListener('mouseenter', (ev) => this.showTip(ev as MouseEvent, tipEdge));
      path.addEventListener('mouseleave', () => this.hideTip());
      g.appendChild(path);
      if (label) g.appendChild(label);
    }

    // nodes
    for (const p of this.nodes.values()) {
      const n = p.node;
      const r = n.kind === 'person' ? PERSON_R : NODE_R;
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('data-node-id', n.id);
      group.setAttribute('class', 'node');
      if (this.opts.focused === n.id) group.setAttribute('opacity', '1');
      else if (this.opts.focused) {
        const related = edges.some(e => (e.holderId === this.opts.focused && e.companyId === n.id) ||
          (e.companyId === this.opts.focused && e.holderId === n.id) || n.id === this.opts.focused);
        if (!related) group.setAttribute('opacity', '0.35');
      }
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(p.x));
      circle.setAttribute('cy', String(p.y));
      circle.setAttribute('r', String(r));
      circle.setAttribute('fill', this.nodeColor(n, cycleIds, controllerIds));
      circle.setAttribute('stroke', cycleIds.has(n.id) ? '#8f2f38' : '#ffffff');
      circle.setAttribute('stroke-width', cycleIds.has(n.id) ? '2.5' : '2');
      if (cycleIds.has(n.id)) {
        circle.setAttribute('stroke-dasharray', '4 2');
      }
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(p.x + r + 6));
      text.setAttribute('y', String(p.y + 4));
      text.setAttribute('class', n.kind === 'person' ? 'node-label person' : 'node-label company');
      const label = labels.get(n.id) ?? n.name;
      text.textContent = label.length > 16 ? label.slice(0, 15) + '…' : label;
      group.appendChild(circle);
      group.appendChild(text);
      const tipText = `${labels.get(n.id) ?? n.name}${n.uscc ? '（' + n.uscc + '）' : ''}｜${n.kind === 'person' ? '自然人' : '企业'}${n.controllerOf.length ? '｜控制：' + n.controllerOf.map(id => this.payload!.nodes.find(x => x.id === id)?.name ?? '').join('、') : ''}｜双击展开上下游`;
      group.addEventListener('mouseenter', (ev) => this.showTip(ev as MouseEvent, tipText));
      group.addEventListener('mouseleave', () => this.hideTip());
      g.appendChild(group);
    }
    this.svg.appendChild(g);
    this.ensureDefs();
  }

  private ensureDefs() {
    if (this.svg.querySelector('defs')) return;
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<marker id="arrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#b7c1cf"/></marker>';
    this.svg.insertBefore(defs, this.svg.firstChild);
  }

  private showTip(ev: MouseEvent, text: string) {
    const rect = this.svg.getBoundingClientRect();
    this.tip.textContent = text;
    this.tip.style.left = `${ev.clientX - rect.left + 14}px`;
    this.tip.style.top = `${ev.clientY - rect.top + 14}px`;
    this.tip.style.opacity = '1';
  }

  private hideTip() {
    this.tip.style.opacity = '0';
  }

  neighborIds(id: string): Set<string> {
    const set = new Set<string>();
    for (const e of this.edges) {
      if (e.companyId === id) set.add(e.holderId);
      if (e.holderId === id) set.add(e.companyId);
    }
    this.neighborSet = set;
    return set;
  }

  highlight(id: string | null) {
    this.opts.focused = id;
    this.render();
  }
}
