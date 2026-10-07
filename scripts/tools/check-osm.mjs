#!/usr/bin/env node
/**
 * 检查已下载的 OSM 铁路数据：路网规模、各等级线路里程、连通性，
 * 以及几条主要干线沿路网算出的径路长度与官方里程的对比。
 * 不需要 12306 数据，可以在 fetch:osm 完成后、fetch:12306 运行期间使用。
 *
 *   node scripts/tools/check-osm.mjs              # 读取 data/raw/osm
 *   node scripts/tools/check-osm.mjs --raw data/raw-demo
 */
import path from 'node:path';
import { parseArgs, ROOT, log } from '../lib/util.mjs';
import { loadOsm, buildGraph, buildEdgeIndex } from '../build/osm-graph.mjs';
import { Router, forEachEdgeOnPath } from '../build/router.mjs';
import { EDGE_CLASSES } from '../lib/osm.mjs';
import { loadRegion, edgeInRegion } from '../build/region.mjs';

const args = parseArgs(process.argv.slice(2), { raw: path.join(ROOT, 'data/raw'), top: '30' });
const mem = () => `${Math.round(process.memoryUsage().rss / 1048576)} MB`;
const CLS = EDGE_CLASSES.map((c) => c.name.replace(/铁路|\/.*$/g, ''));

// 主要车站的大致坐标（经度, 纬度）
const ST = {
  北京南: [116.3786, 39.8652], 北京西: [116.3214, 39.8949], 北京: [116.4270, 39.9029], 天津: [117.2105, 39.1360],
  上海虹桥: [121.3200, 31.1945], 上海: [121.4555, 31.2497], 南京南: [118.7973, 31.9687], 杭州东: [120.2130, 30.2910],
  武汉: [114.4247, 30.6073], 长沙南: [113.0648, 28.1497], 广州南: [113.2690, 22.9885], 广州: [113.2574, 23.1490],
  深圳北: [114.0293, 22.6097], 香港西九龙: [114.1651, 22.3043], 郑州东: [113.7772, 34.7580], 西安北: [108.9393, 34.3778],
  成都东: [104.1418, 30.6300], 重庆北: [106.5500, 29.6090], 贵阳北: [106.6720, 26.6180], 昆明南: [102.8700, 24.8790],
  哈尔滨西: [126.5830, 45.7080], 哈尔滨: [126.6310, 45.7620], 沈阳北: [123.4370, 41.8170], 大连北: [121.6050, 38.9940],
  兰州西: [103.7630, 36.0690], 西宁: [101.8000, 36.6300], 拉萨: [91.0660, 29.6290],
};
// [起, 止, 列车类型（HS 高速动车 / CONV 普速）, 官方里程 km（null：只检查连通和线路等级）]
const TESTS = [
  ['北京南', '上海虹桥', 'HS', 1318], ['北京南', '天津', 'HS', 120], ['南京南', '上海虹桥', 'HS', 295],
  ['北京西', '武汉', 'HS', 1229], ['武汉', '广州南', 'HS', 1069], ['广州南', '深圳北', 'HS', 102],
  ['深圳北', '香港西九龙', 'HS', null], ['上海虹桥', '杭州东', 'HS', 159], ['上海虹桥', '昆明南', 'HS', 2252],
  ['哈尔滨西', '大连北', 'HS', 921], ['郑州东', '西安北', 'HS', null], ['西安北', '成都东', 'HS', null],
  ['成都东', '重庆北', 'HS', null], ['长沙南', '贵阳北', 'HS', null], ['兰州西', '西宁', 'HS', null],
  ['北京', '上海', 'CONV', 1463], ['北京', '哈尔滨', 'CONV', 1249], ['北京西', '广州', 'CONV', null],
  ['西宁', '拉萨', 'CONV', 1956],
];

const t0 = Date.now();
const osm = loadOsm(path.join(path.resolve(args.raw), 'osm'));
log(`读取完成，内存 ${mem()}`);
const graph = buildGraph(osm);
const { edges, names } = graph;
const router = new Router(graph, buildEdgeIndex(edges));
log(`路网构建完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，内存 ${mem()}`);

