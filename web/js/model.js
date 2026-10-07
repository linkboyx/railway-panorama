// 核心模型：解码数据、时间换算（北京时间）、列车在某一时刻的位置
// 纯逻辑模块，不依赖 DOM，可在 Node 中测试。

export const TZ = 8 * 3600e3; // 北京时间 UTC+8
export const DAY = 86400e3;
const R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * RAD; const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function bearing(lon1, lat1, lon2, lat2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

// ---------------- 日期 ----------------
export const dayNumOf = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); };
export const dateOfDayNum = (n) => new Date(n * DAY).toISOString().slice(0, 10);
export const dayStartMs = (n) => n * DAY - TZ; // 北京时间 0 点对应的时间戳
export function cst(ms) {
  const local = ms + TZ;
  const dayNum = Math.floor(local / DAY);
  const minutes = (local - dayNum * DAY) / 60000;
  return { dayNum, minutes, weekday: new Date(dayNum * DAY).getUTCDay() };
}
export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
export function fmtClock(minutes, withSeconds = false) {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60); const mm = Math.floor(m % 60); const s = Math.floor((m * 60) % 60);
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}${withSeconds ? ':' + String(s).padStart(2, '0') : ''}`;
}
export function fmtDateTime(ms, withSeconds = true) {
  const c = cst(ms);
  return `${dateOfDayNum(c.dayNum)} 星期${WEEKDAYS[c.weekday]} ${fmtClock(c.minutes, withSeconds)}`;
}

export const TRAIN_CLASSES = {
  G: { name: '高速动车组', short: '高铁' },
  C: { name: '城际动车组', short: '城际' },
  D: { name: '动车组', short: '动车' },
  Z: { name: '直达特快', short: '直达' },
  T: { name: '特快', short: '特快' },
  K: { name: '快速', short: '快速' },
  S: { name: '市郊列车', short: '市郊' },
  Y: { name: '旅游列车', short: '旅游' },
  L: { name: '临时客车', short: '临客' },
  O: { name: '普快/普客', short: '普客' },
};
const ACCEL_MIN = { G: 4, C: 3, D: 3.5, Z: 3, T: 3, K: 2.5 };

// ---------------- 数据模型 ----------------
export class Model {
  constructor({ meta, network, stations, trains, paths }) {
    this.meta = meta;
    this.decodeNetwork(network);
    this.decodeStations(stations);
    this.decodeTrains(trains);
    this.segs = paths.enc === 'delta1' ? paths.segs.map(decodePath) : paths.segs;
    this.segCache = new Map();
    this.dates = meta.dates;
    this.dayNums = meta.dates.map(dayNumOf);
    this.dayIndex = new Map(this.dayNums.map((d, i) => [d, i]));
    this.trainsByDay = this.dayNums.map(() => []);
    this.trains.forEach((t, ti) => { for (const di of t.days) this.trainsByDay[di]?.push(ti); });
    this.maxSpanDays = Math.min(6, Math.ceil(this.trains.reduce((m, t) => Math.max(m, t.t1), 0) / 1440));
    this.buildStationIndex();
  }

  decodeNetwork(net) {
    const q = net.q;
    this.lineNames = net.names;
    const edges = new Array(net.edges.length);
    for (let i = 0; i < net.edges.length; i++) {
      const row = net.edges[i];
      const n = (row.length - 3) / 2;
      const lons = new Float64Array(n); const lats = new Float64Array(n); const cum = new Float64Array(n);
      let x = 0; let y = 0;
      for (let k = 0; k < n; k++) {
        x += row[3 + 2 * k]; y += row[4 + 2 * k];
        lons[k] = x / q; lats[k] = y / q;
        if (k) cum[k] = cum[k - 1] + haversine(lons[k - 1], lats[k - 1], lons[k], lats[k]);
      }
      edges[i] = { cls: row[0], name: row[1], traffic: row[2], lons, lats, cum, len: cum[n - 1] };
    }
    this.edges = edges;
  }

  decodeStations(st) {
    const F = Object.fromEntries(st.fields.map((f, i) => [f, i]));
    const n = st.rows.length;
    this.stations = st.rows.map((r, i) => ({
      i, name: r[F.name], tele: r[F.tele], py: r[F.py], abbr: r[F.abbr], city: r[F.city],
      lon: r[F.x] == null ? null : r[F.x] / 1e5, lat: r[F.y] == null ? null : r[F.y] / 1e5,
      flag: r[F.flag], rank: r[F.rank],
    }));
    this.stationByName = new Map(this.stations.map((s) => [s.name, s]));
    void n;
  }

  decodeTrains(tr) {
    const F = Object.fromEntries(tr.fields.map((f, i) => [f, i]));
    this.trains = tr.rows.map((r, ti) => {
      const flat = r[F.stops];
      const n = flat.length / 5;
      const st = new Int32Array(n); const arr = new Int32Array(n); const dep = new Int32Array(n);
      const dist = new Float64Array(n); const seg = new Int32Array(n);
      for (let k = 0; k < n; k++) {
        st[k] = flat[5 * k]; arr[k] = flat[5 * k + 1]; dep[k] = flat[5 * k + 2];
        dist[k] = flat[5 * k + 3] < 0 ? -1 : flat[5 * k + 3] * 10; seg[k] = flat[5 * k + 4];
      }
      // 可显示区段：第一个到最后一个有里程的“锚点”车站
      const anchors = [];
      for (let k = 0; k < n; k++) if (seg[k] !== 0) anchors.push(k);
      if (anchors.length) {
        // 最后一个区段的终点 = 最后一个有里程的车站
        let last = -1;
        for (let k = n - 1; k >= 0; k--) if (dist[k] >= 0) { last = k; break; }
        if (last > anchors[anchors.length - 1]) anchors.push(last); else anchors.length = 0;
      }
      const drawable = anchors.length >= 2;
      return {
        ti, no: r[F.no], code: r[F.code], codes: r[F.codes] || r[F.code], cls: r[F.cls], days: r[F.days],
        n, st, arr, dep, dist, seg, anchors, drawable,
        t0: drawable ? dep[anchors[0]] : dep[0], t1: drawable ? arr[anchors[anchors.length - 1]] : arr[n - 1],
        start: dep[0], end: arr[n - 1],
      };
    });
    this.trainByCode = new Map();
    for (const t of this.trains) {
      for (const c of String(t.codes).split('/')) {
        if (!this.trainByCode.has(c)) this.trainByCode.set(c, []);
        this.trainByCode.get(c).push(t);
      }
    }
  }

  buildStationIndex() {
    // 车站 → 经停车次（车次下标、站序）
    this.stationStops = this.stations.map(() => []);
    for (const t of this.trains) for (let k = 0; k < t.n; k++) this.stationStops[t.st[k]]?.push([t.ti, k]);
  }

  // ---------- 日期映射：超出抓取范围时按“同星期几”映射 ----------
  mapDay(dayNum) {
    const i = this.dayIndex.get(dayNum);
    if (i !== undefined) return { idx: i, exact: true };
    const wd = new Date(dayNum * DAY).getUTCDay();
    let best = -1; let bestD = Infinity;
    this.dayNums.forEach((d, j) => {
      const same = new Date(d * DAY).getUTCDay() === wd;
      const score = Math.abs(d - dayNum) + (same ? 0 : 10000);
      if (score < bestD) { bestD = score; best = j; }
    });
    return { idx: best, exact: false };
  }

  /** 某时刻所有在途（可显示）的车次运行：[{t, day, rel}] */
  activeRuns(ms, filter) {
    const { dayNum, minutes } = cst(ms);
    const out = [];
    for (let k = 0; k <= this.maxSpanDays; k++) {
      const m = this.mapDay(dayNum - k);
      if (m.idx < 0) continue;
      const rel = minutes + k * 1440;
      for (const ti of this.trainsByDay[m.idx]) {
        const t = this.trains[ti];
        if (!t.drawable || rel < t.t0 || rel > t.t1) continue;
        if (filter && !filter(t)) continue;
        out.push({ t, day: dayNum - k, rel });
      }
    }
    return out;
  }

  runsOnDay(t, dayNum) { const m = this.mapDay(dayNum); return m.idx >= 0 && t.days.includes(m.idx); }

  // ---------- 几何 ----------
  segPolyline(ref) {
    const i = Math.abs(ref) - 1;
    let pl = this.segCache.get(i);
    if (!pl) { pl = this.decodeSeg(this.segs[i]); this.segCache.set(i, pl); }
    return pl;
  }

  decodeSeg(p) {
    const lons = []; const lats = [];
    const push = (x, y) => {
      const n = lons.length;
      if (n && Math.abs(lons[n - 1] - x) < 1e-9 && Math.abs(lats[n - 1] - y) < 1e-9) return;
      lons.push(x); lats.push(y);
    };
    if (p[0] === -1) {
      const a = this.stations[p[1]]; const b = this.stations[p[2]];
      push(a.lon, a.lat); push(b.lon, b.lat);
    } else {
      const [oA, oB, ...es] = p;
      const piece = (e, from, to) => {
        const E = this.edges[e];
        const [x0, y0] = pointAt(E, from); push(x0, y0);
        const { cum } = E;
        if (to > from) { for (let k = 0; k < cum.length; k++) if (cum[k] > from && cum[k] < to) push(E.lons[k], E.lats[k]); }
        else { for (let k = cum.length - 1; k >= 0; k--) if (cum[k] < from && cum[k] > to) push(E.lons[k], E.lats[k]); }
        const [x1, y1] = pointAt(E, to); push(x1, y1);
      };
      if (es.length === 1) piece(Math.abs(es[0]) - 1, oA, oB);
      else {
        es.forEach((se, i) => {
          const e = Math.abs(se) - 1; const E = this.edges[e];
          if (i === 0) piece(e, oA, se > 0 ? E.len : 0);
          else if (i === es.length - 1) piece(e, se > 0 ? 0 : E.len, oB);
          else piece(e, se > 0 ? 0 : E.len, se > 0 ? E.len : 0);
        });
      }
    }
    const n = lons.length;
    const L = Float64Array.from(lons); const T = Float64Array.from(lats); const cum = new Float64Array(n);
    for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + haversine(L[k - 1], T[k - 1], L[k], T[k]);
    return { lons: L, lats: T, cum, len: n ? cum[n - 1] : 0 };
  }

  /** 列车全程（可显示部分）在距离 d（米）处的位置与方向 */
  locate(t, d) {
    const A = t.anchors;
    let k = 0;
    while (k < A.length - 2 && t.dist[A[k + 1]] <= d) k++;
    const ref = t.seg[A[k]];
    const pl = this.segPolyline(ref);
    const segStart = t.dist[A[k]]; const segEnd = t.dist[A[k + 1]];
    // 用区段的真实长度与时刻表里程之比做缩放，保证落在区段内
    const span = segEnd - segStart;
    let off = span > 0 ? ((d - segStart) / span) * pl.len : 0;
    off = Math.max(0, Math.min(pl.len, off));
    if (ref < 0) off = pl.len - off;
    const i = seek(pl.cum, off);
    const j = Math.min(i + 1, pl.lons.length - 1);
    const s = pl.cum[j] - pl.cum[i];
    const f = s > 0 ? (off - pl.cum[i]) / s : 0;
    const lon = pl.lons[i] + f * (pl.lons[j] - pl.lons[i]);
    const lat = pl.lats[i] + f * (pl.lats[j] - pl.lats[i]);
    let b = j > i ? bearing(pl.lons[i], pl.lats[i], pl.lons[j], pl.lats[j]) : 0;
    if (ref < 0) b = (b + 180) % 360;
    return { lon, lat, bearing: b };
  }

  /**
   * 列车在相对始发日 0 点 rel 分钟时的状态
   * 返回 {lon, lat, bearing, moving, i（上一/当前站序）, j（下一站序）, speed（km/h）, d（米）}
   */
  state(t, rel) {
    if (!t.drawable || rel < t.t0 || rel > t.t1) return null;
    const { arr, dep, dist } = t;
    // 最后一个到达时刻 ≤ rel 的站
    let lo = 0; let hi = t.n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= rel) lo = m; else hi = m - 1; }
    let i = lo;
    if (arr[i] > rel) i = 0;
    let d; let moving = false; let speed = 0; let j = i;
    if (rel <= dep[i] || i === t.n - 1) {
      d = dist[i];
    } else {
      j = i + 1;
      while (j < t.n - 1 && dist[j] < 0) j++;
      let a = i; while (a > 0 && dist[a] < 0) a--;
      const T = arr[j] - dep[i];
      const D = dist[j] - dist[a];
      const f = T > 0 ? (rel - dep[i]) / T : 1;
      const acc = Math.min(0.3, (ACCEL_MIN[t.cls] || 2) / Math.max(T, 1));
      const vmax = 1 / (1 - acc);
      let s; let v;
      if (f < acc) { s = (0.5 * vmax * f * f) / acc; v = (vmax * f) / acc; }
      else if (f <= 1 - acc) { s = 0.5 * vmax * acc + vmax * (f - acc); v = vmax; }
      else { s = 1 - (0.5 * vmax * (1 - f) ** 2) / acc; v = (vmax * (1 - f)) / acc; }
      d = dist[a] + s * D;
      moving = true;
      speed = T > 0 ? (v * D) / 1000 / (T / 60) : 0;
    }
    if (d < 0) return null;
    const p = this.locate(t, d);
    return { ...p, moving, i, j, speed, d };
  }

  /** 列车全程折线（可显示部分），用于高亮 */
  routeCoords(t) {
    const coords = [];
    if (!t.drawable) return coords;
    const A = t.anchors;
    for (let k = 0; k < A.length - 1; k++) {
      const ref = t.seg[A[k]];
      const pl = this.segPolyline(ref);
      const n = pl.lons.length;
      for (let q = 0; q < n; q++) {
        const idx = ref > 0 ? q : n - 1 - q;
        if (coords.length && q === 0) continue;
        coords.push([pl.lons[idx], pl.lats[idx]]);
      }
    }
    return coords;
  }

  /** 列车某站的绝对时间（毫秒）：dayNum 为始发日 */
  stopTimes(t, dayNum, k) {
    const base = dayStartMs(dayNum);
    return { arr: base + t.arr[k] * 60000, dep: base + t.dep[k] * 60000 };
  }

  // ---------------- 站到站查询 ----------------
  /** 城市 → 该城市的车站下标（12306 车站表中的所属城市），按停靠车次多少排序 */
  get cityStations() {
    if (!this._cities) {
      this._cities = new Map();
      for (const s of this.stations) {
        if (!s.city) continue;
        if (!this._cities.has(s.city)) this._cities.set(s.city, []);
        this._cities.get(s.city).push(s.i);
      }
      for (const a of this._cities.values()) a.sort((x, y) => (this.stations[y].rank || 0) - (this.stations[x].rank || 0));
    }
    return this._cities;
  }

  /** 一组车站上每个车次的停站序号：Map(车次下标 → [站序, …]) */
  stopsAt(set) {
    const m = new Map();
    for (const si of set) {
      for (const [ti, k] of this.stationStops[si] || []) {
        let a = m.get(ti);
        if (!a) m.set(ti, a = []);
        a.push(k);
      }
    }
    for (const a of m.values()) a.sort((x, y) => x - y);
    return m;
  }

  /** 一程：始发日 day 的车次 t 从第 ka 站到第 kb 站 */
  leg(t, day, ka, kb) {
    const base = dayStartMs(day);
    const dep = base + t.dep[ka] * 60000; const arr = base + t.arr[kb] * 60000;
    const km = t.dist[ka] >= 0 && t.dist[kb] >= 0 ? (t.dist[kb] - t.dist[ka]) / 1000 : null;
    return { t, day, ka, kb, dep, arr, dur: (arr - dep) / 60000, km };
  }

  /**
   * 直达车次：dayNum 当天（北京时间，按上车站发车时刻）从 fromSet 任一站上车、之后在 toSet 任一站下车。
   * 同城多站时，同一趟车只保留历时最短的上下车组合。返回按发车时间排序的 leg 列表。
   */
  queryDirect(fromSet, toSet, dayNum) {
    const toIdx = this.stopsAt(toSet);
    const best = new Map();
    for (const si of fromSet) {
      for (const [ti, ka] of this.stationStops[si] || []) {
        const ks = toIdx.get(ti);
        if (!ks) continue;
        const t = this.trains[ti];
        if (ka >= t.n - 1) continue;
        const kb = ks.find((k) => k > ka);
        if (kb === undefined) continue;
        const day = dayNum - Math.floor(t.dep[ka] / 1440);
        if (!this.runsOnDay(t, day)) continue;
        const r = this.leg(t, day, ka, kb);
        const key = `${ti}|${day}`;
        const cur = best.get(key);
        if (!cur || r.dur < cur.dur) best.set(key, r);
      }
    }
    return [...best.values()].sort((a, b) => a.dep - b.dep || a.arr - b.arr);
  }

  /**
   * 一次中转：第一程 dayNum 当天从出发站上车，在日均停靠不少于 minRank 趟的车站换乘。
   * 同站换乘等候 minWait–maxWait 分钟；同城换站（如昆明→昆明南）至少等 minWaitCity 分钟。
   * 每个第一程只保留最早到达的接续；最后只留非劣方案（没有另一个方案“出发更晚、到达更早”）。
   * 返回 [{ a, b, x（下车站）, y（换乘上车站）, wait, dep, arr, dur }]，按出发时间排序。
   */
  queryTransfer(fromSet, toSet, dayNum, { minWait = 20, minWaitCity = 90, maxWait = 360, minRank = 20, limit = 20 } = {}) {
    const toIdx = this.stopsAt(toSet);
    const fromIdx = this.stopsAt(fromSet);
    const cities = this.cityStations;
    const rankOf = (i) => this.stations[i].rank || 0;
    const byFirst = new Map();
    for (const si of fromSet) {
      for (const [ti1, ka] of this.stationStops[si] || []) {
        const t1 = this.trains[ti1];
        if (ka >= t1.n - 1) continue;
        const ks1 = toIdx.get(ti1);
        if (ks1 && ks1.some((k) => k > ka)) continue; // 能直达的车不算中转
        const d1 = dayNum - Math.floor(t1.dep[ka] / 1440);
        if (!this.runsOnDay(t1, d1)) continue;
        const base1 = dayStartMs(d1);
        const key1 = `${ti1}|${d1}`;
        let best = byFirst.get(key1) || null;
        for (let kx = ka + 1; kx < t1.n; kx++) {
          const x = t1.st[kx];
          if (fromSet.has(x) || toSet.has(x) || rankOf(x) < minRank) continue;
          const arrX = base1 + t1.arr[kx] * 60000;
          const city = this.stations[x].city;
          const ys = city && cities.has(city) ? cities.get(city).filter((y) => y === x || (rankOf(y) >= minRank && !fromSet.has(y) && !toSet.has(y))) : [x];
          for (const y of ys) {
            const lo = arrX + (y === x ? minWait : minWaitCity) * 60000; const hi = arrX + maxWait * 60000;
            for (const [ti2, k2] of this.stationStops[y]) {
              if (ti2 === ti1) continue;
              const ks = toIdx.get(ti2);
              if (!ks) continue;
              const t2 = this.trains[ti2];
              if (k2 >= t2.n - 1) continue;
              const kb = ks.find((k) => k > k2);
              if (kb === undefined) continue;
              // 第二程若在换乘前就经过出发地，直接在出发地上车即可（已算在直达里），不算中转
              if (fromIdx.get(ti2)?.some((k) => k < k2)) continue;
              // 第二程的始发日 d2 需满足：dayStartMs(d2) + 在换乘站的发车时刻 ∈ [lo, hi]
              const off = t2.dep[k2] * 60000;
              const dA = Math.ceil((lo - off + TZ) / DAY); const dB = Math.floor((hi - off + TZ) / DAY);
              for (let d2 = dA; d2 <= dB; d2++) {
                if (!this.runsOnDay(t2, d2)) continue;
                const arrB = dayStartMs(d2) + t2.arr[kb] * 60000;
                // 到达相同时优先同站换乘、再优先大站
                const score = (y === x ? 1e6 : 0) + rankOf(y);
                if (!best || arrB < best.arr || (arrB === best.arr && score > best.score)) {
                  best = { a: [ti1, d1, ka, kx], b: [ti2, d2, k2, kb], x, y, arr: arrB, score };
                }
                break; // 同一车次取最早的一趟
              }
            }
          }
        }
        if (best) byFirst.set(key1, best);
      }
    }
    const opts = [...byFirst.values()].map((o) => {
      const a = this.leg(this.trains[o.a[0]], o.a[1], o.a[2], o.a[3]);
      const b = this.leg(this.trains[o.b[0]], o.b[1], o.b[2], o.b[3]);
      return { a, b, x: o.x, y: o.y, wait: (b.dep - a.arr) / 60000, dep: a.dep, arr: b.arr, dur: (b.arr - a.dep) / 60000 };
    });
    // 非劣方案：按出发从晚到早扫描，只保留比所有更晚出发的方案到得更早的
    opts.sort((p, q) => q.dep - p.dep || p.arr - q.arr);
    let kept = []; let minArr = Infinity;
    for (const o of opts) if (o.arr < minArr) { kept.push(o); minArr = o.arr; }
    // 去掉比最快方案慢太多的（例如晚出发一天、多绕一大圈）
    const fastest = Math.min(...kept.map((o) => o.dur));
    kept = kept.filter((o) => o.dur <= fastest * 1.3 + 120);
    if (kept.length > limit) kept = kept.sort((p, q) => p.dur - q.dur).slice(0, limit);
    return kept.sort((p, q) => p.dep - q.dep);
  }

  /** 中转方案：先找 6 小时内能接续的；太少时放宽到 20 小时（长途常需隔夜换乘） */
  transferOptions(fromSet, toSet, dayNum) {
    const r = this.queryTransfer(fromSet, toSet, dayNum);
    return r.length >= 3 ? r : this.queryTransfer(fromSet, toSet, dayNum, { maxWait: 1200 });
  }
}

/** 解码 build.mjs 中 encodePath 的压缩径路 */
export function decodePath(p) {
  if (p[0] === -1) return p;
  const out = [p[0], p[1], p[2]];
  let prev = Math.abs(p[2]);
  for (let i = 3; i < p.length; i++) {
    const v = p[i];
    const neg = v & 1; const z = v >>> 1;
    const d = z & 1 ? -(z + 1) / 2 : z / 2;
    prev += d;
    out.push(neg ? -prev : prev);
  }
  return out;
}

function seek(cum, off) {
  let lo = 0; let hi = cum.length - 1;
  if (off <= 0) return 0;
  if (off >= cum[hi]) return Math.max(0, hi - 1);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= off) lo = m; else hi = m; }
  return lo;
}
export function pointAt(E, off) {
  const { lons, lats, cum } = E;
  const n = lons.length;
  if (off <= 0) return [lons[0], lats[0]];
  if (off >= cum[n - 1]) return [lons[n - 1], lats[n - 1]];
  const i = seek(cum, off);
  const s = cum[i + 1] - cum[i];
  const f = s > 0 ? (off - cum[i]) / s : 0;
  return [lons[i] + f * (lons[i + 1] - lons[i]), lats[i] + f * (lats[i + 1] - lats[i])];
}
