// 读取 Overpass 分块数据，构建铁路拓扑图（顶点=道岔/端点，边=两顶点间的线路）
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, log, warn } from '../lib/util.mjs';
import { classifyWay, EDGE_CLASSES } from '../lib/osm.mjs';
import { simplifyIndices, haversine, GridIndex, localProjector } from '../lib/geo.mjs';

const Q = 1e5; // 坐标量化：1e-5 度（约 1 米）

/** 读取 data/raw/osm/{rail,stations}/*.json.gz */
export function loadOsm(dir) {
  const nodeIndex = new Map();
  const lons = []; const lats = [];
  const ways = new Map();
  const stations = new Map();
  let osmBase = null;
  const railDir = path.join(dir, 'rail');
  const stDir = path.join(dir, 'stations');
  const files = fs.existsSync(railDir) ? fs.readdirSync(railDir).filter((f) => f.endsWith('.json.gz') || f.endsWith('.json')) : [];
  if (!files.length) throw new Error(`没有找到铁路线数据：${railDir}（请先运行 npm run fetch:osm）`);
  for (const f of files) {
    const j = readJSON(path.join(railDir, f));
    if (j.osm_base && (!osmBase || j.osm_base > osmBase)) osmBase = j.osm_base;
    for (const el of j.elements) {
      if (el.type === 'node') {
        if (!nodeIndex.has(el.id)) { nodeIndex.set(el.id, lons.length); lons.push(el.lon); lats.push(el.lat); }
      } else if (el.type === 'way' && el.nodes && el.tags && !ways.has(el.id)) {
        ways.set(el.id, { id: el.id, nodes: el.nodes, tags: el.tags });
      }
    }
  }
  if (fs.existsSync(stDir)) {
    for (const f of fs.readdirSync(stDir)) {
      if (!f.endsWith('.json.gz') && !f.endsWith('.json')) continue;
      const j = readJSON(path.join(stDir, f));
      for (const el of j.elements) {
        if (!el.tags) continue;
        const key = el.type + el.id;
        if (stations.has(key)) continue;
        const lat = el.lat ?? el.center?.lat; const lon = el.lon ?? el.center?.lon;
        if (lat === undefined || lon === undefined) continue;
        stations.set(key, { id: key, lon, lat, tags: el.tags });
      }
    }
  }
  log(`OSM：${files.length} 个分块，节点 ${lons.length}，线路 way ${ways.size}，车站要素 ${stations.size}`);
  return { nodeIndex, lons: Float64Array.from(lons), lats: Float64Array.from(lats), ways: [...ways.values()], stations: [...stations.values()], osmBase };
}

export function acceptWay(tags) {
  if (!['rail', 'narrow_gauge'].includes(tags.railway)) return false;
  if (['yard', 'siding', 'spur'].includes(tags.service)) return false;
  if (['industrial', 'military', 'tourism', 'test'].includes(tags.usage)) return false;
  if (tags['railway:preserved'] === 'yes' || tags.disused === 'yes' || tags.abandoned === 'yes') return false;
  return true;
}

/**
 * 构建拓扑图。返回：
 *  edges: [{ v0, v1, cls, name, lons: Float64Array, lats: Float64Array, cum: Float64Array, len }]
 *  vLon/vLat: 顶点坐标；names: 线路名称表
 */
