// 地图：底图样式（内置矢量底图，无需在线瓦片）、铁路网、车站、选中车次径路
/* global maplibregl */

export const THEMES = {
  dark: {
    ocean: '#0a0f1a', land: '#101826', china: '#142033', lake: '#10223a', river: '#15304f',
    province: '#2b3d58', nation: '#46618a', provinceLabel: '#2f4466', city: '#7288aa', cityHalo: '#0a0f1a',
    rail: ['#4fb6ff', '#2f8fdc', '#7d8ca5', '#56647c', '#56647c', '#5b6a82', '#4a5568'],
    station: '#dfe8f5', stationStroke: '#0a0f1a', stationLabel: '#c9d6ea', stationHalo: '#0a0f1a',
    route: '#ffe066', routeCasing: 'rgba(255,224,102,0.25)', routePassed: '#8a7a3a',
    traffic: ['#1d3557', '#2a6f97', '#43aa8b', '#f9c74f', '#f3722c', '#f94144'],
    trainStroke: [8, 12, 20, 230], labelColor: [230, 237, 247, 255], labelHalo: [10, 15, 26, 230],
  },
  light: {
    ocean: '#dfe7ef', land: '#eef0ec', china: '#fbfaf5', lake: '#cddff0', river: '#b9d2ea',
    province: '#c6cbd4', nation: '#8f9bb0', provinceLabel: '#b3bccb', city: '#6f7a8c', cityHalo: '#fbfaf5',
    rail: ['#1d6fd6', '#3d8fe6', '#707a8a', '#9aa3b2', '#9aa3b2', '#9aa3b2', '#b4bac5'],
    station: '#ffffff', stationStroke: '#39424f', stationLabel: '#2d3440', stationHalo: '#ffffff',
    route: '#e8590c', routeCasing: 'rgba(232,89,12,0.18)', routePassed: '#f4b183',
    traffic: ['#c6dbef', '#6baed6', '#41ab5d', '#fdae61', '#f46d43', '#d73027'],
    trainStroke: [255, 255, 255, 235], labelColor: [33, 37, 41, 255], labelHalo: [255, 255, 255, 230],
  },
};

// 车次类型颜色 [深色主题, 浅色主题]
export const TRAIN_COLORS = {
  G: [[255, 77, 79], [224, 36, 36]],
  C: [[255, 133, 192], [214, 51, 132]],
  D: [[255, 169, 64], [230, 119, 0]],
  Z: [[179, 127, 235], [132, 94, 247]],
  T: [[255, 214, 102], [191, 144, 0]],
  K: [[115, 209, 61], [55, 150, 30]],
  S: [[54, 207, 201], [12, 140, 140]],
  Y: [[149, 222, 100], [80, 160, 40]],
  L: [[211, 173, 247], [150, 100, 200]],
  O: [[191, 191, 191], [110, 110, 110]],
};
export const trainColor = (cls, theme) => (TRAIN_COLORS[cls] || TRAIN_COLORS.O)[theme === 'light' ? 1 : 0];

const pageBase = () => location.origin + location.pathname.replace(/[^/]*$/, '');

