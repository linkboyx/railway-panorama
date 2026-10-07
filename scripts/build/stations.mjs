// 12306 车站 ↔ OSM 车站坐标匹配
import { haversine } from '../lib/geo.mjs';
import { stationNameKeysRanked, normalizeStationKey, isUrbanTransitStation } from '../lib/osm.mjs';
import { log } from '../lib/util.mjs';
import { loadRegion } from './region.mjs';

/**
 * @param stationList 12306 车站表 [{name, tele, py, abbr, city}]
 * @param osmStations [{id, lon, lat, tags}]
 * @param trains 解析后的车次（用于上下文消歧）
 * @param opts.router 径路计算器（可选）：用于排除附近没有铁路的候选、按沿线距离消歧
 * @returns stations: [{name, tele, py, abbr, city, lon, lat, flag, cands}]，flag: 1=匹配 2=推算 0=未知
 */
export function matchStations(stationList, osmStations, trains, { router = null, routingClassOf = null } = {}) {
  // 所有被车次引用到的站名都要有条目
  const stations = [];
  const byName = new Map();
  const add = (s) => { const o = { ...s, lon: null, lat: null, flag: 0, cands: [] }; byName.set(s.name, stations.length); stations.push(o); return o; };
  for (const s of stationList) if (!byName.has(s.name)) add(s);
  let extra = 0;
  for (const t of trains) for (const st of t.stops) if (!byName.has(st.name)) { add({ name: st.name, tele: '', py: '', abbr: '', city: '' }); extra++; }
  if (extra) log(`有 ${extra} 个车站不在 12306 车站表中（名称变更或境外站），已补充`);

  // OSM 候选。分块下载会带进邻国的车站：印度等国的车站代码（ref）也是三个大写字母，会和电报码撞上，
  // 因此通用的 ref 只认境内车站。境外的同名车站（韩国“长沙”、老挝“万荣”等）保留为候选，由相邻车站消歧。
  const inRegion = loadRegion();
  const osmByKey = new Map(); const osmByTele = new Map();
  let urban = 0;
  for (const o of osmStations) {
    if (isUrbanTransitStation(o.tags)) { urban++; continue; }
    o.inCN = inRegion ? inRegion(o.lon, o.lat) : true;
    for (const { key, rank } of stationNameKeysRanked(o.tags)) {
      if (!osmByKey.has(key)) osmByKey.set(key, []);
      osmByKey.get(key).push({ o, rank });
    }
    for (const tk of ['railway:ref', 'ref:crcode', 'ref:telecode', 'ref']) {
      const v = o.tags[tk];
      if (v && /^[A-Z]{3}$/.test(v) && (tk !== 'ref' || o.inCN)) { if (!osmByTele.has(v)) osmByTele.set(v, []); osmByTele.get(v).push(o); }
    }
  }
  // 候选聚类：相距 3 公里内的同名候选视为同一车站（车站常被画成站房点 + 站区面）
  const cluster = (list) => {
    const groups = [];
    for (const o of list) {
      const g = groups.find((gr) => haversine(gr.lon, gr.lat, o.lon, o.lat) < 3000);
      if (g) { g.items.push(o); g.lon = g.items.reduce((s, x) => s + x.lon, 0) / g.items.length; g.lat = g.items.reduce((s, x) => s + x.lat, 0) / g.items.length; }
      else groups.push({ lon: o.lon, lat: o.lat, items: [o] });
    }
    return groups;
  };
  let exact = 0; let ambiguous = 0; let offRail = 0; const offRailNames = [];
  for (const s of stations) {
    const key = normalizeStationKey(s.name) || s.name;
    // 只取名称优先级最高的一档（现用名 > 别名 > 旧名）
    const named = osmByKey.get(key) || [];
    const bestRank = Math.min(...named.map((c) => c.rank));
    let list = named.filter((c) => c.rank === bestRank).map((c) => c.o);
    if (s.tele && osmByTele.has(s.tele)) list = [...new Set([...osmByTele.get(s.tele), ...list])];
    if (!list.length) continue;
    let groups = cluster(list);
    if (router) {
      // 4 公里内没有铁路的候选（同名的其他设施，或新线还没画进 OSM）不用；都没有时留给后面按时刻沿线推算
      for (const g of groups) g.atts = router.attach(g.lon, g.lat).atts;
      const on = groups.filter((g) => g.atts.length);
      if (!on.length) { offRail++; if (offRailNames.length < 10) offRailNames.push(s.name); continue; }
      groups = on;
    }
    s.cands = groups;
    if (groups.length === 1) { s.lon = groups[0].lon; s.lat = groups[0].lat; s.flag = 1; exact++; }
    else ambiguous++;
  }
  // 同名多处：用车次中相邻车站消歧。有路网时比较“沿铁路到前后站的距离”（能区分相距几公里、分属高铁和普速/货运线的同名车站），
  // 否则比较直线距离
  const neighbors = new Map(); // station idx -> [idx...]（前后两站，直线法用）
  const adj = new Map();       // station idx -> Map(相邻站 idx -> {n, rc})
  for (const t of trains) {
    const rc = routingClassOf ? routingClassOf(t.cls) : 'CONV';
    for (let i = 0; i < t.stops.length; i++) {
      const a = byName.get(t.stops[i].name);
      if (!neighbors.has(a)) neighbors.set(a, []);
      for (const j of [i - 2, i - 1, i + 1, i + 2]) if (j >= 0 && j < t.stops.length) neighbors.get(a).push(byName.get(t.stops[j].name));
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= t.stops.length) continue;
        const b = byName.get(t.stops[j].name);
        if (b === a) continue;
        let m = adj.get(a); if (!m) adj.set(a, m = new Map());
        let x = m.get(b); if (!x) m.set(b, x = { n: 0, rc: {} });
        x.n++; x.rc[rc] = (x.rc[rc] || 0) + 1;
      }
    }
  }
  const attCache = new Map();
  const attOf = (i) => {
    if (!attCache.has(i)) { const p = stations[i]; attCache.set(i, { lon: p.lon, lat: p.lat, atts: router.attach(p.lon, p.lat).atts }); }
    return attCache.get(i);
  };
  const pickByRoute = (s, si) => {
    const nb = [...(adj.get(si) || [])].filter(([j]) => stations[j].flag === 1).sort((a, b) => b[1].n - a[1].n).slice(0, 6);
    if (!nb.length) return null;
    let best = null; let bestScore = Infinity;
    for (const g of s.cands) {
      let score = 0;
      for (const [j, x] of nb) {
        const P = attOf(j);
        const rc = Object.entries(x.rc).sort((a, b) => b[1] - a[1])[0][0];
        const straight = haversine(g.lon, g.lat, P.lon, P.lat);
        const r = P.atts.length ? router.route({ lon: g.lon, lat: g.lat, atts: g.atts }, P, rc) : null;
        // 沿铁路的距离；不连通或绕得太远（超出搜索范围）按直线 10 倍计
        score += (r && !r.unreachable ? r.length : straight * 10 + 50000) * x.n;
      }
      if (score < bestScore) { bestScore = score; best = g; }
    }
    return best;
  };
  const pickByDistance = (s, si) => {
    const pts = (neighbors.get(si) || []).map((i) => stations[i]).filter((x) => x.flag);
    if (!pts.length) return null;
    let best = null; let bestD = Infinity;
    for (const g of s.cands) {
      const d = pts.reduce((acc, p) => acc + Math.min(haversine(g.lon, g.lat, p.lon, p.lat), 800000), 0) / pts.length;
      if (d < bestD) { bestD = d; best = g; }
    }
    return best && bestD < 400000 ? best : null;
  };
  let resolved = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (const [si] of neighbors) {
      const s = stations[si];
      if (s.flag || s.cands.length < 2) continue;
      const best = router ? pickByRoute(s, si) : pickByDistance(s, si);
      if (best) { s.lon = best.lon; s.lat = best.lat; s.flag = 1; resolved++; }
    }
  }
  // 合理性检查：按车次时刻算出与相邻车站之间的“直线隐含速度”，中位数超过 450 km/h
  // 说明匹配到了远处的同名车站（例如 OSM 中缺失该站、却有别处的同名站），改为按时刻推算
  const obs = new Map();
  for (const t of trains) {
    for (let i = 0; i < t.stops.length - 1; i++) {
      const a = byName.get(t.stops[i].name); const b = byName.get(t.stops[i + 1].name);
      const A = stations[a]; const B = stations[b];
      if (!A.flag || !B.flag || a === b) continue;
      const hours = Math.max(1, t.stops[i + 1].arr - t.stops[i].dep) / 60;
      const kmh = haversine(A.lon, A.lat, B.lon, B.lat) / 1000 / hours;
      for (const x of [a, b]) { if (!obs.has(x)) obs.set(x, []); obs.get(x).push(kmh); }
    }
  }
  let demoted = 0;
  const demotedNames = [];
  for (const [si, v] of obs) {
    if (v.length < 2) continue;
    v.sort((x, y) => x - y);
    const med = v[v.length >> 1];
    if (med > 450) {
      const s = stations[si];
      s.flag = 0; s.lon = null; s.lat = null; demoted++;
      if (demotedNames.length < 30) demotedNames.push(s.name);
    }
  }
  if (demoted) log(`车站合理性检查：${demoted} 个车站的匹配位置与时刻明显不符，已改为推算（${demotedNames.slice(0, 10).join('、')}${demoted > 10 ? '…' : ''}）`);
  const used = new Set(trains.flatMap((t) => t.stops.map((x) => byName.get(x.name))));
  const unmatchedUsed = [...used].filter((i) => !stations[i].flag).length;
  log(`车站匹配：唯一匹配 ${exact}，同名消歧 ${resolved}/${ambiguous}，忽略地铁站 ${urban}` + (offRail ? `，附近 4 公里内没有铁路 ${offRail}（${offRailNames.join('、')}）` : '') + '；' +
    `车次用到的 ${used.size} 个车站中 ${unmatchedUsed} 个暂无坐标（稍后按运行时刻沿线推算）`);
  return { stations, byName };
}
