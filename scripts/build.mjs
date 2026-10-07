#!/usr/bin/env node
/**
 * 数据处理：OSM 铁路线 + 12306 时刻 → 网站数据（web/data/）
 *
 *   node scripts/build.mjs                         # 读取 data/raw，输出到 web/data
 *   node scripts/build.mjs --raw data/raw-demo --source demo
 *
 * 主要步骤：
 *   1. 构建铁路拓扑图（道岔处断开、合并碎片、简化几何）
 *   2. 12306 车站按名称匹配 OSM 车站坐标（同名多处用相邻车站消歧）
 *   3. 每个相邻停站区间沿铁路网计算径路（高速/普速列车偏好不同等级的线路）
 *   4. OSM 中缺失的车站按运行时刻沿径路推算位置
 *   5. 输出紧凑的 JSON 数据和一份构建报告
 */
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs, ROOT, writeJSON, log, warn, readJSON, exists } from './lib/util.mjs';
import { loadOsm, buildGraph, buildEdgeIndex } from './build/osm-graph.mjs';
import { loadRail } from './build/timetables.mjs';
import { matchStations } from './build/stations.mjs';
import { Router, routingClassOf, pathLength, pointOnPath, forEachEdgeOnPath, pathPolyline } from './build/router.mjs';
import { haversine, nearestOnPolyline } from './lib/geo.mjs';
import { loadRegion, edgeInRegion } from './build/region.mjs';
import { EDGE_CLASSES } from './lib/osm.mjs';

const args = parseArgs(process.argv.slice(2), {
  raw: path.join(ROOT, 'data/raw'),
  out: path.join(ROOT, 'web/data'),
  source: 'real',
  report: '',
  maxDates: '15',
  dateStart: '',
  dateEnd: '',
});
const RAW = path.resolve(args.raw);
const OUT = path.resolve(args.out);
const Q = 1e5;
const qi = (v) => Math.round(v * Q);

