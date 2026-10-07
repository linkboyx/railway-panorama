#!/usr/bin/env node
/**
 * 生成演示用的“模拟世界”：一套仿 OSM 的铁路网 + 一套仿 12306 的车站/车次/时刻数据。
 * 输出 data/mock/world.json.gz，由 scripts/mock/server.mjs 以真实接口的格式对外提供，
 * 这样抓取脚本和处理管线可以原样跑通（npm run demo）。
 *
 * 说明：车站名称和大致位置取自公开数据集，线路走向按真实线路途经站串联并做平滑处理；
 * 车次号及始发终到取自历史车次表；停站、时刻、开行规律均为程序生成，并非真实时刻。
 */
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, readJSON, writeJSON, log, warn, mulberry32, hashString, parseArgs } from '../lib/util.mjs';
import { haversine, localProjector } from '../lib/geo.mjs';
import { MinHeap } from '../lib/heap.mjs';
import { LINES, LINK_CITIES_MAX_KM } from './corridors.mjs';

const args = parseArgs(process.argv.slice(2), { out: path.join(ROOT, 'data/mock/world.json.gz'), seed: '20260924' });
// 压力测试选项：--dense 把节点间距缩到约 120 米，--double 给高速/快速线路生成双线（接近真实 OSM 的数据量）
const DENSE = !!args.dense; const DOUBLE = !!args.double;
const rand = mulberry32(Number(args.seed));
const SEED_DIR = path.join(ROOT, 'scripts/mock/seed');

// ---------- 车站登记 ----------
const seedSt = readJSON(path.join(SEED_DIR, 'stations.json'));
const F = Object.fromEntries(seedSt.fields.map((f, i) => [f, i]));
const reg = new Map();
for (const r of seedSt.rows) {
  reg.set(r[F.name], {
    name: r[F.name], lon: r[F.lon], lat: r[F.lat], prov: r[F.province], city: r[F.city], bureau: r[F.bureau] || '',
    passenger: r[F.passenger], cls: r[F.class] || '', py: r[F.py] || '', abbr: r[F.abbr] || '',
  });
}
const CAPITALS = new Set('北京 天津 上海 重庆 石家庄 太原 呼和浩特 沈阳 长春 哈尔滨 南京 杭州 合肥 福州 南昌 济南 郑州 武汉 长沙 广州 南宁 海口 成都 贵阳 昆明 拉萨 西安 兰州 西宁 银川 乌鲁木齐 深圳 大连 青岛 厦门 宁波'.split(' '));
const cityOf = (st) => {
  if (['北京', '天津', '上海', '重庆'].includes(st.prov)) return st.prov;
  return String(st.city || '').replace(/(市|地区|盟)$/, '').replace(/(自治州)$/, '') || st.name;
};
const km = (a, b) => haversine(a.lon, a.lat, b.lon, b.lat) / 1000;

// ---------- 1. 解析线路 ----------
const lines = [];
const usedAsHsr = new Set();
const usedAsMain = new Set();
for (const L of LINES) {
  const pts = [];
  for (const w of L.stops.split(/\s+/)) {
    const hit = w.split('|').map((n) => reg.get(n)).find(Boolean);
    if (hit && !pts.includes(hit)) pts.push(hit);
  }
  // 去掉明显绕行的点（坐标地理编码错误）
  let changed = true;
  while (changed && pts.length > 2) {
    changed = false;
    for (let i = 1; i < pts.length - 1; i++) {
      const direct = km(pts[i - 1], pts[i + 1]);
      const via = km(pts[i - 1], pts[i]) + km(pts[i], pts[i + 1]);
      if (via > direct * 1.8 + 25) { pts.splice(i, 1); changed = true; break; }
    }
  }
  if (pts.length < 2) { warn(`线路 ${L.name} 可用车站不足，跳过`); continue; }
  const isHsr = L.kind === 'hsr' || L.kind === 'fast';
  for (const p of pts) (isHsr ? usedAsHsr : usedAsMain).add(p.name);
  lines.push({ ...L, pts });
}

