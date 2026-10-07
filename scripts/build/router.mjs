// 沿铁路网的径路计算：车站吸附到附近线路 + 多源多汇 A*
import { MinHeap } from '../lib/heap.mjs';
import { haversine, nearestOnPolyline } from '../lib/geo.mjs';

// 各类列车在不同等级线路上的代价系数（edge.cls：0 高速 1 快速/城际 2 普速干线 3 普速支线 4 窄轨 5 联络线）
export const ROUTING_CLASS = { G: 'HS', C: 'HS', D: 'D', S: 'D' }; // S：市域（郊）动车组，多跑在高速、快速线上
// 6 货运线：客车很少走，普遍加价
export const MULT = {
  HS: [1.0, 1.05, 1.6, 1.9, 6.0, 1.15, 2.5],
  D: [1.0, 1.0, 1.25, 1.5, 6.0, 1.1, 2.2],
  CONV: [3.0, 1.3, 1.0, 1.05, 1.5, 1.1, 1.6],
};
export const routingClassOf = (cls) => ROUTING_CLASS[cls] || 'CONV';

export class Router {
  constructor(graph, edgeIndex) {
    const { edges, vLon, vLat } = graph;
    this.edges = edges; this.vLon = vLon; this.vLat = vLat; this.index = edgeIndex;
    const V = vLon.length; const E = edges.length;
    this.V = V;
    this.len = new Float64Array(E); this.cls = new Uint8Array(E);
    this.v0 = new Int32Array(E); this.v1 = new Int32Array(E);
    const deg = new Int32Array(V + 1);
    edges.forEach((e, i) => { this.len[i] = e.len; this.cls[i] = e.cls; this.v0[i] = e.v0; this.v1[i] = e.v1; deg[e.v0]++; deg[e.v1]++; });
    this.adjStart = new Int32Array(V + 1);
    for (let v = 0; v < V; v++) this.adjStart[v + 1] = this.adjStart[v] + deg[v];
    this.adjEdge = new Int32Array(this.adjStart[V]); this.adjTo = new Int32Array(this.adjStart[V]);
    const fill = this.adjStart.slice(0, V);
    edges.forEach((e, i) => {
      this.adjEdge[fill[e.v0]] = i; this.adjTo[fill[e.v0]++] = e.v1;
      this.adjEdge[fill[e.v1]] = -(i + 1); this.adjTo[fill[e.v1]++] = e.v0; // 负数表示反向通过
    });
    this.g = new Float64Array(V); this.stamp = new Int32Array(V); this.closed = new Int32Array(V);
    this.prevEdge = new Int32Array(V); this.srcAtt = new Int16Array(V);
    this.curStamp = 0; this.heap = new MinHeap(4096);
  }

  /**
   * 车站吸附：返回附近若干条线路上的最近点 [{edge, offset, dist}]
   * 在 1.5 公里内搜索，每种（等级, 线名）至少保留最近的一条，避免大站附近的股道全属于同一条线而错过另一条线；
   * 1.5 公里内没有线路时再放宽到 4 公里。
   */
  attach(lon, lat, { radii = [1500, 4000], maxCount = 10 } = {}) {
    for (const r of radii) {
      const cand = this.index.query(lon, lat, r);
      const res = [];
      for (const ei of cand) {
        const e = this.edges[ei];
        const nr = nearestOnPolyline(lon, lat, e.lons, e.lats, e.cum);
        if (nr.dist <= r) res.push({ edge: ei, offset: nr.offset, dist: nr.dist, key: `${e.cls}|${e.name}` });
      }
      if (!res.length) continue;
      res.sort((a, b) => a.dist - b.dist);
      const picked = []; const keys = new Set();
      for (const a of res) if (!keys.has(a.key)) { keys.add(a.key); picked.push(a); }
      for (const a of res) { if (picked.length >= maxCount) break; if (!picked.includes(a)) picked.push(a); }
      picked.sort((a, b) => a.dist - b.dist);
      return { atts: picked.slice(0, Math.max(maxCount, keys.size)), radius: r };
    }
    return { atts: [], radius: 0 };
  }