export function buildStyle(theme, basemap) {
  const C = THEMES[theme];
  const src = (data) => ({ type: 'geojson', data });
  return {
    version: 8,
    glyphs: pageBase() + 'fonts/{fontstack}/{range}.pbf',
    sources: {
      land: src(basemap.land), provinces: src(basemap.provinces), provLines: src(basemap['province-lines']),
      nation: src(basemap['nation-line']), dash: src(basemap.dashline), rivers: src(basemap.rivers), lakes: src(basemap.lakes),
      cities: src(basemap.cities), provLabels: src(basemap['province-labels']),
      rail: src({ type: 'FeatureCollection', features: [] }),
      stations: src({ type: 'FeatureCollection', features: [] }),
      route: src({ type: 'FeatureCollection', features: [] }),
      routeStops: src({ type: 'FeatureCollection', features: [] }),
      boardHi: src({ type: 'FeatureCollection', features: [] }),
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.ocean } },
      { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': C.land } },
      { id: 'china', type: 'fill', source: 'provinces', paint: { 'fill-color': C.china } },
      { id: 'lakes', type: 'fill', source: 'lakes', paint: { 'fill-color': C.lake } },
      { id: 'rivers', type: 'line', source: 'rivers', paint: { 'line-color': C.river, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 8, 1.4] } },
      { id: 'prov-lines', type: 'line', source: 'provLines', paint: { 'line-color': C.province, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.2], 'line-dasharray': [3, 2] } },
      { id: 'nation', type: 'line', source: 'nation', paint: { 'line-color': C.nation, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 8, 2] } },
      { id: 'dash', type: 'line', source: 'dash', paint: { 'line-color': C.nation, 'line-width': 1.4 } },
      ...railLayers(theme, false),
      { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': C.routeCasing, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 6, 10, 12] } },
      { id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['case', ['==', ['get', 'part'], 'passed'], C.routePassed, C.route], 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2, 10, 4] } },
      ...stationLayers(theme),
      { id: 'prov-labels', type: 'symbol', source: 'provLabels', maxzoom: 5.5, layout: { 'text-field': ['get', 'name'], 'text-font': ['noto'], 'text-size': 13, 'text-letter-spacing': 0.3 }, paint: { 'text-color': C.provinceLabel } },
      ...[[1, 3.6], [2, 5], [3, 6.5], [4, 7]].map(([rank, minzoom]) => ({
        id: `city-labels-${rank}`, type: 'symbol', source: 'cities', minzoom, maxzoom: 9, filter: ['==', ['get', 'rank'], rank],
        layout: { 'text-field': ['get', 'name'], 'text-font': ['noto'], 'text-size': rank === 1 ? 13 : rank === 2 ? 12 : 11, 'text-padding': 6 },
        paint: { 'text-color': C.city, 'text-halo-color': C.cityHalo, 'text-halo-width': 1.2, 'text-opacity': ['interpolate', ['linear'], ['zoom'], 7, 1, 9, 0.35] },
      })),
      { id: 'board-hi', type: 'circle', source: 'boardHi', paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': C.route, 'circle-stroke-width': 2.5 } },
      { id: 'route-stops', type: 'circle', source: 'routeStops', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 10, 5],
        'circle-color': ['case', ['get', 'passed'], C.routePassed, C.route], 'circle-stroke-color': C.stationStroke, 'circle-stroke-width': 1.2 } },
      { id: 'route-stop-labels', type: 'symbol', source: 'routeStops', layout: {
        'text-field': ['get', 'label'], 'text-font': ['noto'], 'text-size': 11.5, 'text-offset': [0.8, 0], 'text-anchor': 'left',
        'text-allow-overlap': false, 'symbol-sort-key': ['get', 'order'], 'text-padding': 2 },
      paint: { 'text-color': C.stationLabel, 'text-halo-color': C.stationHalo, 'text-halo-width': 1.5 } },
    ],
  };
}

// 各等级线路随缩放级别的线宽 [缩放级别, 线宽]...
const RAIL_WIDTH_STOPS = [
  [3, 0.9, 6, 1.7, 10, 3.2, 14, 5],
  [3, 0.7, 6, 1.4, 10, 2.6, 14, 4.2],
  [3, 0.6, 6, 1.2, 10, 2.2, 14, 3.6],
  [3, 0.3, 6, 0.7, 10, 1.5, 14, 2.6],
  [3, 0.3, 6, 0.7, 10, 1.5, 14, 2.6],
  [3, 0.3, 6, 0.6, 10, 1.3, 14, 2.2],
  [3, 0.25, 6, 0.55, 10, 1.2, 14, 2.2],
];
// 线宽表达式：zoom 必须在最外层 interpolate，车流系数放在各级输出里
function railWidth(cls, factor) {
  const stops = RAIL_WIDTH_STOPS[cls];
  const out = ['interpolate', ['linear'], ['zoom']];
  for (let i = 0; i < stops.length; i += 2) out.push(stops[i], factor ? ['*', stops[i + 1], factor] : stops[i + 1]);
  return out;
}
const DRAW_ORDER = [6, 3, 4, 5, 2, 1, 0]; // 低等级在下