// 普速线补充沿线小站
const filled = new Set();
const allSeed = [...reg.values()];
for (const L of lines) {
  if (L.kind !== 'main' && L.kind !== 'branch') continue;
  const out = [L.pts[0]];
  for (let i = 1; i < L.pts.length; i++) {
    const A = L.pts[i - 1]; const B = L.pts[i];
    const segKm = km(A, B);
    if (segKm > 25) {
      const proj = localProjector((A.lat + B.lat) / 2);
      const ax = A.lon * proj.kx; const ay = A.lat * proj.ky; const bx = B.lon * proj.kx; const by = B.lat * proj.ky;
      const dx = bx - ax; const dy = by - ay; const len2 = dx * dx + dy * dy;
      const cands = [];
      for (const s of allSeed) {
        if (!s.passenger || usedAsHsr.has(s.name) || usedAsMain.has(s.name) || filled.has(s.name)) continue;
        if (/高铁|客专|城际/.test(s.cls)) continue;
        if (Math.abs(s.lat - (A.lat + B.lat) / 2) > Math.abs(A.lat - B.lat) / 2 + 0.2) continue;
        if (Math.abs(s.lon - (A.lon + B.lon) / 2) > Math.abs(A.lon - B.lon) / 2 + 0.2) continue;
        const sx = s.lon * proj.kx; const sy = s.lat * proj.ky;
        const t = ((sx - ax) * dx + (sy - ay) * dy) / len2;
        if (t < 0.06 || t > 0.94) continue;
        const qx = ax + t * dx - sx; const qy = ay + t * dy - sy;
        const d = Math.sqrt(qx * qx + qy * qy);
        if (d < Math.min(5000, segKm * 1000 * 0.08)) cands.push({ s, t });
      }
      cands.sort((a, b) => a.t - b.t);
      let lastT = 0;
      for (const c of cands) {
        if ((c.t - lastT) * segKm < 7 || (1 - c.t) * segKm < 7) continue;
        out.push(c.s); filled.add(c.s.name); lastT = c.t;
      }
    }
    out.push(B);
  }
  L.pts = out;
}

// ---------- 2. 几何：Catmull-Rom 平滑 ----------
let nextNodeId = 1;
const nodes = new Map(); // id -> [lon, lat]
const stationNode = new Map(); // station name -> node id
function nodeForStation(st) {
  let id = stationNode.get(st.name);
  if (!id) { id = 5_000_000_000 + stationNode.size; stationNode.set(st.name, id); nodes.set(id, [st.lon, st.lat]); }
  return id;
}
const segCache = new Map(); // "A|B" -> node ids (A→B)
function catmull(p0, p1, p2, p3, spacing) {
  const proj = localProjector(p1.lat);
  const P = [p0, p1, p2, p3].map((p) => [p.lon * proj.kx, p.lat * proj.ky]);
  const tj = (ti, a, b) => ti + Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5);
  const t0 = 0; const t1 = tj(t0, P[0], P[1]); const t2 = tj(t1, P[1], P[2]); const t3 = tj(t2, P[2], P[3]);
  const segLen = Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1]);
  const n = Math.max(1, Math.ceil(segLen / spacing));
  const out = [];
  for (let k = 1; k < n; k++) {
    const t = t1 + ((t2 - t1) * k) / n;
    const A1 = lerp(P[0], P[1], (t - t0) / (t1 - t0)); const A2 = lerp(P[1], P[2], (t - t1) / (t2 - t1)); const A3 = lerp(P[2], P[3], (t - t2) / (t3 - t2));
    const B1 = lerp(A1, A2, (t - t0) / (t2 - t0)); const B2 = lerp(A2, A3, (t - t1) / (t3 - t1));
    const C = lerp(B1, B2, (t - t1) / (t2 - t1));
    out.push([C[0] / proj.kx, C[1] / proj.ky]);
  }
  return out;
}
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