  /** 连通分量（并查集），用于跳过不可达的搜索 */
  components() {
    if (this.comp) return this.comp;
    const parent = new Int32Array(this.V).map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let e = 0; e < this.v0.length; e++) { const a = find(this.v0[e]); const b = find(this.v1[e]); if (a !== b) parent[a] = b; }
    const comp = new Int32Array(this.V);
    for (let v = 0; v < this.V; v++) comp[v] = find(v);
    this.comp = comp;
    return comp;
  }
  edgeComp(e) { return this.components()[this.v0[e]]; }

  /**
   * 计算 A→B 的径路。src/dst: {lon, lat, atts}。返回 { path: [oA, oB, e1, e2, ...], length } 或 null。
   * e 为 1 起的边编号，负数表示逆向通过该边。
   */
  route(src, dst, rc, { maxLength = 0 } = {}) {
    const mult = MULT[rc] || MULT.CONV;
    const { len, cls, v0, v1, vLon, vLat } = this;
    // 起终点不在同一连通分量：直接放弃（否则会把整个分量搜索一遍）
    const srcComps = new Set(src.atts.map((a) => this.edgeComp(a.edge)));
    if (!dst.atts.some((b) => srcComps.has(this.edgeComp(b.edge)))) return { unreachable: true };
    const straight = haversine(src.lon, src.lat, dst.lon, dst.lat);
    // 搜索上限：几何上限，或按两站间运行时间推算的最长可能里程（代价含系数，放宽 2 倍）
    const limit = Math.max(straight * 3 + 30000, straight * 2 + 80000, maxLength * 2);
    const dstR = dst.atts.reduce((m, a) => Math.max(m, a.dist), 0);
    let best = Infinity; let bestInfo = null;
    // 同一条边上直接到达
    for (const a of src.atts) {
      for (const b of dst.atts) {
        if (a.edge !== b.edge) continue;
        const c = Math.abs(b.offset - a.offset) * mult[cls[a.edge]] + 2 * (a.dist + b.dist);
        if (c < best) { best = c; bestInfo = { direct: true, a, b }; }
      }
    }
    // 目标顶点
    const targets = new Map();
    const addT = (v, t) => { if (!targets.has(v)) targets.set(v, []); targets.get(v).push(t); };
    for (const b of dst.atts) {
      const m = mult[cls[b.edge]];
      addT(v0[b.edge], { b, extra: b.offset * m + 2 * b.dist, sign: 1 });
      addT(v1[b.edge], { b, extra: (len[b.edge] - b.offset) * m + 2 * b.dist, sign: -1 });
    }
    const st = ++this.curStamp;
    const { g, stamp, closed, prevEdge, srcAtt, heap } = this;
    heap.clear();
    const h = (v) => Math.max(0, haversine(vLon[v], vLat[v], dst.lon, dst.lat) - dstR) * 0.999;
    const relaxSrc = (v, c, ai) => {
      if (stamp[v] !== st || c < g[v]) { stamp[v] = st; g[v] = c; prevEdge[v] = 0; srcAtt[v] = ai; heap.push(c + h(v), v); }
    };
    src.atts.forEach((a, ai) => {
      const m = mult[cls[a.edge]];
      relaxSrc(v0[a.edge], a.offset * m + 2 * a.dist, ai);
      relaxSrc(v1[a.edge], (len[a.edge] - a.offset) * m + 2 * a.dist, ai);
    });
    let expanded = 0;
    while (heap.size) {
      const f = heap.peekKey();
      if (f >= best || f > limit) break;
      const v = heap.pop();
      if (closed[v] === st) continue;
      closed[v] = st;
      expanded++;
      const gv = g[v];
      const ts = targets.get(v);
      if (ts) for (const t of ts) { const c = gv + t.extra; if (c < best) { best = c; bestInfo = { v, t }; } }
      for (let k = this.adjStart[v]; k < this.adjStart[v + 1]; k++) {
        const se = this.adjEdge[k]; const e = se >= 0 ? se : -se - 1;
        const u = this.adjTo[k];
        const ng = gv + len[e] * mult[cls[e]];
        if (stamp[u] !== st || ng < g[u]) {
          if (closed[u] === st) continue;
          stamp[u] = st; g[u] = ng; prevEdge[u] = se >= 0 ? e + 1 : -(e + 1); srcAtt[u] = -1;
          heap.push(ng + h(u), u);
        }
      }
    }
    if (!bestInfo) return null;
    if (bestInfo.direct) {
      const { a, b } = bestInfo;
      const sgn = b.offset >= a.offset ? 1 : -1;
      return { path: [Math.round(a.offset), Math.round(b.offset), sgn * (a.edge + 1)], length: Math.abs(b.offset - a.offset), expanded };
    }
    // 回溯
    const { v: endV, t } = bestInfo;
    const mid = [];
    let v = endV;
    while (prevEdge[v] !== 0) {
      const se = prevEdge[v]; const e = Math.abs(se) - 1;
      mid.push(se);
      v = se > 0 ? v0[e] : v1[e];
    }
    mid.reverse();
    const a = src.atts[srcAtt[v]];
    // 起点边方向：若到达的顶点是该边终点 v1，则正向（offset → 终点）
    const firstSign = v === v1[a.edge] && v !== v0[a.edge] ? 1 : v === v0[a.edge] && v !== v1[a.edge] ? -1
      : (a.offset * 1 <= len[a.edge] - a.offset ? -1 : 1);
    const b = t.b;
    const path = [Math.round(a.offset), Math.round(b.offset), firstSign * (a.edge + 1), ...mid, t.sign * (b.edge + 1)];
    return { path, length: pathLength(path, len), expanded };
  }
}