// ---------- 连通分量 ----------
const comp = router.components();
const comps = new Map();
edges.forEach((e) => {
  const r = comp[e.v0];
  let c = comps.get(r);
  if (!c) comps.set(r, c = { len: 0, n: 0, w: 180, s: 90, e: -180, n2: -90, names: new Map() });
  c.len += e.len; c.n++;
  for (const k of [0, e.lons.length - 1]) {
    c.w = Math.min(c.w, e.lons[k]); c.e = Math.max(c.e, e.lons[k]); c.s = Math.min(c.s, e.lats[k]); c.n2 = Math.max(c.n2, e.lats[k]);
  }
  if (e.name) c.names.set(e.name, (c.names.get(e.name) || 0) + e.len);
});
const total = edges.reduce((s, e) => s + e.len, 0);
const sorted = [...comps.values()].sort((a, b) => b.len - a.len);
console.log(`\n== 连通性：${sorted.length} 个连通分量，最大的占总里程 ${((sorted[0].len / total) * 100).toFixed(1)}%`);
for (const c of sorted.slice(0, 10)) {
  const top = [...c.names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => names[x[0]]).join('、');
  console.log(`  ${(c.len / 1000).toFixed(0).padStart(7)} km  ${String(c.n).padStart(6)} 条边  范围 ${c.w.toFixed(1)}–${c.e.toFixed(1)}E ${c.s.toFixed(1)}–${c.n2.toFixed(1)}N  ${top || '（无名称）'}`);
}
const small = sorted.filter((c) => c.len < 5000);
console.log(`  其中小于 5 km 的碎片 ${small.length} 个，共 ${(small.reduce((s, c) => s + c.len, 0) / 1000).toFixed(0)} km`);

// ---------- 境外线路 ----------
const inRegion = loadRegion();
if (inRegion) {
  const out = new Map(); let outLen = 0;
  edges.forEach((e) => { if (!edgeInRegion(inRegion, e)) { outLen += e.len; out.set(e.name, (out.get(e.name) || 0) + e.len); } });
  const top = [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([ni, L]) => `${names[ni] || '（无名称）'} ${(L / 1000).toFixed(0)}`).join('、');
  console.log(`\n== 境外线路（网站上不画，除非有车次经过）：${(outLen / 1000).toFixed(0)} km；按名称（km）：${top}`);
}

// ---------- 线路等级 ----------
const byName = new Map();
edges.forEach((e) => {
  let r = byName.get(e.name);
  if (!r) byName.set(e.name, r = { len: 0, cls: new Float64Array(EDGE_CLASSES.length) });
  r.len += e.len; r.cls[e.cls] += e.len;
});
const fmtCls = (arr, sum) => [...arr].map((v, i) => [i, v]).filter((x) => x[1] / sum >= 0.02).sort((a, b) => b[1] - a[1])
  .map(([i, v]) => `${CLS[i]} ${Math.round((v / sum) * 100)}%`).join(' ');
console.log(`\n== 最长的 ${args.top} 条线路（按名称）及其等级构成`);
for (const [ni, r] of [...byName.entries()].filter((x) => x[0] !== 0).sort((a, b) => b[1].len - a[1].len).slice(0, Number(args.top))) {
  console.log(`  ${(r.len / 1000).toFixed(0).padStart(6)} km  ${names[ni].padEnd(14, '　')} ${fmtCls(r.cls, r.len)}`);
}
const unnamed = byName.get(0);
if (unnamed) console.log(`  ${(unnamed.len / 1000).toFixed(0).padStart(6)} km  （无名称）        ${fmtCls(unnamed.cls, unnamed.len)}`);
const hsNamed = [...byName.entries()].filter(([ni]) => /高速|客运专线|客专/.test(names[ni]));
const hsLen = hsNamed.reduce((s, x) => s + x[1].len, 0);
const hsCls = new Float64Array(EDGE_CLASSES.length);
for (const [, r] of hsNamed) r.cls.forEach((v, i) => { hsCls[i] += v; });
if (hsLen) console.log(`  名称含“高速/客专”的线路共 ${(hsLen / 1000).toFixed(0)} km：${fmtCls(hsCls, hsLen)}`);

// ---------- 主要干线径路 ----------
console.log('\n== 主要干线径路（沿路网计算） vs 官方里程');
let bad = 0;
for (const [a, b, rc, ref] of TESTS) {
  const A = { lon: ST[a][0], lat: ST[a][1], ...router.attach(...ST[a]) };
  const B = { lon: ST[b][0], lat: ST[b][1], ...router.attach(...ST[b]) };
  const head = `  ${a} → ${b}（${rc === 'HS' ? '高速' : '普速'}）`;
  if (!A.atts.length || !B.atts.length) { console.log(`${head}：${!A.atts.length ? a : b} 附近 4 公里内没有铁路`); bad++; continue; }
  const t = Date.now();
  const r = router.route(A, B, rc);
  if (!r || r.unreachable) { console.log(`${head}：${r?.unreachable ? '不连通' : '找不到径路'}`); bad++; continue; }
  const cls = new Float64Array(EDGE_CLASSES.length);
  forEachEdgeOnPath(r.path, router.len, (e, L) => { cls[router.cls[e]] += L; });
  const km = r.length / 1000;
  const dev = ref ? ((km - ref) / ref) * 100 : null;
  if (dev !== null && Math.abs(dev) > 5) bad++;
  console.log(`${head}：${km.toFixed(0)} km${ref ? `，官方 ${ref} km（${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%）` : ''}｜${fmtCls(cls, r.length)}｜${Date.now() - t} ms`);
}
console.log(`\n完成，总用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，内存峰值约 ${mem()}${bad ? `；${bad} 条径路异常（偏差 >5% 或不连通）` : ''}`);