function main() {
  const t0 = Date.now();
  // ---------- 1. 路网 ----------
  const osm = loadOsm(path.join(RAW, 'osm'));
  const graph = buildGraph(osm);
  const { edges } = graph;
  const edgeIndex = buildEdgeIndex(edges);
  const router = new Router(graph, edgeIndex);

  // ---------- 2. 时刻与车站 ----------
  const rail = loadRail(path.join(RAW, '12306'), { maxDates: Number(args.maxDates), dateStart: args.dateStart, dateEnd: args.dateEnd });
  const { trains, dates } = rail;
  const { stations, byName } = matchStations(rail.stationList, osm.stations, trains, { router, routingClassOf });

  // ---------- 3. 径路 ----------
  const attCache = new Map();
  const attOf = (si) => {
    if (!attCache.has(si)) {
      const s = stations[si];
      const { atts, radius } = router.attach(s.lon, s.lat);
      attCache.set(si, { lon: s.lon, lat: s.lat, atts, radius });
    }
    return attCache.get(si);
  };
  const segs = []; const segLen = []; const segEnds = [];
  const segMap = new Map();
  const stats = { routed: 0, straight: 0, reused: 0, switched: 0, suspicious: [], implausible: [], expanded: 0, farAttach: 0, disconnected: 0, disconnectedPairs: [] };
  const lenArr = router.len;
  const MAX_KMH = { G: 350, C: 300, D: 300, S: 250, Z: 180, T: 180, K: 160, Y: 160 };
  function getSeg(sa, sb, rc, minutes = 0, cls = 'K') {
    const key = `${sa}|${sb}|${rc}`;
    if (segMap.has(key)) return segMap.get(key);
    const rkey = `${sb}|${sa}|${rc}`;
    if (segMap.has(rkey)) { const r = -segMap.get(rkey); segMap.set(key, r); stats.reused++; return r; }
    const A = attOf(sa); const B = attOf(sb);
    const straight = haversine(A.lon, A.lat, B.lon, B.lat);
    // 绕远且按时刻算下来比该类列车最高速度还快：这条径路不可能是实际走的
    const vmax = (MAX_KMH[cls] || 140) * 1000;
    const implausible = (len) => minutes > 0 && len > straight * 1.8 + 10000 && len / (minutes / 60) > vmax;
    let path = null; let L = 0;
    if (A.atts.length && B.atts.length) {
      const maxLength = Math.min(3000e3, (minutes / 60) * vmax * 1.15);
      // 先按本车次类型的线路偏好；若绕远到按时刻跑不完（例如普速车实际走的是客专），再换成动车、高铁、普速的偏好各试一次
      let far = null;
      for (const prof of [rc, ...['D', 'HS', 'CONV'].filter((x) => x !== rc)]) {
        const r = router.route(A, B, prof, { maxLength });
        if (r?.unreachable) {
          stats.disconnected++;
          if (stats.disconnectedPairs.length < 200) stats.disconnectedPairs.push({ from: stations[sa].name, to: stations[sb].name });
          break;
        }
        if (!r) continue;
        stats.expanded += r.expanded;
        if (!implausible(r.length)) { path = r.path; L = r.length; if (prof !== rc) stats.switched++; break; }
        if (!far || r.length < far.length) far = r;
      }
      // 都不合理：多半是 OSM 缺了某段连接线，改用直线（比沿远路“飞驰”更接近实际）
      if (!path && far && stats.implausible.length < 200) {
        stats.implausible.push({ from: stations[sa].name, to: stations[sb].name, km: +(far.length / 1000).toFixed(1), straightKm: +(straight / 1000).toFixed(1), minutes, cls });
      }
    }
    if (path && L > straight * 2.2 + 15000) {
      stats.suspicious.push({ from: stations[sa].name, to: stations[sb].name, km: +(L / 1000).toFixed(1), straightKm: +(straight / 1000).toFixed(1) });
    }
    if (!path) { path = [-1, sa, sb]; L = straight; stats.straight++; } else stats.routed++;
    segs.push(path); segLen.push(L); segEnds.push([sa, sb]);
    const ref = segs.length;
    segMap.set(key, ref);
    return ref;
  }
  const refLen = (ref) => segLen[Math.abs(ref) - 1];
  function pointOnRef(ref, d) {
    const i = Math.abs(ref) - 1; const p = segs[i]; const L = segLen[i];
    const dd = ref > 0 ? d : L - d;
    if (p[0] === -1) {
      const a = stations[p[1]]; const b = stations[p[2]]; const f = L ? dd / L : 0;
      return [a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f];
    }
    return pointOnPath(p, edges, dd);
  }

  // 第一遍：计算锚点之间的径路，并按时刻比例收集缺失车站的推算位置
  const estimates = new Map();
  const plans = [];
  let drawable = 0;
  const tRoute = Date.now();
  trains.forEach((t, ti) => {
    const rc = routingClassOf(t.cls);
    const idx = t.stops.map((s) => byName.get(s.name));
    const anchors = [];
    idx.forEach((si, k) => { if (stations[si].flag === 1 && (!anchors.length || idx[anchors[anchors.length - 1]] !== si)) anchors.push(k); });
    const refs = [];
    if (anchors.length >= 2) {
      drawable++;
      for (let a = 0; a < anchors.length - 1; a++) {
        const ka = anchors[a]; const kb = anchors[a + 1];
        const ref = getSeg(idx[ka], idx[kb], rc, t.stops[kb].arr - t.stops[ka].dep, t.cls);
        refs.push(ref);
        const L = refLen(ref);
        for (let k = ka + 1; k < kb; k++) {
          const p = pointOnRef(ref, timeFraction(t, ka, kb, k) * L);
          if (p) { if (!estimates.has(idx[k])) estimates.set(idx[k], []); estimates.get(idx[k]).push(p); }
        }
      }
    }
    plans.push({ idx, anchors, refs });
    if ((ti + 1) % 2000 === 0) log(`  径路计算：${ti + 1}/${trains.length} 车次，区间 ${segs.length}`);
  });
  log(`径路：区间 ${segs.length}（沿线 ${stats.routed}，直线兜底 ${stats.straight}，反向复用 ${stats.reused}）` +
    `，可显示车次 ${drawable}/${trains.length}，耗时 ${((Date.now() - tRoute) / 1000).toFixed(1)} 秒` +
    (stats.disconnected ? `；其中 ${stats.disconnected} 个区间两站之间路网不连通（见构建报告）` : '') +
    (stats.switched ? `；${stats.switched} 个区间按其他车型的线路偏好重算（如普速车走客专）` : '') +
    (stats.implausible.length ? `；${stats.implausible.length} 个区间沿路网绕行过远、与时刻不符，改为直线` : ''));

  // ---------- 4. 推算缺失车站位置（取各车次推算值的中位数） ----------
  let estimated = 0;
  for (const [si, pts] of estimates) {
    const s = stations[si];
    if (s.flag) continue;
    s.lon = median(pts.map((p) => p[0])); s.lat = median(pts.map((p) => p[1])); s.flag = 2; estimated++;
  }

  // 第二遍：计算每个停站的里程；推算车站优先投影到本车次径路上，保证与车站标记一致
  const polyCache = new Map();
  const polyOf = (ref) => {
    const i = Math.abs(ref) - 1;
    if (!polyCache.has(i)) {
      const p = segs[i];
      polyCache.set(i, p[0] === -1 ? null : pathPolyline(p, edges));
      if (polyCache.size > 20000) polyCache.delete(polyCache.keys().next().value);
    }
    return polyCache.get(i);
  };
  const trainRows = [];
  const traffic = new Float64Array(edges.length);
  const rank = new Float64Array(stations.length);
  trains.forEach((t, ti) => {
    const { idx, anchors, refs } = plans[ti];
    const weight = t.dates.length / dates.length;
    for (const si of idx) rank[si] += weight;
    const dist = new Array(idx.length).fill(-1);
    const segAt = new Array(idx.length).fill(0);
    if (anchors.length >= 2) {
      let d = 0;
      dist[anchors[0]] = 0;
      for (let a = 0; a < anchors.length - 1; a++) {
        const ka = anchors[a]; const kb = anchors[a + 1]; const ref = refs[a];
        const L = refLen(ref);
        segAt[ka] = ref;
        let prevOff = 0;
        for (let k = ka + 1; k < kb; k++) {
          let off = timeFraction(t, ka, kb, k) * L;
          const s = stations[idx[k]];
          const pl = s.flag === 2 ? polyOf(ref) : null;
          if (pl) {
            const nr = nearestOnPolyline(s.lon, s.lat, pl.lons, pl.lats, pl.cum);
            if (nr.dist < 8000) off = ref > 0 ? nr.offset * (L / (pl.cum[pl.cum.length - 1] || L)) : L - nr.offset * (L / (pl.cum[pl.cum.length - 1] || L));
          }
          off = Math.min(L * 0.99, Math.max(prevOff + 1, off));
          prevOff = off;
          dist[k] = d + off;
        }
        d += L;
        dist[kb] = d;
        const i = Math.abs(ref) - 1;
        if (segs[i][0] !== -1) forEachEdgeOnPath(segs[i], lenArr, (e) => { traffic[e] += weight; });
      }
    }
    const flat = [];
    t.stops.forEach((s, k) => flat.push(idx[k], s.arr, s.dep, dist[k] < 0 ? -1 : Math.round(dist[k] / 10), segAt[k]));
    trainRows.push([t.no, t.code, t.codes.length > 1 ? t.codes.join('/') : '', t.cls, t.dates.map((dd) => dates.indexOf(dd)), flat]);
  });
  const unresolved = [];
  const usedStations = new Set();
  for (const r of trainRows) for (let k = 0; k < r[5].length; k += 5) usedStations.add(r[5][k]);
  for (const si of usedStations) if (!stations[si].flag) unresolved.push({ name: stations[si].name, trainsPerDay: +rank[si].toFixed(1) });
  unresolved.sort((a, b) => b.trainsPerDay - a.trainsPerDay);
  log(`车站：推算位置 ${estimated} 个，仍无法定位 ${unresolved.length} 个`);

  // ---------- 5. 输出 ----------
  fs.mkdirSync(OUT, { recursive: true });
  // 只输出中国境内（含港澳台）的线路和有车次经过的线路；下载分块时顺带下来的邻国铁路不画
  const inRegion = loadRegion();
  const usedEdge = new Uint8Array(edges.length);
  for (const p of segs) if (p[0] !== -1) forEachEdgeOnPath(p, lenArr, (e) => { usedEdge[e] = 1; });
  const newEdge = new Int32Array(edges.length).fill(-1);
  const kept = [];
  edges.forEach((e, i) => {
    if (usedEdge[i] || !inRegion || edgeInRegion(inRegion, e)) { newEdge[i] = kept.length; kept.push(i); }
  });
  for (const p of segs) if (p[0] !== -1) for (let k = 2; k < p.length; k++) p[k] = Math.sign(p[k]) * (newEdge[Math.abs(p[k]) - 1] + 1);
  if (kept.length < edges.length) log(`线路：输出 ${kept.length} 条边，境外且没有车次经过的 ${edges.length - kept.length} 条不输出`);
  let W = 180; let S = 90; let E = -180; let N = -90;
  const edgeRows = kept.map((i) => {
    const e = edges[i];
    const row = [e.cls, e.name, Math.round(traffic[i])];
    let px = 0; let py = 0;
    for (let k = 0; k < e.lons.length; k++) {
      const x = qi(e.lons[k]); const y = qi(e.lats[k]);
      row.push(x - px, y - py); px = x; py = y;
      if (e.lons[k] < W) W = e.lons[k]; if (e.lons[k] > E) E = e.lons[k];
      if (e.lats[k] < S) S = e.lats[k]; if (e.lats[k] > N) N = e.lats[k];
    }
    return row;
  });
  writeJSON(path.join(OUT, 'network.json'), { q: Q, names: graph.names, edges: edgeRows });
  // 只输出被车次用到或已定位的车站
  const keep = stations.map((s, i) => usedStations.has(i));
  const newIdx = new Int32Array(stations.length).fill(-1);
  const stRows = [];
  stations.forEach((s, i) => {
    if (!keep[i]) return;
    newIdx[i] = stRows.length;
    stRows.push([s.name, s.tele || '', s.py || '', s.abbr || '', s.city || '', s.flag ? qi(s.lon) : null, s.flag ? qi(s.lat) : null, s.flag, Math.round(rank[i])]);
  });
  for (const r of trainRows) for (let k = 0; k < r[5].length; k += 5) r[5][k] = newIdx[r[5][k]];
  for (const p of segs) if (p[0] === -1) { p[1] = newIdx[p[1]]; p[2] = newIdx[p[2]]; }
  writeJSON(path.join(OUT, 'stations.json'), { fields: ['name', 'tele', 'py', 'abbr', 'city', 'x', 'y', 'flag', 'rank'], rows: stRows });
  writeJSON(path.join(OUT, 'trains.json'), { fields: ['no', 'code', 'codes', 'cls', 'days', 'stops'], stopFields: ['station', 'arr', 'dep', 'dist10m', 'seg'], rows: trainRows });
  writeJSON(path.join(OUT, 'paths.json'), { enc: 'delta1', segs: segs.map(encodePath) });
  const meta = {
    version: 1,
    source: args.source,
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    dates,
    osmBase: osm.osmBase,
    bbox: [W, S, E, N].map((v) => +v.toFixed(3)),
    edgeClasses: EDGE_CLASSES,
    counts: { trains: trains.length, drawable, stations: stRows.length, edges: kept.length, segments: segs.length },
  };
  writeJSON(path.join(OUT, 'meta.json'), meta, { pretty: true });
  const sizes = ['meta', 'network', 'stations', 'trains', 'paths'].map((n) => `${n}.json ${(fs.statSync(path.join(OUT, n + '.json')).size / 1048576).toFixed(2)}MB`);
  log(`输出 ${path.relative(ROOT, OUT) || OUT}：${sizes.join('，')}`);

  // ---------- 报告 ----------
  const report = {
    generatedAt: meta.generatedAt,
    source: args.source,
    dates,
    counts: meta.counts,
    stations: {
      matchedExact: stations.filter((s) => s.flag === 1).length,
      estimated,
      unresolved: unresolved.length,
      unresolvedTop: unresolved.slice(0, 100),
    },
    segments: {
      total: segs.length, routed: stats.routed, straightFallback: stats.straight,
      disconnected: stats.disconnected, disconnectedPairs: stats.disconnectedPairs,
      implausible: stats.implausible,
      suspicious: stats.suspicious.slice(0, 200),
    },
    timetableWarnings: rail.warnings.slice(0, 200),
  };
  const reportFile = args.report || path.join(RAW, '..', 'build-report.json');
  writeJSON(reportFile, report, { pretty: true });
  log(`构建报告：${path.relative(ROOT, reportFile)}（可疑区间 ${stats.suspicious.length} 个，未定位车站 ${unresolved.length} 个）`);
  if (unresolved.length) log(`  未定位车站（按日均车次）：${unresolved.slice(0, 12).map((u) => `${u.name}(${u.trainsPerDay})`).join('、')}`);
  log(`全部完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒。运行 npm start 打开网站。`);
}

/**
 * 径路压缩编码（约为原来的 1/3）：[oA, oB, e1, v2, v3, …]
 * e1 为带方向的边编号（1 起，负数表示逆向）；之后每条边 v = zigzag(|e|-|e_prev|)*2 + (逆向?1:0)
 * 直线兜底 [-1, 站A, 站B] 保持不变。
 */
function encodePath(p) {
  if (p[0] === -1) return p;
  const out = [p[0], p[1], p[2]];
  for (let i = 3; i < p.length; i++) {
    const d = Math.abs(p[i]) - Math.abs(p[i - 1]);
    const z = d >= 0 ? 2 * d : -2 * d - 1;
    out.push(z * 2 + (p[i] < 0 ? 1 : 0));
  }
  return out;
}

function timeFraction(t, ka, kb, k) {
  const t0m = t.stops[ka].dep; const t1m = t.stops[kb].arr;
  const f = t1m > t0m ? (t.stops[k].arr - t0m) / (t1m - t0m) : (k - ka) / (kb - ka);
  return Math.min(0.98, Math.max(0.02, f));
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

try { main(); } catch (e) { console.error('\n构建失败：', e.message); console.error(e.stack); process.exit(1); }