export function buildGraph(osm, { simplifyTolerance = 5, bridgeGap = 100 } = {}) {
  const { nodeIndex, lons, lats } = osm;
  // 1) 接受的 way，节点 id → 下标
  const ways = [];
  let missing = 0;
  for (const w of osm.ways) {
    if (!acceptWay(w.tags)) continue;
    const idx = [];
    for (const id of w.nodes) {
      const i = nodeIndex.get(id);
      if (i === undefined) { missing++; continue; }
      if (idx.length && idx[idx.length - 1] === i) continue;
      idx.push(i);
    }
    if (idx.length >= 2) ways.push({ id: w.id, nodes: idx, cls: classifyWay(w.tags), name: w.tags['name:zh'] || w.tags.name || '' });
  }
  if (missing) warn(`有 ${missing} 个节点引用缺失（分块边界处的正常现象，已忽略）`);
  // 2) 节点使用次数，识别道岔/交汇点
  const N = lons.length;
  const count = new Uint16Array(N);
  const isEnd = new Uint8Array(N);
  for (const w of ways) {
    for (const i of w.nodes) count[i] = Math.min(65535, count[i] + 1);
    isEnd[w.nodes[0]] = 1; isEnd[w.nodes[w.nodes.length - 1]] = 1;
  }
  // 3) 断头处补缺口：线路端点附近（bridgeGap 米内）另一条线路的节点，视为相连（OSM 里道岔处常有几十米的缺口）
  let bridged = 0;
  if (bridgeGap > 0) {
    const grid = new GridIndex(0.002);
    const owner = new Int32Array(N).fill(-1);
    ways.forEach((w, wi) => { for (const i of w.nodes) { if (owner[i] === -1) { owner[i] = wi; grid.insertPoint(lons[i], lats[i], i); } } });
    const extra = [];
    ways.forEach((w, wi) => {
      for (const end of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
        if (count[end] !== 1) continue;
        let best = -1; let bestD = bridgeGap;
        for (const j of grid.query(lons[end], lats[end], bridgeGap)) {
          if (j === end || owner[j] === wi) continue;
          const d = haversine(lons[end], lats[end], lons[j], lats[j]);
          if (d < bestD) { bestD = d; best = j; }
        }
        if (best >= 0) {
          extra.push({ id: -extra.length - 1, nodes: [end, best], cls: 5, name: '' });
          count[end]++; count[best]++; isEnd[best] = 1;
          bridged++;
        }
      }
    });
    ways.push(...extra);
  }
  // 4) 在交汇点处切分 way → 原始边
  const vertexOf = new Int32Array(N).fill(-1);
  const vLonArr = []; const vLatArr = [];
  const vtx = (i) => {
    if (vertexOf[i] === -1) { vertexOf[i] = vLonArr.length; vLonArr.push(lons[i]); vLatArr.push(lats[i]); }
    return vertexOf[i];
  };
  let raw = [];
  for (const w of ways) {
    let start = 0;
    for (let k = 1; k < w.nodes.length; k++) {
      const i = w.nodes[k];
      if (k === w.nodes.length - 1 || count[i] > 1 || isEnd[i]) {
        const seg = w.nodes.slice(start, k + 1);
        raw.push({ v0: vtx(seg[0]), v1: vtx(seg[seg.length - 1]), nodes: seg, cls: w.cls, name: w.name });
        start = k;
      }
    }
  }
  // 5) 合并度为 2、属性相同的顶点两侧的边（减少碎片）
  const V = vLonArr.length;
  const inc = Array.from({ length: V }, () => []);
  raw.forEach((e, ei) => { inc[e.v0].push(ei); if (e.v1 !== e.v0) inc[e.v1].push(ei); else inc[e.v0].push(ei); });
  const mergeable = (v) => inc[v].length === 2 && inc[v][0] !== inc[v][1] &&
    raw[inc[v][0]].cls === raw[inc[v][1]].cls && raw[inc[v][0]].name === raw[inc[v][1]].name;
  const used = new Uint8Array(raw.length);
  const merged = [];
  const walk = (startV, ei) => {
    // 从顶点 startV 沿边 ei 出发，穿过可合并顶点，返回合并后的节点序列
    let nodes = []; let v = startV; let e = ei; let cls = raw[ei].cls; let name = raw[ei].name;
    while (true) {
      used[e] = 1;
      const r = raw[e];
      const seq = r.v0 === v ? r.nodes : [...r.nodes].reverse();
      nodes = nodes.length ? nodes.concat(seq.slice(1)) : seq.slice();
      v = r.v0 === v ? r.v1 : r.v0;
      if (!mergeable(v)) break;
      const next = inc[v][0] === e ? inc[v][1] : inc[v][0];
      if (used[next]) break;
      e = next;
    }
    return { nodes, v0: startV, v1: v, cls, name };
  };
  for (let v = 0; v < V; v++) {
    if (mergeable(v)) continue;
    for (const ei of inc[v]) if (!used[ei]) merged.push(walk(v, ei));
  }
  for (let ei = 0; ei < raw.length; ei++) if (!used[ei]) merged.push(walk(raw[ei].v0, ei)); // 纯环
  raw = null;
  // 6) 重新编号顶点（只保留仍被使用的），简化几何，量化坐标，计算长度
  const newId = new Int32Array(V).fill(-1);
  const vLon = []; const vLat = [];
  const nid = (v) => { if (newId[v] === -1) { newId[v] = vLon.length; vLon.push(vLonArr[v]); vLat.push(vLatArr[v]); } return newId[v]; };
  const names = ['']; const nameIdx = new Map([['', 0]]);
  const edges = [];
  let pts0 = 0; let pts1 = 0;
  for (const m of merged) {
    const n = m.nodes.length;
    pts0 += n;
    const proj = localProjector(lats[m.nodes[0]]);
    const xs = new Float64Array(n); const ys = new Float64Array(n);
    for (let k = 0; k < n; k++) { xs[k] = lons[m.nodes[k]] * proj.kx; ys[k] = lats[m.nodes[k]] * proj.ky; }
    const keep = simplifyIndices(xs, ys, simplifyTolerance);
    const el = new Float64Array(keep.length); const et = new Float64Array(keep.length);
    for (let k = 0; k < keep.length; k++) {
      el[k] = Math.round(lons[m.nodes[keep[k]]] * Q) / Q;
      et[k] = Math.round(lats[m.nodes[keep[k]]] * Q) / Q;
    }
    pts1 += keep.length;
    const cum = new Float64Array(keep.length);
    for (let k = 1; k < keep.length; k++) cum[k] = cum[k - 1] + haversine(el[k - 1], et[k - 1], el[k], et[k]);
    if (!nameIdx.has(m.name)) { nameIdx.set(m.name, names.length); names.push(m.name); }
    edges.push({ v0: nid(m.v0), v1: nid(m.v1), cls: m.cls, name: nameIdx.get(m.name), lons: el, lats: et, cum, len: cum[cum.length - 1] });
  }
  const totalKm = edges.reduce((s, e) => s + e.len, 0) / 1000;
  const byCls = EDGE_CLASSES.map((c) => `${c.name} ${(edges.filter((e) => e.cls === c.id).reduce((s, e) => s + e.len, 0) / 1000).toFixed(0)}km`);
  log(`路网：顶点 ${vLon.length}，边 ${edges.length}，总长 ${totalKm.toFixed(0)} km，补缺口 ${bridged} 处；坐标点 ${pts0} → ${pts1}（简化）`);
  log(`  ${byCls.join('，')}`);
  return { edges, vLon: Float64Array.from(vLon), vLat: Float64Array.from(vLat), names };
}

/** 边的空间索引：查询车站附近的线路 */
export function buildEdgeIndex(edges, cell = 0.02) {
  const grid = new GridIndex(cell);
  edges.forEach((e, ei) => {
    const seen = new Set();
    for (let k = 1; k < e.lons.length; k++) {
      const w = Math.min(e.lons[k - 1], e.lons[k]); const east = Math.max(e.lons[k - 1], e.lons[k]);
      const s = Math.min(e.lats[k - 1], e.lats[k]); const n = Math.max(e.lats[k - 1], e.lats[k]);
      const x0 = Math.floor(w / cell); const x1 = Math.floor(east / cell);
      const y0 = Math.floor(s / cell); const y1 = Math.floor(n / cell);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          const key = grid.key(ix, iy);
          if (seen.has(key)) continue;
          seen.add(key);
          let arr = grid.map.get(key); if (!arr) grid.map.set(key, arr = []);
          arr.push(ei);
        }
      }
    }
  });
  return grid;
}
