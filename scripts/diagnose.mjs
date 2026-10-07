#!/usr/bin/env node
/**
 * 网络与接口自检：在正式抓取前运行，确认能访问 12306 和 Overpass，且返回格式符合预期。
 *   npm run diagnose
 */
import { HttpClient } from './lib/http.mjs';
import { parseStationNameJS, parseSearchResult, parseTimetable } from './lib/rail12306.mjs';
import { todayCST, compactDate, parseArgs } from './lib/util.mjs';
import { stationQuery, DEFAULT_OVERPASS_ENDPOINTS, OVERPASS_UA } from './lib/osm.mjs';

const args = parseArgs(process.argv.slice(2), {
  kyfw: process.env.KYFW_BASE || 'https://kyfw.12306.cn',
  search: process.env.SEARCH_BASE || 'https://search.12306.cn',
  overpass: process.env.OVERPASS_URL || DEFAULT_OVERPASS_ENDPOINTS.join(','),
  code: 'G1',
});
const http = new HttpClient({ name: '自检', retries: 1, timeoutMs: 20000 });
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`  ${m}`);
let failures = 0;

async function step(name, fn) {
  try { await fn(); } catch (e) { failures++; bad(`${name}：${e.message}`); if (e.body) info(`返回片段：${String(e.body).slice(0, 200).replace(/\s+/g, ' ')}`); }
}

console.log(`Node ${process.version}，今天（北京时间）${todayCST()}\n`);
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) { bad('需要 Node.js 18 或更高版本'); process.exit(1); }

let stations = [];
await step('12306 车站表', async () => {
  const text = await http.getText(`${args.kyfw}/otn/resources/js/framework/station_name.js`);
  stations = parseStationNameJS(text);
  if (stations.length < 500) throw new Error(`只解析出 ${stations.length} 个车站`);
  ok(`12306 车站表：${stations.length} 个车站，例如 ${stations.slice(0, 3).map((s) => `${s.name}(${s.tele})`).join('、')}`);
});

let first = null;
await step('12306 车次搜索', async () => {
  const date = todayCST();
  const json = await http.getJSON(`${args.search}/search/v1/train/search?keyword=${args.code}&date=${compactDate(date)}`,
    { referer: `${args.kyfw}/otn/queryTrainInfo/init` });
  const rows = parseSearchResult(json, args.code);
  if (!rows.length) throw new Error(`没有搜到 ${args.code}（原始条数 ${json?.data?.length ?? 0}）`);
  first = rows.find((r) => r.code === args.code) || rows[0];
  ok(`车次搜索：关键字 ${args.code} 返回 ${json.data.length} 条，${first.code} → train_no ${first.no}，${first.from}→${first.to}`);
  // 探测单次返回上限和排序（用于前缀展开）
  for (const kw of ['G', 'G1', 'G10', '1', 'X']) {
    const j = await http.getJSON(`${args.search}/search/v1/train/search?keyword=${kw}&date=${compactDate(date)}`, { referer: `${args.kyfw}/otn/queryTrainInfo/init` });
    const codes = (j?.data || []).map((r) => r.station_train_code);
    info(`关键字 ${kw}：${codes.length} 条，前几条 ${codes.slice(0, 6).join(' ')}${codes.length ? (codes.includes(kw) ? '' : `（不含 ${kw} 本身）`) : `（status=${j?.status} ${j?.errorMsg || ''}）`}`);
  }
});

await step('12306 经停站', async () => {
  if (!first) throw new Error('上一步失败，跳过');
  await http.getText(`${args.kyfw}/otn/queryTrainInfo/init`).catch(() => {});
  const json = await http.getJSON(`${args.kyfw}/otn/queryTrainInfo/query?leftTicketDTO.train_no=${first.no}&leftTicketDTO.train_date=${todayCST()}&rand_code=`,
    { referer: `${args.kyfw}/otn/queryTrainInfo/init` });
  const rows = json?.data?.data || [];
  const tt = parseTimetable(rows);
  if (tt.stops.length < 2) throw new Error(`经停站解析失败（原始 ${rows.length} 行）：${JSON.stringify(json).slice(0, 200)}`);
  ok(`经停站（queryTrainInfo）：${first.code} 共 ${tt.stops.length} 站：${tt.stops.map((s) => s.name).join(' → ')}`);
  info(`首行字段：${Object.keys(rows[0]).join(', ')}`);
});