const stationEdges = []; // 车站级别的图：{a, b, km, kind, speed, line}
const ways = [];
let nextWayId = 1;
const KIND_TAGS = (L) => {
  const t = { railway: 'rail', name: L.name, gauge: '1435' };
  if (L.kind === 'hsr') Object.assign(t, { highspeed: 'yes', usage: 'main', maxspeed: String(L.speed), electrified: 'contact_line', 'railway:track_ref': undefined });
  else if (L.kind === 'fast') Object.assign(t, { usage: 'main', maxspeed: String(L.speed), electrified: 'contact_line' }, L.speed >= 250 ? { highspeed: 'yes' } : {});
  else if (L.kind === 'main') Object.assign(t, { usage: 'main', maxspeed: String(L.speed), electrified: rand() < 0.7 ? 'contact_line' : 'no' });
  else Object.assign(t, { usage: 'branch', maxspeed: String(L.speed) });
  for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
  return t;
};

for (const L of lines) {
  const spacing = DENSE ? 120 : L.kind === 'hsr' || L.kind === 'fast' ? 2500 : 1500;
  const tags = KIND_TAGS(L);
  let wayNodes = [nodeForStation(L.pts[0])];
  let wayKm = 0;
  for (let i = 0; i < L.pts.length - 1; i++) {
    const A = L.pts[i]; const B = L.pts[i + 1];
    const key = `${A.name}|${B.name}`; const rkey = `${B.name}|${A.name}`;
    let segNodes;
    if (segCache.has(key)) segNodes = segCache.get(key);
    else if (segCache.has(rkey)) segNodes = [...segCache.get(rkey)].reverse();
    else {
      const p0 = L.pts[Math.max(0, i - 1)]; const p3 = L.pts[Math.min(L.pts.length - 1, i + 2)];
      const inner = catmull(p0, A, B, p3, spacing);
      segNodes = [nodeForStation(A), ...inner.map((c) => { const id = nextNodeId++; nodes.set(id, c); return id; }), nodeForStation(B)];
      segCache.set(key, segNodes);
    }
    let segKm = 0;
    for (let k = 1; k < segNodes.length; k++) {
      const p = nodes.get(segNodes[k - 1]); const q = nodes.get(segNodes[k]);
      segKm += haversine(p[0], p[1], q[0], q[1]) / 1000;
    }
    stationEdges.push({ a: A.name, b: B.name, km: segKm, kind: L.kind, speed: L.speed, line: L.name });
    if (DOUBLE && (L.kind === 'hsr' || L.kind === 'fast') && segNodes.length > 3 && !segCache.has(key + '#2')) {
      // 第二条线：向右平移约 12 米，两端接到车站节点
      segCache.set(key + '#2', true);
      const off = [];
      for (let k = 1; k < segNodes.length - 1; k++) {
        const p = nodes.get(segNodes[k - 1]); const q = nodes.get(segNodes[k + 1]); const c = nodes.get(segNodes[k]);
        const kx = Math.cos((c[1] * Math.PI) / 180);
        let dx = (q[0] - p[0]) * kx; let dy = q[1] - p[1];
        const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
        const d = 12 / 111320;
        const id = nextNodeId++; nodes.set(id, [c[0] + (dy * d) / kx, c[1] - dx * d]);
        off.push(id);
      }
      ways.push({ id: nextWayId++, nodes: [segNodes[0], ...off, segNodes[segNodes.length - 1]], tags: { ...tags, 'railway:track_ref': '2' } });
      // 渡线：约每 40 个节点连接一次上下行线
      for (let k = 20; k < off.length - 2; k += 40) {
        ways.push({ id: nextWayId++, nodes: [segNodes[k + 1], off[k + 1]], tags: { railway: 'rail', service: 'crossover' } });
      }
    }
    if (DENSE && segNodes.length > 20) {
      // 车站两端的到发线（与正线在两端相接）：制造真实数据里常见的大量短边和道岔
      for (const [a, b] of [[1, 9], [segNodes.length - 10, segNodes.length - 2]]) {
        const loop = [];
        for (let k = a + 1; k < b; k++) {
          const c = nodes.get(segNodes[k]);
          const id = nextNodeId++; nodes.set(id, [c[0] + 0.00008, c[1] + 0.00008]);
          loop.push(id);
        }
        ways.push({ id: nextWayId++, nodes: [segNodes[a], ...loop, segNodes[b]], tags: { railway: 'rail', usage: 'main' } });
      }
    }
    wayNodes.push(...segNodes.slice(1));
    wayKm += segKm;
    // 在车站处按一定概率断开成新的 way（模拟 OSM 的分段）
    if (i === L.pts.length - 2 || wayKm > 30 + rand() * 60 || rand() < 0.25) {
      ways.push({ id: nextWayId++, nodes: wayNodes, tags: { ...tags } });
      wayNodes = [segNodes[segNodes.length - 1]];
      wayKm = 0;
    }
  }
}

