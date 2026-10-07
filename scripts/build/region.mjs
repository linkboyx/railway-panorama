// 中国范围判断：用底图里的各省级行政区多边形（含港澳台）
import path from 'node:path';
import { ROOT, readJSON, exists } from '../lib/util.mjs';
import { pointInGeometry } from '../lib/geo.mjs';

/** 返回 (lon, lat) => 是否在中国境内；缺少底图文件时返回 null（调用方不做过滤） */
export function loadRegion(file = path.join(ROOT, 'web/data/basemap/provinces.json')) {
  if (!exists(file)) return null;
  const polys = readJSON(file).features.filter((ft) => ft.geometry).map((ft) => {
    const g = ft.geometry;
    let w = 180; let s = 90; let e = -180; let n = -90;
    for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) {
      for (const [x, y] of poly[0]) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
    }
    return { g, w, s, e, n };
  });
  return (x, y) => polys.some((p) => x >= p.w && x <= p.e && y >= p.s && y <= p.n && pointInGeometry(x, y, p.g));
}

/** 线路（边）是否在境内：首、中、尾任一点在境内即算 */
export const edgeInRegion = (inRegion, e) => {
  const n = e.lons.length;
  return [0, n >> 1, n - 1].some((k) => inRegion(e.lons[k], e.lats[k]));
};