await step('12306 经停站（备用接口）', async () => {
  if (!first) throw new Error('上一步失败，跳过');
  const tele = new Map(stations.map((s) => [s.name, s.tele]));
  const f = tele.get(first.from); const t = tele.get(first.to);
  if (!f || !t) throw new Error('始发/终到站电报码未知');
  const json = await http.getJSON(`${args.kyfw}/otn/czxx/queryByTrainNo?train_no=${first.no}&from_station_telecode=${f}&to_station_telecode=${t}&depart_date=${todayCST()}`,
    { referer: `${args.kyfw}/otn/queryTrainInfo/init` });
  const rows = json?.data?.data || [];
  if (rows.length < 2) throw new Error('返回为空');
  ok(`经停站（queryByTrainNo）：${rows.length} 站`);
});

// Overpass：必须使用能标识程序的 User-Agent，否则 overpass-api.de 会返回 406
const osmHttp = new HttpClient({ name: 'Overpass', retries: 0, timeoutMs: 45000, breakAfter: 1e9, userAgent: OVERPASS_UA });
const postOverpass = (url, q) => osmHttp.request(url, {
  method: 'POST', expect: 'json',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' },
  body: 'data=' + encodeURIComponent(q),
});
const workingOverpass = [];
await step('Overpass（OpenStreetMap）', async () => {
  const q = '[out:json][timeout:60];way["railway"="rail"](39.860,116.370,39.870,116.390);out ids;';
  for (const url of String(args.overpass).split(',').map((x) => x.trim()).filter(Boolean)) {
    const t0 = Date.now();
    try {
      const json = await postOverpass(url, q);
      workingOverpass.push(url);
      ok(`Overpass ${new URL(url).host}：可用（${((Date.now() - t0) / 1000).toFixed(1)} 秒），北京南站附近 ${json.elements.length} 条铁路线，数据时间 ${json.osm3s?.timestamp_osm_base || '未知'}`);
    } catch (e) {
      info(`Overpass ${new URL(url).host}：不可用（${e.status ? 'HTTP ' + e.status : e.cause?.code || e.message}）`);
    }
  }
  if (!workingOverpass.length) throw new Error('所有 Overpass 服务器都不可用');
});

await step('Overpass 车站查询', async () => {
  if (!workingOverpass.length) throw new Error('上一步失败，跳过');
  const json = await postOverpass(workingOverpass[0], stationQuery([116.36, 39.85, 116.39, 39.88], 60));
  const withPos = json.elements.filter((e) => (e.lat ?? e.center?.lat) !== undefined && e.tags);
  if (!withPos.length) throw new Error(`返回 ${json.elements.length} 个要素，但都没有坐标或标签`);
  ok(`Overpass 车站查询：北京南站附近 ${withPos.length} 个车站要素，例如 ${withPos.slice(0, 3).map((e) => e.tags.name || e.tags['name:zh'] || e.id).join('、')}`);
});

console.log('');
if (failures) {
  console.log(`有 ${failures} 项失败。常见原因：网络无法访问该网站、被临时限流（稍后再试）、需要代理（Node 24+ 可设置 NODE_USE_ENV_PROXY=1 与 HTTPS_PROXY）。`);
  console.log('Overpass 服务器可用列表会影响下载速度；fetch:osm 会自动跳过连不上的服务器，也可以用 --overpass 只指定可用的几台。');
  process.exitCode = 1;
} else {
  console.log('全部通过，可以开始抓取：npm run fetch:osm 和 npm run fetch:12306（两者可以在两个终端里同时运行），完成后 npm run build');
  if (workingOverpass.length && workingOverpass.length < String(args.overpass).split(',').length) {
    console.log(`提示：只用可用的 Overpass 服务器会更快：npm run fetch:osm -- --overpass ${workingOverpass.join(',')}`);
  }
}