// 同城高速站 ↔ 普速站联络线
const netStations = new Set(stationEdges.flatMap((e) => [e.a, e.b]));
const byCity = new Map();
for (const n of netStations) {
  const st = reg.get(n); const c = cityOf(st);
  if (!byCity.has(c)) byCity.set(c, []);
  byCity.get(c).push(st);
}
let links = 0;
for (const [city, sts] of byCity) {
  const hs = sts.filter((s) => usedAsHsr.has(s.name) && !usedAsMain.has(s.name));
  const cv = sts.filter((s) => usedAsMain.has(s.name));
  for (const h of hs) {
    let best = null;
    for (const c of cv) { const d = km(h, c); if (d < LINK_CITIES_MAX_KM && (!best || d < best.d)) best = { c, d }; }
    if (!best) continue;
    const a = nodeForStation(h); const b = nodeForStation(best.c);
    const mid = [(h.lon + best.c.lon) / 2 + (rand() - 0.5) * 0.01, (h.lat + best.c.lat) / 2 + (rand() - 0.5) * 0.01];
    const mId = nextNodeId++; nodes.set(mId, mid);
    ways.push({ id: nextWayId++, nodes: [a, mId, b], tags: { railway: 'rail', usage: 'branch', maxspeed: '120', name: `${city}动车联络线` } });
    stationEdges.push({ a: h.name, b: best.c.name, km: best.d * 1.1, kind: 'link', speed: 120, line: `${city}联络线` });
    links++;
  }
}

// 干扰数据：站线/岔线（应被过滤）、废弃线、地铁
const decoyWays = [];
for (const n of [...netStations].slice(0, 400)) {
  if (rand() > 0.3) continue;
  const st = reg.get(n);
  const a = nextNodeId++; const b = nextNodeId++;
  nodes.set(a, [st.lon + 0.002, st.lat + 0.0015]); nodes.set(b, [st.lon + 0.009, st.lat + 0.004]);
  decoyWays.push({ id: nextWayId++, nodes: [a, b], tags: { railway: 'rail', service: rand() < 0.5 ? 'siding' : 'yard' } });
}
for (let i = 0; i < 40; i++) {
  const st = reg.get([...netStations][Math.floor(rand() * netStations.size)]);
  const a = nextNodeId++; const b = nextNodeId++;
  nodes.set(a, [st.lon - 0.05, st.lat - 0.02]); nodes.set(b, [st.lon + 0.06, st.lat + 0.03]);
  decoyWays.push({ id: nextWayId++, nodes: [a, b], tags: rand() < 0.5 ? { railway: 'subway', name: '地铁1号线' } : { railway: 'abandoned', name: '旧线' } });
}
ways.push(...decoyWays);

// ---------- 3. OSM 车站要素 ----------
const osmStations = [];
let osmNodeSeq = 7_000_000_000;
const missingInOsm = new Set();
for (const n of netStations) {
  const st = reg.get(n);
  if (rand() < 0.02 && !CAPITALS.has(n)) { missingInOsm.add(n); continue; }
  const ang = rand() * Math.PI * 2; const off = 40 + rand() * 120;
  const lat = st.lat + (Math.sin(ang) * off) / 111320;
  const lon = st.lon + (Math.cos(ang) * off) / (111320 * Math.cos((st.lat * Math.PI) / 180));
  const r = rand();
  const tags = { railway: 'station', train: 'yes', public_transport: 'station' };
  if (r < 0.7) Object.assign(tags, { name: `${n}站`, 'name:zh': `${n}站` });
  else if (r < 0.85) Object.assign(tags, { name: n });
  else Object.assign(tags, { name: `${n}火车站`, 'name:zh-Hans': `${n}站` });
  if (st.py) tags['name:en'] = st.py.charAt(0).toUpperCase() + st.py.slice(1) + ' Railway Station';
  if (rand() < 0.15) {
    osmStations.push({ type: 'way', id: osmNodeSeq++, center: { lat, lon }, tags });
  } else osmStations.push({ type: 'node', id: osmNodeSeq++, lat, lon, tags });
  // 同名地铁站（应被过滤）
  if (CAPITALS.has(n) && rand() < 0.8) {
    osmStations.push({ type: 'node', id: osmNodeSeq++, lat: lat + 0.004, lon: lon - 0.003, tags: { railway: 'station', station: 'subway', name: `${n}站`, subway: 'yes' } });
  }
}
// 远处的同名“乘降所”（用于测试同名车站消歧）
let dupes = 0;
for (const n of netStations) {
  if (rand() > 0.01) continue;
  const st = reg.get(n);
  osmStations.push({ type: 'node', id: osmNodeSeq++, lat: st.lat + 3 + rand(), lon: st.lon - 2 - rand(), tags: { railway: 'halt', name: `${n}站` } });
  dupes++;
}

