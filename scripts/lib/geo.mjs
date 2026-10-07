// 几何工具：距离、简化、投影、点到折线最近点、点在多边形内
const R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 局部等距投影（米），适合几十公里范围内的计算 */
export function localProjector(lat0) {
  const kx = R * RAD * Math.cos(lat0 * RAD);
  const ky = R * RAD;
  return { kx, ky, x: (lon) => lon * kx, y: (lat) => lat * ky };
}

/** 平面坐标数组 [x0,y0,x1,y1,...] 的 Douglas-Peucker 简化，返回保留点的索引 */
export function simplifyIndices(xs, ys, tol) {
  const n = xs.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0; let idx = -1;
    const ax = xs[a]; const ay = ys[a]; const bx = xs[b]; const by = ys[b];
    const dx = bx - ax; const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let t = len2 ? ((xs[i] - ax) * dx + (ys[i] - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + t * dx - xs[i]; const py = ay + t * dy - ys[i];
      const d = px * px + py * py;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2 && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** 经纬度折线的长度（米）与累计距离 */
export function cumulativeLengths(lons, lats) {
  const cum = new Float64Array(lons.length);
  for (let i = 1; i < lons.length; i++) cum[i] = cum[i - 1] + haversine(lons[i - 1], lats[i - 1], lons[i], lats[i]);
  return cum;
}

/**
 * 点到经纬度折线的最近点。返回 { dist（米）, offset（沿线距离，米）, seg, t }
 * cum 为折线累计长度（米）
 */
export function nearestOnPolyline(lon, lat, lons, lats, cum) {
  const p = localProjector(lat);
  const px = lon * p.kx; const py = lat * p.ky;
  let best = { dist: Infinity, offset: 0, seg: 0, t: 0 };
  for (let i = 0; i < lons.length - 1; i++) {
    const ax = lons[i] * p.kx; const ay = lats[i] * p.ky;
    const bx = lons[i + 1] * p.kx; const by = lats[i + 1] * p.ky;
    const dx = bx - ax; const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * dx - px; const qy = ay + t * dy - py;
    const d = Math.sqrt(qx * qx + qy * qy);
    if (d < best.dist) best = { dist: d, offset: cum[i] + t * (cum[i + 1] - cum[i]), seg: i, t };
  }
  return best;
}

/** 在折线上按沿线距离取点 */
export function pointAtOffset(lons, lats, cum, offset) {
  const n = lons.length;
  if (offset <= 0) return [lons[0], lats[0]];
  if (offset >= cum[n - 1]) return [lons[n - 1], lats[n - 1]];
  let lo = 0; let hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= offset) lo = mid; else hi = mid; }
  const seg = cum[hi] - cum[lo];
  const t = seg > 0 ? (offset - cum[lo]) / seg : 0;
  return [lons[lo] + t * (lons[hi] - lons[lo]), lats[lo] + t * (lats[hi] - lats[lo])];
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]; const yi = ring[i][1]; const xj = ring[j][0]; const yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
export function pointInGeometry(x, y, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const poly of polys) {
    if (pointInRing(x, y, poly[0])) {
      let hole = false;
      for (let k = 1; k < poly.length; k++) if (pointInRing(x, y, poly[k])) { hole = true; break; }
      if (!hole) return true;
    }
  }
  return false;
}
/** 矩形与多边形是否相交（近似：采样点 + 多边形顶点落在矩形内） */
export function bboxIntersectsGeometry([w, s, e, n], geom, samples = 6) {
  for (let i = 0; i <= samples; i++) {
    for (let j = 0; j <= samples; j++) {
      if (pointInGeometry(w + ((e - w) * i) / samples, s + ((n - s) * j) / samples, geom)) return true;
    }
  }
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) for (const [x, y] of poly[0]) if (x >= w && x <= e && y >= s && y <= n) return true;
  return false;
}

export function bearing(lon1, lat1, lon2, lat2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** 均匀网格空间索引（按经纬度分格） */
export class GridIndex {
  constructor(cellDeg = 0.02) { this.cell = cellDeg; this.map = new Map(); }
  key(ix, iy) { return ix * 100000 + iy; }
  insertPoint(lon, lat, item) {
    const k = this.key(Math.floor(lon / this.cell), Math.floor(lat / this.cell));
    let arr = this.map.get(k); if (!arr) this.map.set(k, arr = []);
    arr.push(item);
  }
  insertBBox(w, s, e, n, item) {
    const x0 = Math.floor(w / this.cell); const x1 = Math.floor(e / this.cell);
    const y0 = Math.floor(s / this.cell); const y1 = Math.floor(n / this.cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const k = this.key(ix, iy);
        let arr = this.map.get(k); if (!arr) this.map.set(k, arr = []);
        arr.push(item);
      }
    }
  }
  /** 查询以 (lon,lat) 为中心、半径 r 米范围内所在格子的对象（去重） */
  query(lon, lat, rMeters) {
    const dLat = rMeters / 111320;
    const dLon = rMeters / (111320 * Math.max(0.2, Math.cos(lat * RAD)));
    const x0 = Math.floor((lon - dLon) / this.cell); const x1 = Math.floor((lon + dLon) / this.cell);
    const y0 = Math.floor((lat - dLat) / this.cell); const y1 = Math.floor((lat + dLat) / this.cell);
    const seen = new Set(); const out = [];
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const arr = this.map.get(this.key(ix, iy));
        if (!arr) continue;
        for (const it of arr) if (!seen.has(it)) { seen.add(it); out.push(it); }
      }
    }
    return out;
  }
}