export function railLayers(theme, traffic) {
  const C = THEMES[theme];
  return DRAW_ORDER.map((cls) => {
    const paint = traffic ? {
      'line-color': ['interpolate', ['linear'], ['get', 't'], 0, C.traffic[0], 10, C.traffic[1], 40, C.traffic[2], 100, C.traffic[3], 200, C.traffic[4], 400, C.traffic[5]],
      'line-width': railWidth(cls, ['interpolate', ['linear'], ['get', 't'], 0, 0.6, 50, 1.2, 200, 2, 400, 2.8]),
      'line-opacity': ['interpolate', ['linear'], ['get', 't'], 0, 0.45, 5, 0.9],
    } : {
      'line-color': C.rail[cls],
      'line-width': railWidth(cls),
      ...(cls === 4 ? { 'line-dasharray': [2, 1.5] } : {}),
    };
    return { id: `rail-${cls}`, type: 'line', source: 'rail', filter: ['==', ['get', 'c'], cls], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint };
  });
}

function stationLayers(theme) {
  const C = THEMES[theme];
  const tiers = [[1, 4.2, 5.2], [2, 5.8, 7], [3, 7.3, 8.6], [4, 8.8, 10]];
  const layers = [];
  for (const [tier, cz] of tiers) {
    layers.push({
      id: `st-dot-${tier}`, type: 'circle', source: 'stations', minzoom: cz, filter: ['==', ['get', 'tier'], tier],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, tier === 1 ? 2.8 : 2, 10, tier === 1 ? 6 : tier === 2 ? 5 : 4],
        'circle-color': ['case', ['==', ['get', 'flag'], 2], 'rgba(0,0,0,0)', C.station],
        'circle-stroke-color': ['case', ['==', ['get', 'flag'], 2], C.station, C.stationStroke],
        'circle-stroke-width': ['case', ['==', ['get', 'flag'], 2], 1.2, 1],
      },
    });
  }
  for (const [tier, , lz] of tiers) {
    layers.push({
      id: `st-label-${tier}`, type: 'symbol', source: 'stations', minzoom: lz, filter: ['==', ['get', 'tier'], tier],
      layout: {
        'text-field': ['get', 'name'], 'text-font': ['noto'], 'text-size': tier === 1 ? 13 : tier === 2 ? 12 : 11,
        'symbol-sort-key': ['-', 0, ['get', 'rank']], 'text-padding': 3,
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.75,
      },
      paint: { 'text-color': C.stationLabel, 'text-halo-color': C.stationHalo, 'text-halo-width': 1.4 },
    });
  }
  return layers;
}

/** 铁路网 GeoJSON：按（等级, 线名）合并为 MultiLineString，减少要素数 */
export function railGeoJSON(model) {
  const groups = new Map();
  model.edges.forEach((e) => {
    const bucket = Math.min(8, Math.round(Math.log2(1 + e.traffic)));
    const key = `${e.cls}|${e.name}|${bucket}`;
    let g = groups.get(key);
    if (!g) { g = { c: e.cls, n: model.lineNames[e.name] || '', t: e.traffic, lines: [] }; groups.set(key, g); }
    g.t = Math.max(g.t, e.traffic);
    const coords = new Array(e.lons.length);
    for (let k = 0; k < e.lons.length; k++) coords[k] = [e.lons[k], e.lats[k]];
    g.lines.push(coords);
  });
  return {
    type: 'FeatureCollection',
    features: [...groups.values()].map((g) => ({ type: 'Feature', properties: { c: g.c, n: g.n, t: g.t }, geometry: { type: 'MultiLineString', coordinates: g.lines } })),
  };
}

export function stationsGeoJSON(model) {
  const located = model.stations.filter((s) => s.lon != null && s.flag);
  const sorted = [...located].sort((a, b) => b.rank - a.rank);
  const tier = new Map();
  sorted.forEach((s, i) => tier.set(s.i, i < 40 ? 1 : i < 220 ? 2 : i < 900 ? 3 : 4));
  return {
    type: 'FeatureCollection',
    features: located.map((s) => ({
      type: 'Feature', id: s.i,
      properties: { i: s.i, name: s.name, rank: s.rank, flag: s.flag, tier: tier.get(s.i) },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    })),
  };
}

export function setRailMode(map, theme, traffic) {
  for (const l of railLayers(theme, traffic)) {
    for (const [k, v] of Object.entries(l.paint)) map.setPaintProperty(l.id, k, v);
    if (!traffic && !l.paint['line-dasharray']) {
      try { map.setPaintProperty(l.id, 'line-opacity', 1); } catch { /* ignore */ }
    }
  }
}