/** 按编码计算径路长度（与前端一致） */
export function pathLength(path, len) {
  const [oA, oB, ...es] = path;
  if (es.length === 1) return Math.abs(oB - oA);
  const e1 = Math.abs(es[0]) - 1; const en = Math.abs(es[es.length - 1]) - 1;
  let L = es[0] > 0 ? len[e1] - oA : oA;
  for (let i = 1; i < es.length - 1; i++) L += len[Math.abs(es[i]) - 1];
  L += es[es.length - 1] > 0 ? oB : len[en] - oB;
  return L;
}

/** 在编码径路上按距离取点 */
export function pointOnPath(path, edges, d) {
  const [oA, oB, ...es] = path;
  const pieces = [];
  if (es.length === 1) {
    const e = edges[Math.abs(es[0]) - 1];
    pieces.push({ e, from: oA, to: oB });
  } else {
    es.forEach((se, i) => {
      const e = edges[Math.abs(se) - 1];
      let from; let to;
      if (i === 0) { from = oA; to = se > 0 ? e.len : 0; } else if (i === es.length - 1) { from = se > 0 ? 0 : e.len; to = oB; } else { from = se > 0 ? 0 : e.len; to = se > 0 ? e.len : 0; }
      pieces.push({ e, from, to });
    });
  }
  let acc = 0;
  for (const p of pieces) {
    const L = Math.abs(p.to - p.from);
    if (d <= acc + L || p === pieces[pieces.length - 1]) {
      const off = p.from + Math.sign(p.to - p.from || 1) * Math.min(L, Math.max(0, d - acc));
      return interp(p.e, off);
    }
    acc += L;
  }
  return null;
}
function interp(e, off) {
  const { lons, lats, cum } = e;
  const n = lons.length;
  if (off <= 0) return [lons[0], lats[0]];
  if (off >= cum[n - 1]) return [lons[n - 1], lats[n - 1]];
  let lo = 0; let hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= off) lo = m; else hi = m; }
  const t = (off - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return [lons[lo] + t * (lons[hi] - lons[lo]), lats[lo] + t * (lats[hi] - lats[lo])];
}

/** 遍历编码径路经过的每条边及其通过长度 */
export function forEachEdgeOnPath(path, len, fn) {
  const [oA, oB, ...es] = path;
  if (es.length === 1) { fn(Math.abs(es[0]) - 1, Math.abs(oB - oA)); return; }
  es.forEach((se, i) => {
    const e = Math.abs(se) - 1;
    const L = i === 0 ? (se > 0 ? len[e] - oA : oA) : i === es.length - 1 ? (se > 0 ? oB : len[e] - oB) : len[e];
    fn(e, L);
  });
}

/** 编码径路 → 折线（经纬度 + 累计长度） */
export function pathPolyline(path, edges) {
  const lons = []; const lats = [];
  const push = (x, y) => { const n = lons.length; if (n && lons[n - 1] === x && lats[n - 1] === y) return; lons.push(x); lats.push(y); };
  const piece = (E, from, to) => {
    let p = interp(E, from); push(p[0], p[1]);
    const { cum } = E;
    if (to > from) { for (let k = 0; k < cum.length; k++) if (cum[k] > from && cum[k] < to) push(E.lons[k], E.lats[k]); }
    else { for (let k = cum.length - 1; k >= 0; k--) if (cum[k] < from && cum[k] > to) push(E.lons[k], E.lats[k]); }
    p = interp(E, to); push(p[0], p[1]);
  };
  const [oA, oB, ...es] = path;
  if (es.length === 1) piece(edges[Math.abs(es[0]) - 1], oA, oB);
  else es.forEach((se, i) => {
    const E = edges[Math.abs(se) - 1];
    if (i === 0) piece(E, oA, se > 0 ? E.len : 0);
    else if (i === es.length - 1) piece(E, se > 0 ? 0 : E.len, oB);
    else piece(E, se > 0 ? 0 : E.len, se > 0 ? E.len : 0);
  });
  const L = Float64Array.from(lons); const T = Float64Array.from(lats); const cum = new Float64Array(L.length);
  for (let k = 1; k < L.length; k++) cum[k] = cum[k - 1] + haversine(L[k - 1], T[k - 1], L[k], T[k]);
  return { lons: L, lats: T, cum };
}
