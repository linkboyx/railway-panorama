// OpenStreetMap / Overpass 相关：查询语句、分块、标签分类

/** 公共 Overpass 服务器（按优先顺序），以及请求时使用的 User-Agent。
 *  注意：overpass-api.de 会拒绝浏览器伪装或缺省的 User-Agent（返回 406），必须用能标识程序的 UA。 */
export const DEFAULT_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
export const OVERPASS_UA = 'railway-panorama/1.0 (China railway map data builder; Node.js)';

/** 铁路线查询（不含站场线、专用线、岔线等） */
export function railQuery([w, s, e, n], timeout = 300) {
  const bb = `${s},${w},${n},${e}`;
  return `[out:json][timeout:${timeout}];
(
  way["railway"~"^(rail|narrow_gauge)$"]["service"!~"^(yard|siding|spur)$"]["usage"!~"^(industrial|military|tourism|test)$"](${bb});
);
out body qt;
>;
out skel qt;`;
}

/** 车站查询（含乘降所），输出中心点坐标和标签 */
export function stationQuery([w, s, e, n], timeout = 300) {
  const bb = `${s},${w},${n},${e}`;
  return `[out:json][timeout:${timeout}];
(
  node["railway"~"^(station|halt)$"](${bb});
  way["railway"~"^(station|halt)$"](${bb});
  node["public_transport"="station"]["train"="yes"](${bb});
  way["public_transport"="station"]["train"="yes"](${bb});
);
out center qt;`;
}

/** 生成覆盖范围 [W,S,E,N] 的规则分块 */
export function makeTiles([W, S, E, N], step) {
  const tiles = [];
  for (let x = W; x < E; x += step) {
    for (let y = S; y < N; y += step) {
      tiles.push([round6(x), round6(y), round6(Math.min(x + step, E)), round6(Math.min(y + step, N))]);
    }
  }
  return tiles;
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;
export const tileId = ([w, s, e, n]) => `${w.toFixed(2)}_${s.toFixed(2)}_${e.toFixed(2)}_${n.toFixed(2)}`;
export function splitTile([w, s, e, n]) {
  const mx = round6((w + e) / 2); const my = round6((s + n) / 2);
  return [[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]];
}

// ---------- 标签分类 ----------
export const EDGE_CLASSES = [
  { id: 0, key: 'hsr', name: '高速铁路', desc: '设计时速 250–350 km/h' },
  { id: 1, key: 'fast', name: '快速/城际铁路', desc: '设计时速 160–200 km/h' },
  { id: 2, key: 'main', name: '普速干线', desc: '' },
  { id: 3, key: 'branch', name: '普速支线', desc: '' },
  { id: 4, key: 'narrow', name: '窄轨铁路', desc: '' },
  { id: 5, key: 'link', name: '联络线/渡线', desc: '' },
  { id: 6, key: 'freight', name: '货运线', desc: '' },
];

export function parseMaxspeed(v) {
  if (!v) return 0;
  let best = 0;
  for (const part of String(v).split(/[;,]/)) {
    const m = part.match(/(\d+(?:\.\d+)?)\s*(mph)?/);
    if (m) best = Math.max(best, m[2] ? Number(m[1]) * 1.609 : Number(m[1]));
  }
  return best;
}

export function classifyWay(tags = {}) {
  const name = tags['name:zh'] || tags.name || '';
  const ms = parseMaxspeed(tags.maxspeed || tags['maxspeed:forward'] || tags['maxspeed:backward']);
  const design = parseMaxspeed(tags['maxspeed:design'] || tags['design_speed']);
  const v = Math.max(ms, design);
  const hsName = /高速|客运专线|客专|城际/.test(name);
  if (tags.railway === 'narrow_gauge') return 4;
  if (tags.service === 'crossover') return 5;
  // 高速铁路：标了 highspeed=yes 且速度≥250（或没标速度），或速度≥250
  if (v >= 250 || (tags.highspeed === 'yes' && !v && !/城际/.test(name))) return 0;
  // 快速/城际：highspeed=yes 但速度较低，或名称为城际/客专/高速；提速后的普速干线（160–200）不算
  if (tags.highspeed === 'yes' || hsName) return 1;
  if (tags.usage === 'freight') return 6;
  if (tags.usage === 'branch') return 3;
  if (/联络线|连络线|疏解线/.test(name)) return 5;
  return 2;
}

/** 是否为地铁/轻轨/有轨电车等城市轨道交通车站（不参与国铁匹配） */
export function isUrbanTransitStation(tags = {}) {
  const st = tags.station;
  if (['subway', 'light_rail', 'monorail', 'tram', 'funicular', 'miniature'].includes(st)) return true;
  if (tags.subway === 'yes' || tags.light_rail === 'yes' || tags.monorail === 'yes' || tags.tram === 'yes') {
    return tags.train !== 'yes';
  }
  if (tags.railway === 'tram_stop') return true;
  const net = `${tags.network || ''} ${tags.operator || ''}`;
  if (/地铁|轨道交通|捷运|Metro|MTR Light|轻轨/.test(net) && tags.train !== 'yes' && !/铁路|国铁|China Railway/.test(net)) return true;
  return false;
}

/** 车站名称标签及优先级：0 现用名，1 别名/简称，2 旧名（车站改名后旧名常被别的车站沿用，只在没有更好的匹配时使用） */
const NAME_TAGS = [
  ['name:zh-Hans', 0], ['name:zh-CN', 0], ['name:zh', 0], ['name', 0], ['official_name', 0], ['official_name:zh', 0],
  ['alt_name', 1], ['alt_name:zh', 1], ['short_name', 1],
  ['old_name', 2], ['old_name:zh', 2],
];

/** 车站名称候选（去掉“站”“火车站”等后缀和括号内容），带优先级 [{key, rank}] */
export function stationNameKeysRanked(tags = {}) {
  const best = new Map();
  for (const [k, rank] of NAME_TAGS) {
    const v = tags[k];
    if (!v) continue;
    for (const part of String(v).split(';')) {
      const key = normalizeStationKey(part);
      if (key && !(best.get(key) <= rank)) best.set(key, rank);
    }
  }
  return [...best].map(([key, rank]) => ({ key, rank }));
}
export const stationNameKeys = (tags) => stationNameKeysRanked(tags).map((x) => x.key);
export function normalizeStationKey(s) {
  let t = String(s || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 只取中文部分：处理“北京南站 Beijing South Railway Station”“广州南站/Guangzhou South”等双语名称
  const runs = t.match(/[㐀-鿿]+/g);
  if (!runs) return '';
  t = runs.reduce((a, b) => (b.length > a.length ? b : a));
  t = t.replace(/(火车站|高铁站|动车站|铁路站|客运站|乘降所|线路所|站)$/, '');
  return t;
}
