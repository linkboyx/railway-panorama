#!/usr/bin/env node
/**
 * 生成网站内置的底图数据（web/data/basemap/*.json）。
 *
 * 这个脚本只在更新底图时需要运行，生成结果已经随项目提供。
 * 运行前需要安装开发依赖：
 *   npm i -D cn-atlas world-atlas topojson-client polylabel mapshaper
 * 另外需要 Natural Earth 的河流/湖泊 GeoJSON，放在 --ne 指定的目录：
 *   ne_50m_rivers_lake_centerlines.geojson, ne_50m_lakes.geojson
 *   （https://github.com/nvkelso/natural-earth-vector/tree/master/geojson）
 *
 * 数据来源：
 *   - 中国省级/地级行政区划：cn-atlas（源自 shengshixian.com 2023 版）
 *   - 周边国家陆地：world-atlas（Natural Earth 1:50m）
 *   - 河流湖泊：Natural Earth 1:50m
 *   - 南海断续线：geojson.cn（来源：民政部全国行政区划信息查询平台 / OSM）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as topojson from 'topojson-client';
import polylabel from 'polylabel';
import mapshaper from 'mapshaper';

const require = createRequire(import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/);
  return m ? [m[1], m[2] || true] : [a, true];
}));
const OUT = path.resolve(args.out || 'web/data/basemap');
const NE_DIR = path.resolve(args.ne || 'ne');
const REGION = [60, -2, 150, 58]; // 底图覆盖范围 [W,S,E,N]

fs.mkdirSync(OUT, { recursive: true });

const round = (v, p = 4) => Math.round(v * 10 ** p) / 10 ** p;
function roundCoords(geom, p = 4) {
  const r = (c) => (typeof c[0] === 'number' ? [round(c[0], p), round(c[1], p)] : c.map(r));
  return { ...geom, coordinates: r(geom.coordinates) };
}
function writeJSON(name, obj) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  console.log(`  ${name}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
async function ms(cmd, inputs) {
  const out = await mapshaper.applyCommands(cmd, inputs);
  const key = Object.keys(out)[0];
  return JSON.parse(out[key].toString());
}

const shortProvince = (n) => n
  .replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/, '');
const ETHNIC = /(朝鲜族|苗族|侗族|彝族|藏族|羌族|土家族|哈尼族|傣族|景颇族|傈僳族|白族|壮族|布依族|回族|蒙古族|哈萨克族|哈萨克|柯尔克孜|蒙古|纳西族|拉祜族|佤族|瑶族|土族|撒拉族|黎族)$/;
function shortCity(n) {
  let s = n.replace(/(特别行政区)$/, '');
  if (/自治州$/.test(s)) {
    s = s.replace(/自治州$/, '');
    while (ETHNIC.test(s)) s = s.replace(ETHNIC, '');
  } else if (/自治县$/.test(s)) {
    s = s.replace(/自治县$/, '');
    while (ETHNIC.test(s)) s = s.replace(ETHNIC, '');
  } else {
    s = s.replace(/(市|地区|盟|林区|县)$/, '');
  }
  return s || n;
}

// 省会及主要城市的城区坐标（覆盖多边形中心点，标注更准确）
const CITY_POS = {
  北京: [116.405, 39.905, 1], 天津: [117.2, 39.085, 1], 上海: [121.473, 31.232, 1], 重庆: [106.551, 29.563, 1],
  石家庄: [114.514, 38.042, 1], 太原: [112.549, 37.87, 1], 呼和浩特: [111.749, 40.842, 1], 沈阳: [123.431, 41.806, 1],
  长春: [125.324, 43.817, 1], 哈尔滨: [126.535, 45.803, 1], 南京: [118.797, 32.06, 1], 杭州: [120.155, 30.274, 1],
  合肥: [117.227, 31.821, 1], 福州: [119.297, 26.075, 1], 南昌: [115.858, 28.683, 1], 济南: [117.001, 36.651, 1],
  郑州: [113.625, 34.747, 1], 武汉: [114.305, 30.593, 1], 长沙: [112.939, 28.228, 1], 广州: [113.264, 23.129, 1],
  南宁: [108.366, 22.817, 1], 海口: [110.199, 20.044, 1], 成都: [104.066, 30.573, 1], 贵阳: [106.63, 26.647, 1],
  昆明: [102.833, 24.88, 1], 拉萨: [91.132, 29.66, 1], 西安: [108.94, 34.341, 1], 兰州: [103.834, 36.061, 1],
  西宁: [101.778, 36.617, 1], 银川: [106.231, 38.487, 1], 乌鲁木齐: [87.617, 43.826, 1], 台北: [121.565, 25.033, 1],
  香港: [114.169, 22.319, 1], 澳门: [113.543, 22.187, 1],
  深圳: [114.058, 22.543, 2], 大连: [121.615, 38.914, 2], 青岛: [120.383, 36.067, 2], 厦门: [118.089, 24.48, 2],
  宁波: [121.55, 29.875, 2], 苏州: [120.585, 31.299, 2], 无锡: [120.312, 31.491, 2], 徐州: [117.184, 34.262, 2],
  洛阳: [112.454, 34.62, 2], 包头: [109.84, 40.658, 2], 大同: [113.3, 40.077, 2], 桂林: [110.29, 25.274, 2],
  三亚: [109.512, 18.253, 2], 汕头: [116.682, 23.354, 2], 温州: [120.699, 27.994, 2], 襄阳: [112.144, 32.042, 2],
  宜昌: [111.286, 30.692, 2], 赣州: [114.935, 25.831, 2], 遵义: [106.927, 27.726, 2], 柳州: [109.416, 24.326, 2],
  齐齐哈尔: [123.918, 47.354, 2], 吉林: [126.55, 43.838, 2], 唐山: [118.18, 39.63, 2], 秦皇岛: [119.6, 39.935, 2],
  烟台: [121.448, 37.463, 2], 潍坊: [119.162, 36.707, 2], 临沂: [118.356, 35.105, 2], 泉州: [118.676, 24.874, 2],
  珠海: [113.577, 22.271, 2], 东莞: [113.752, 23.02, 2], 佛山: [113.122, 23.021, 2], 湛江: [110.359, 21.271, 2],
  绵阳: [104.679, 31.468, 2], 南充: [106.11, 30.837, 2], 常州: [119.974, 31.811, 2], 南通: [120.894, 31.98, 2],
  扬州: [119.413, 32.394, 2], 绍兴: [120.58, 30.03, 2], 台州: [121.42, 28.656, 2], 金华: [119.647, 29.079, 2],
  嘉兴: [120.755, 30.746, 2], 芜湖: [118.433, 31.352, 2], 蚌埠: [117.389, 32.916, 2], 保定: [115.465, 38.874, 2],
  邯郸: [114.539, 36.625, 2], 张家口: [114.887, 40.824, 2], 承德: [117.963, 40.951, 2], 鞍山: [122.995, 41.108, 2],
  锦州: [121.127, 41.095, 2], 丹东: [124.355, 40.0, 2], 牡丹江: [129.633, 44.552, 2], 佳木斯: [130.319, 46.8, 2],
  大庆: [125.103, 46.588, 2], 株洲: [113.134, 27.828, 2], 衡阳: [112.572, 26.894, 2], 岳阳: [113.129, 29.357, 2],
  九江: [115.993, 29.705, 2], 上饶: [117.943, 28.455, 2], 宝鸡: [107.238, 34.362, 2], 天水: [105.725, 34.581, 2],
  酒泉: [98.494, 39.733, 2], 嘉峪关: [98.29, 39.772, 2], 哈密: [93.515, 42.819, 2], 库尔勒: [86.174, 41.726, 2],
  喀什: [75.99, 39.47, 2], 和田: [79.922, 37.114, 2], 伊宁: [81.324, 43.917, 2], 克拉玛依: [84.889, 45.58, 2],
  格尔木: [94.903, 36.402, 2], 日喀则: [88.881, 29.267, 2], 林芝: [94.361, 29.649, 2], 大理: [100.268, 25.607, 2],
  丽江: [100.227, 26.855, 2], 曲靖: [103.796, 25.49, 2], 西昌: [102.264, 27.894, 2], 攀枝花: [101.719, 26.582, 2],
  宜宾: [104.643, 28.752, 2], 泸州: [105.443, 28.872, 2], 达州: [107.468, 31.209, 2], 万州: [108.408, 30.807, 2],
  怀化: [110.0, 27.57, 2], 张家界: [110.479, 29.117, 2], 北海: [109.12, 21.481, 2], 梧州: [111.279, 23.477, 2],
  湖州: [120.088, 30.894, 2], 连云港: [119.222, 34.597, 2], 盐城: [120.162, 33.35, 2], 淮安: [119.113, 33.551, 2],
  商丘: [115.656, 34.415, 2], 南阳: [112.528, 32.991, 2], 信阳: [114.091, 32.147, 2], 阜阳: [115.815, 32.889, 2],
  延安: [109.49, 36.585, 2], 榆林: [109.734, 38.285, 2], 鄂尔多斯: [109.781, 39.608, 2], 赤峰: [118.887, 42.258, 2],
  通辽: [122.244, 43.652, 2], 海拉尔: [119.766, 49.212, 2], 满洲里: [117.379, 49.598, 2], 二连浩特: [111.977, 43.653, 2],
  延吉: [129.509, 42.891, 2], 珲春: [130.366, 42.862, 2], 黑河: [127.528, 50.245, 2], 漠河: [122.538, 52.972, 2],
};

async function main() {
  console.log('生成底图数据 →', OUT);

  // 1) 周边陆地（world-atlas land-50m）
  const land50 = require('world-atlas/land-50m.json');
  const landGeo = topojson.feature(land50, land50.objects.land);
  const land = await ms(
    `-i land.json -clip bbox=${REGION.join(',')} -o format=geojson precision=0.001 out.json`,
    { 'land.json': landGeo },
  );
  writeJSON('land.json', land);

  // 2) 省级行政区（面 + 省界 + 国界）
  const prov = require('cn-atlas/provinces.json');
  for (const f of prov.features) {
    const full = f.properties['地名'];
    f.properties = { name: shortProvince(full), full, code: f.properties.id };
  }
  const provSimple = await ms(
    '-i p.json -simplify 12% keep-shapes -o format=geojson precision=0.0001 out.json',
    { 'p.json': prov },
  );
  writeJSON('provinces.json', provSimple);
  const inner = await ms(
    '-i p.json -simplify 12% keep-shapes -innerlines -o format=geojson precision=0.0001 out.json',
    { 'p.json': prov },
  );
  writeJSON('province-lines.json', inner);
  const nation = require('cn-atlas/nation.json');
  const nationLine = await ms(
    '-i n.json -simplify 12% keep-shapes -lines -o format=geojson precision=0.0001 out.json',
    { 'n.json': nation },
  );
  writeJSON('nation-line.json', nationLine);
  // 粗略国境多边形，供 fetch-osm 选取查询分块
  const outline = await ms(
    '-i n.json -simplify 1.5% keep-shapes -filter-islands min-area=500km2 -o format=geojson precision=0.01 out.json',
    { 'n.json': nation },
  );
  writeJSON('china-outline.json', outline);

  // 省名标注点
  const provLabels = {
    type: 'FeatureCollection',
    features: provSimple.features.map((f) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      let best = polys[0]; let bestA = 0;
      for (const p of polys) {
        const a = Math.abs(ringArea(p[0]));
        if (a > bestA) { bestA = a; best = p; }
      }
      const pt = polylabel(best, 0.05);
      return { type: 'Feature', properties: { name: f.properties.name }, geometry: { type: 'Point', coordinates: [round(pt[0], 3), round(pt[1], 3)] } };
    }),
  };
  writeJSON('province-labels.json', provLabels);

  // 3) 城市标注（地级行政区中心 + 主要城市城区坐标）
  const pref = require('cn-atlas/prefectures.json');
  const cities = new Map();
  for (const f of pref.features) {
    const full = f.properties['地名'];
    if (/自治县$|县$/.test(full) && !/市$/.test(full)) continue; // 海南省直辖县不标
    const name = shortCity(full);
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let best = polys[0]; let bestA = 0;
    for (const p of polys) {
      const a = Math.abs(ringArea(p[0]));
      if (a > bestA) { bestA = a; best = p; }
    }
    const pt = polylabel(best, 0.02);
    const kind = /市$/.test(full) ? 3 : 4; // 3=地级市 4=地区/州/盟
    cities.set(name, { name, lon: pt[0], lat: pt[1], rank: kind });
  }
  for (const [name, [lon, lat, rank]] of Object.entries(CITY_POS)) {
    const c = cities.get(name);
    if (c) Object.assign(c, { lon, lat, rank: Math.min(rank, c.rank) });
    else cities.set(name, { name, lon, lat, rank });
  }
  writeJSON('cities.json', {
    type: 'FeatureCollection',
    features: [...cities.values()].map((c) => ({
      type: 'Feature',
      properties: { name: c.name, rank: c.rank },
      geometry: { type: 'Point', coordinates: [round(c.lon, 3), round(c.lat, 3)] },
    })),
  });

  // 4) 南海断续线
  writeJSON('dashline.json', {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { name: '十段线' }, geometry: roundCoords(DASH_LINE, 3) }],
  });

  // 5) 河流 / 湖泊（Natural Earth 50m）
  const riversFile = path.join(NE_DIR, 'ne_50m_rivers_lake_centerlines.geojson');
  const lakesFile = path.join(NE_DIR, 'ne_50m_lakes.geojson');
  if (fs.existsSync(riversFile)) {
    const rivers = JSON.parse(fs.readFileSync(riversFile, 'utf8'));
    rivers.features = rivers.features.filter((f) => f.geometry).map((f) => ({
      type: 'Feature', properties: { r: f.properties.scalerank }, geometry: f.geometry,
    }));
    const clipped = await ms(`-i r.json -clip bbox=${REGION.join(',')} -o format=geojson precision=0.001 out.json`, { 'r.json': rivers });
    writeJSON('rivers.json', clipped);
  } else console.warn('  跳过河流（缺少 Natural Earth 数据）');
  if (fs.existsSync(lakesFile)) {
    const lakes = JSON.parse(fs.readFileSync(lakesFile, 'utf8'));
    lakes.features = lakes.features.filter((f) => f.geometry).map((f) => ({
      type: 'Feature', properties: { r: f.properties.scalerank }, geometry: f.geometry,
    }));
    const clipped = await ms(`-i l.json -clip bbox=${REGION.join(',')} -o format=geojson precision=0.001 out.json`, { 'l.json': lakes });
    writeJSON('lakes.json', clipped);
  } else console.warn('  跳过湖泊（缺少 Natural Earth 数据）');

  console.log('完成');
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a / 2;
}

// 南海十段线（geojson.cn：数据来源 xzqh.mca.gov.cn / OpenStreetMap relation 3939323）
const DASH_LINE = {
  type: 'MultiLineString',
  coordinates: [
    [[109.51763678906526, 16.360467782665847], [109.72339159230361, 16.05587198177934], [109.8780414893003, 15.766823920473868], [109.96506402665503, 15.526031073258686], [109.98526818797363, 15.335615618596712]],
    [[110.48331454715199, 12.431407837351566], [110.48240767589328, 12.085792287259398], [110.45136562643113, 11.863835000833953], [110.25652028695671, 11.393616070326182]],
    [[108.3388949586325, 7.26656318024262], [108.30727608084116, 6.727803403200289], [108.35631901989032, 6.112648053307836]],
    [[111.94112275674237, 3.553559321848772], [112.40151782268552, 3.646409974664658], [112.92104341055976, 3.845112027649191]],
    [[115.69079809651517, 7.29016984601141], [116.4095482213759, 8.137962397303875]],
    [[118.63503455703679, 11.080904139262175], [118.85587024190139, 11.457907321145406], [119.10128629647166, 12.062751715859875], [119.12181771101825, 12.135585760471585]],
    [[119.60808384544805, 18.143451232827125], [119.91075760817219, 18.77194701315816], [120.11918953031866, 19.117669954512905]],
    [[121.40591812413318, 20.8001943859176], [122.12216430894797, 21.716094829922323]],
    [[122.80328441666389, 23.665545127578547], [123.00481138309124, 24.74934291726869]],
    [[119.16836075308866, 15.107448879733406], [119.16981236678279, 15.755038547478351], [119.17823197590195, 16.265658015720753]],
  ],
};

main().catch((e) => { console.error(e); process.exit(1); });