// ---------- 4. 12306 车站表 ----------
const teleUsed = new Set();
function makeTele(st) {
  const base = (st.abbr || 'xxx').toUpperCase().replace(/[^A-Z]/g, 'X');
  const tries = [base.slice(0, 2) + 'H', base.slice(0, 3), base.slice(0, 1) + base.slice(-1) + 'Q'];
  for (const t of tries) if (t.length === 3 && !teleUsed.has(t)) { teleUsed.add(t); return t; }
  while (true) {
    const t = String.fromCharCode(65 + Math.floor(rand() * 26), 65 + Math.floor(rand() * 26), 65 + Math.floor(rand() * 26));
    if (!teleUsed.has(t)) { teleUsed.add(t); return t; }
  }
}
const railStations = [...reg.values()].map((st, i) => ({
  name: st.name, tele: makeTele(st), py: st.py, abbr: st.abbr || st.py.slice(0, 3), city: cityOf(st), idx: i,
}));

// ---------- 5. 车次 ----------
// 车站级图
const adj = new Map();
for (const e of stationEdges) {
  for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) {
    if (!adj.has(x)) adj.set(x, []);
    adj.get(x).push({ to: y, e });
  }
}
const lineCount = new Map();
for (const e of stationEdges) for (const s of [e.a, e.b]) lineCount.set(s, (lineCount.get(s) || 0) + 1);
const importance = (n) => (lineCount.get(n) || 0) + (CAPITALS.has(n) || CAPITALS.has(n.replace(/[东南西北]$/, '')) ? 3 : 0);

const MULT = {
  HS: { hsr: 1.0, fast: 1.05, main: 1.7, branch: 2.0, link: 1.3 },
  D: { hsr: 1.0, fast: 1.0, main: 1.3, branch: 1.5, link: 1.2 },
  CONV: { hsr: 3.5, fast: 1.3, main: 1.0, branch: 1.05, link: 1.2 },
};
function route(from, to, rc) {
  const dist = new Map([[from, 0]]); const prev = new Map();
  const names = []; const index = new Map();
  const id = (n) => { if (!index.has(n)) { index.set(n, names.length); names.push(n); } return index.get(n); };
  const heap = new MinHeap();
  heap.push(0, id(from));
  const done = new Set();
  while (heap.size) {
    const d = heap.peekKey(); const u = names[heap.pop()];
    if (done.has(u)) continue;
    done.add(u);
    if (u === to) break;
    for (const { to: v, e } of adj.get(u) || []) {
      const nd = d + e.km * MULT[rc][e.kind];
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, { u, e }); heap.push(nd, id(v)); }
    }
  }
  if (!done.has(to)) return null;
  const path = [to]; const edges = [];
  let cur = to;
  while (cur !== from) { const p = prev.get(cur); edges.push(p.e); path.push(p.u); cur = p.u; }
  return { stations: path.reverse(), edges: edges.reverse() };
}

const SPEED = {
  G: { hsr: (s) => Math.min(s, 350) * 0.86, fast: (s) => Math.min(s, 250) * 0.85, main: () => 140, branch: () => 100, link: () => 70 },
  D: { hsr: (s) => Math.min(s, 250) * 0.9, fast: (s) => Math.min(s, 250) * 0.85, main: () => 135, branch: () => 100, link: () => 70 },
  C: { hsr: (s) => Math.min(s, 300) * 0.78, fast: (s) => Math.min(s, 200) * 0.8, main: () => 120, branch: () => 90, link: () => 60 },
  Z: { hsr: () => 150, fast: () => 150, main: (s) => Math.min(s, 160) * 0.8, branch: () => 90, link: () => 60 },
  T: { hsr: () => 140, fast: () => 140, main: (s) => Math.min(s, 140) * 0.8, branch: () => 85, link: () => 55 },
  K: { hsr: () => 120, fast: () => 120, main: (s) => Math.min(s, 120) * 0.8, branch: () => 75, link: () => 50 },
  O: { hsr: () => 90, fast: () => 90, main: () => 65, branch: () => 55, link: () => 40 },
};
const CLASS_NAME = { G: '高速', D: '动车', C: '城际', Z: '直达特快', T: '特快', K: '快速', O: '普快', S: '市郊', Y: '旅游', L: '临客' };
const classOf = (code) => { const c = code[0]; return 'GDCZTKSYL'.includes(c) ? c : 'O'; };
const hhmm = (m) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

const seedTrains = readJSON(path.join(SEED_DIR, 'trains.json')).rows;
const trains = [];
const noUsed = new Set();
let skipped = 0;
function netStation(name) {
  if (netStations.has(name)) return name;
  const st = reg.get(name);
  if (!st) return null;
  // 同城替代
  const alts = (byCity.get(cityOf(st)) || []).filter((s) => netStations.has(s.name));
  if (!alts.length) return null;
  alts.sort((a, b) => km(a, st) - km(b, st));
  return km(alts[0], st) < 40 ? alts[0].name : null;
}
function makeNo(code, bureau, variant) {
  const bb = String(10 + (hashString(bureau || 'x') % 80)).padStart(2, '0');
  const body = code.padStart(8, '0');
  const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let h = hashString(code + '#' + variant);
  let no;
  do { no = bb + body + chars[h % chars.length] + chars[(h >>> 8) % chars.length]; h = (h * 31 + 7) >>> 0; } while (noUsed.has(no));
  noUsed.add(no);
  return no;
}

for (const [code, fromRaw, toRaw] of seedTrains) {
  const cls = classOf(code);
  const from = netStation(fromRaw); const to = netStation(toRaw);
  if (!from || !to || from === to) { skipped++; continue; }
  const rc = cls === 'G' || cls === 'C' ? 'HS' : cls === 'D' ? 'D' : 'CONV';
  const r = route(from, to, rc);
  if (!r || r.stations.length < 2) { skipped++; continue; }
  const h = hashString(code);
  const rr = mulberry32(h);
  const totalKm = r.edges.reduce((s, e) => s + e.km, 0);
  // 停站选择
  const sp = cls === 'G' ? 0.3 : cls === 'D' ? 0.5 : cls === 'C' ? 1 : cls === 'Z' ? 0.08 : cls === 'T' ? 0.2 : cls === 'K' ? 0.45 : 0.95;
  const stopIdx = [0];
  let sinceKm = 0;
  for (let i = 1; i < r.stations.length - 1; i++) {
    sinceKm += r.edges[i - 1].km;
    const imp = importance(r.stations[i]);
    const major = imp >= 4;
    let p = major ? Math.max(sp, cls === 'Z' ? 0.45 : 0.85) : sp;
    if (sinceKm > (cls === 'Z' ? 600 : cls === 'G' ? 220 : 160)) p = Math.max(p, 0.8);
    if (sinceKm < 12 && cls !== 'C' && cls !== 'O') p *= 0.2;
    if (rr() < p) { stopIdx.push(i); sinceKm = 0; }
  }
  stopIdx.push(r.stations.length - 1);
  const speedTab = SPEED[cls] || SPEED[cls === 'S' || cls === 'Y' || cls === 'L' ? 'O' : 'K'] || SPEED.K;
  // 始发时刻
  let dep0;
  const x = rr();
  if ('GDC'.includes(cls)) dep0 = 360 + Math.floor(x * 870);
  else if (cls === 'Z') dep0 = 960 + Math.floor(x * 420);
  else if ('TK'.includes(cls)) dep0 = totalKm > 1000 && rr() < 0.6 ? 900 + Math.floor(x * 510) : Math.floor(x * 1440);
  else dep0 = 330 + Math.floor(x * 960);
  const stops = [];
  let t = dep0;
  for (let k = 0; k < stopIdx.length; k++) {
    const i = stopIdx[k];
    const name = r.stations[i];
    if (k === 0) { stops.push({ name, arr: t, dep: t }); continue; }
    let secMin = 0;
    for (let j = stopIdx[k - 1]; j < i; j++) {
      const e = r.edges[j];
      secMin += (e.km / (speedTab[e.kind] ? speedTab[e.kind](e.speed) : 80)) * 60;
    }
    secMin += 'GDC'.includes(cls) ? 3 : 2;
    t += Math.max(2, Math.round(secMin));
    const arr = t;
    let dwell = 0;
    if (k < stopIdx.length - 1) {
      const imp = importance(name);
      if ('GDC'.includes(cls)) dwell = imp >= 5 ? 4 + Math.floor(rr() * 5) : 2 + (rr() < 0.3 ? 1 : 0);
      else if ('ZTK'.includes(cls)) dwell = imp >= 5 ? 8 + Math.floor(rr() * 12) : 2 + Math.floor(rr() * 5);
      else dwell = 1 + Math.floor(rr() * 3);
    }
    t += dwell;
    stops.push({ name, arr, dep: t });
  }
  // 开行规律
  const p = mulberry32(h ^ 0x9e3779b9)();
  const days = p < 0.86 ? 'daily' : p < 0.92 ? 'weekend' : p < 0.95 ? 'odd' : p < 0.97 ? 'even' : 'mf';
  // 跨局换号（套跑）
  let codes = [code];
  const m = code.match(/^([ZTK]?)(\d+)$/);
  let changeAt = -1;
  if (m && totalKm > 600 && stops.length > 4 && rr() < 0.3) {
    const num = Number(m[2]);
    const paired = m[1] + (num % 2 ? num + 1 : num - 1);
    codes = [code, paired];
    changeAt = 1 + Math.floor(rr() * (stops.length - 2));
  }
  stops.forEach((s, i) => { s.code = changeAt >= 0 && i >= changeAt ? codes[1] : codes[0]; });
  const bureau = reg.get(from)?.bureau;
  const base = { code, codes, cls, className: CLASS_NAME[cls] || '普客', from, to, days, stops, no: makeNo(code, bureau, 0) };
  // 少量车次周末换一套时刻（不同 train_no）
  if ('GD'.includes(cls) && days === 'daily' && rr() < 0.04) {
    base.days = 'mf';
    const shift = 10 + Math.floor(rr() * 25);
    trains.push(base);
    trains.push({ ...base, days: 'ss', no: makeNo(code, bureau, 1), stops: stops.map((s) => ({ ...s, arr: s.arr + shift, dep: s.dep + shift })) });
  } else trains.push(base);
}

// ---------- 6. 输出 ----------
const world = {
  generatedAt: new Date().toISOString(),
  osm: {
    nodes: [...nodes.entries()].map(([id, [lon, lat]]) => [id, Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7]),
    ways,
    stations: osmStations,
  },
  rail: { stations: railStations, trains },
};
writeJSON(args.out, world);
const byClass = {};
for (const t of trains) byClass[t.cls] = (byClass[t.cls] || 0) + 1;
log(`模拟世界已生成：${path.relative(ROOT, args.out)}`);
log(`  线路 ${lines.length} 条，路网车站 ${netStations.size} 个，联络线 ${links} 条，OSM 节点 ${nodes.size}，way ${ways.length}`);
log(`  OSM 车站要素 ${osmStations.length}（缺失 ${missingInOsm.size}，远处同名 ${dupes}）`);
log(`  12306 车站 ${railStations.length}，车次 ${trains.length}（跳过 ${skipped}）：${JSON.stringify(byClass)}`);
