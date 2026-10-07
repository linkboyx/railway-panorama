#!/usr/bin/env node
/**
 * 模拟接口服务：用真实接口的 URL 和返回格式提供 data/mock/world.json.gz 里的模拟数据，
 * 用来在没有外网的环境下端到端测试抓取脚本（npm run demo 会自动启动它）。
 *
 *   node scripts/mock/server.mjs --port 8930
 *
 * 模拟的接口：
 *   12306：station_name.js、首页、queryTrainInfo/init、search/v1/train/search、
 *          queryTrainInfo/query、czxx/queryByTrainNo
 *   Overpass：/api/interpreter（按 bbox 返回铁路 way/node 或车站）
 * 环境变量：MOCK_FAULTS=0.03（随机故障比例）MOCK_SEARCH_CAP=50（搜索单次最多返回条数）MOCK_OVERPASS_BUSY=0（Overpass 返回 504 的比例）
 *           MOCK_RATELIMIT=0（12306 接口 10 秒内平均每秒超过这么多次请求就封禁）MOCK_BAN_SECONDS=20（封禁时长）
 *           MOCK_MAX_DATE=（可查询的最后日期，之后的日期搜索返回 status=false）
 */
import http from 'node:http';
import path from 'node:path';
import { ROOT, readJSON, parseArgs, weekdayOf, naturalCompare, log } from '../lib/util.mjs';

const args = parseArgs(process.argv.slice(2), { port: '8930', world: path.join(ROOT, 'data/mock/world.json.gz') });
const FAULTS = Number(process.env.MOCK_FAULTS ?? 0.03);
const CAP = Number(process.env.MOCK_SEARCH_CAP ?? 50);
const OVERPASS_MAX = Number(process.env.MOCK_OVERPASS_MAX ?? 6000);
const OVERPASS_BUSY = Number(process.env.MOCK_OVERPASS_BUSY ?? 0); // Overpass 返回 504（服务器繁忙）的比例
const RATELIMIT = Number(process.env.MOCK_RATELIMIT ?? 0);
const BAN_MS = Number(process.env.MOCK_BAN_SECONDS ?? 20) * 1000;
const hits = []; let bannedUntil = 0; const rlStats = { ok: 0, blocked: 0, bans: 0 };

const world = readJSON(args.world);
const nodes = new Map(world.osm.nodes.map(([id, lon, lat]) => [id, [lon, lat]]));
const ways = world.osm.ways.map((w) => {
  let W = 180; let S = 90; let E = -180; let N = -90;
  for (const id of w.nodes) { const [x, y] = nodes.get(id); if (x < W) W = x; if (x > E) E = x; if (y < S) S = y; if (y > N) N = y; }
  return { ...w, bbox: [W, S, E, N] };
});
const trainsByNo = new Map(world.rail.trains.map((t) => [t.no, t]));
const codeIndex = [];
for (const t of world.rail.trains) for (const c of t.codes) codeIndex.push({ code: c, t });
codeIndex.sort((a, b) => naturalCompare(a.code, b.code));
const teleOf = new Map(world.rail.stations.map((s) => [s.name, s.tele]));
const osmBase = new Date(Date.now() - 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');

function runsOn(t, date) {
  const wd = weekdayOf(date); const dom = Number(date.slice(8, 10));
  switch (t.days) {
    case 'daily': return true;
    case 'weekend': return wd === 5 || wd === 6 || wd === 0;
    case 'odd': return dom % 2 === 1;
    case 'even': return dom % 2 === 0;
    case 'mf': return wd >= 1 && wd <= 5;
    case 'ss': return wd === 6 || wd === 0;
    default: return true;
  }
}
const hhmm = (m) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const dur = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const pad2 = (n) => String(n).padStart(2, '0');
const toDate = (s) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s);

function stationNameJS() {
  const parts = world.rail.stations.map((s, i) => `@${s.abbr}|${s.name}|${s.tele}|${s.py}|${s.abbr}|${i}|${String(1000 + (i % 9000))}|${s.city}|||`);
  return `var station_names ='${parts.join('')}';`;
}

function queryTrainInfoRows(t) {
  const dep0 = t.stops[0].dep;
  return t.stops.map((s, i) => {
    const last = i === t.stops.length - 1;
    const diff = Math.floor(s.arr / 1440);
    const row = {
      arrive_day_str: diff === 0 ? '当日到达' : diff === 1 ? '次日到达' : `第${diff + 1}日到达`,
      station_name: s.name,
      arrive_time: i === 0 ? '----' : hhmm(s.arr),
      arrive_day_diff: String(diff),
      start_time: last ? (t.no.charCodeAt(11) % 2 ? hhmm(s.arr) : '----') : hhmm(s.dep),
      station_no: pad2(i + 1),
      running_time: dur(s.arr - dep0),
      station_train_code: s.code,
      wz_num: '--',
    };
    if (i === 0) Object.assign(row, {
      train_class_name: t.className, is_start: 'Y', service_type: '2', end_station_name: t.stops[t.stops.length - 1].name,
      start_station_name: t.stops[0].name, train_style: '--',
    });
    return row;
  });
}
function queryByTrainNoRows(t) {
  return t.stops.map((s, i) => {
    const last = i === t.stops.length - 1;
    const row = {
      arrive_time: i === 0 ? '----' : hhmm(s.arr), station_name: s.name, isChina: '1',
      start_time: last ? hhmm(s.arr) : hhmm(s.dep),
      stopover_time: i === 0 || last ? '----' : `${s.dep - s.arr}分钟`,
      station_no: pad2(i + 1), country_code: '', country_name: '', isEnabled: true,
    };
    if (i === 0) Object.assign(row, {
      train_class_name: t.className, service_type: '2', end_station_name: t.stops[t.stops.length - 1].name,
      start_station_name: t.stops[0].name, station_train_code: s.code,
    });
    return row;
  });
}

// ---------- Overpass ----------
function overpass(query) {
  const m = query.match(/\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/);
  if (!m) return { status: 400, body: 'bad query' };
  const [s, w, n, e] = m.slice(1).map(Number);
  const inBox = (x, y) => x >= w && x <= e && y >= s && y <= n;
  const head = { version: 0.6, generator: 'Overpass API (mock)', osm3s: { timestamp_osm_base: osmBase, copyright: 'mock data' } };
  if (/out center/.test(query)) {
    const els = [];
    for (const st of world.osm.stations) {
      const t = st.tags;
      const ok = ['station', 'halt'].includes(t.railway) || (t.public_transport === 'station' && t.train === 'yes');
      if (!ok) continue;
      const lat = st.lat ?? st.center.lat; const lon = st.lon ?? st.center.lon;
      if (!inBox(lon, lat)) continue;
      // 与真实 Overpass 一致：tags 详细程度下节点不输出坐标
      const tagsOnly = /out\s+(center\s+)?tags/.test(query);
      els.push(st.type === 'way' ? { type: 'way', id: st.id, center: { lat, lon }, tags: t }
        : tagsOnly ? { type: 'node', id: st.id, tags: t } : { type: 'node', id: st.id, lat, lon, tags: t });
    }
    return { json: { ...head, elements: els } };
  }
  const outWays = []; const need = new Set();
  for (const wy of ways) {
    const t = wy.tags;
    if (!['rail', 'narrow_gauge'].includes(t.railway)) continue;
    if (['yard', 'siding', 'spur'].includes(t.service)) continue;
    if (['industrial', 'military', 'tourism', 'test'].includes(t.usage)) continue;
    const [W, S, E, N] = wy.bbox;
    if (E < w || W > e || N < s || S > n) continue;
    if (!wy.nodes.some((id) => { const [x, y] = nodes.get(id); return inBox(x, y); })) continue;
    outWays.push({ type: 'way', id: wy.id, nodes: wy.nodes, tags: t });
    for (const id of wy.nodes) need.add(id);
  }
  const els = [...outWays, ...[...need].map((id) => ({ type: 'node', id, lat: nodes.get(id)[1], lon: nodes.get(id)[0] }))];
  if (els.length > OVERPASS_MAX) {
    return { json: { ...head, elements: [], remark: 'runtime error: Query timed out in "recurse" at line 5 after 301 seconds.' } };
  }
  return { json: { ...head, elements: els } };
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const q = url.searchParams;
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  // 模拟 12306 按频率封禁：10 秒窗口内请求过多就封禁一段时间，封禁期间返回“网络可能存在问题”页面
  if (RATELIMIT && /search|query/.test(p)) {
    const now = Date.now();
    while (hits.length && hits[0] < now - 10000) hits.shift();
    hits.push(now);
    if (now >= bannedUntil && hits.length > RATELIMIT * 10) { bannedUntil = now + BAN_MS; rlStats.bans++; }
    if (now < bannedUntil) {
      rlStats.blocked++;
      return send(200, '<!DOCTYPE html><html><body>网络可能存在问题，请您重试一下！</body></html>', { 'Content-Type': 'text/html' });
    }
    rlStats.ok++;
  }
  if (p === '/__stats') return send(200, { ...rlStats, bannedNow: Date.now() < bannedUntil });
  // 随机故障（不影响车站表与首页）
  const faultable = /search|query|interpreter/.test(p);
  if (faultable && Math.random() < FAULTS) {
    const r = Math.random();
    if (r < 0.4) return send(502, '<html>502 Bad Gateway</html>', { 'Content-Type': 'text/html' });
    if (r < 0.7 && !p.includes('interpreter')) return send(200, '<!DOCTYPE html><html><body>网络可能存在问题，请您重试一下！</body></html>', { 'Content-Type': 'text/html' });
    if (r < 0.85 && p.includes('interpreter')) return send(429, 'rate limited', { 'Retry-After': '1' });
    if (r < 0.85 && p.includes('search')) return send(200, { data: null, status: false, errorMsg: '系统繁忙，请稍后重试' });
    if (r < 0.9 && !p.includes('interpreter')) return send(403, '<html>403 Forbidden</html>', { 'Content-Type': 'text/html' });
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  if (p.includes('interpreter') && Math.random() < OVERPASS_BUSY) return send(504, '<html>504 Gateway Time-out</html>', { 'Content-Type': 'text/html' });
  try {
    if (p === '/index/' || p === '/index/index.html') {
      return send(200, '<html><head><script src="./script/core/common/station_name_v10088.js" type="text/javascript"></script></head><body>mock 12306</body></html>', { 'Content-Type': 'text/html' });
    }
    if (p.endsWith('/station_name.js') || /station_name_v\d+\.js$/.test(p)) {
      return send(200, stationNameJS(), { 'Content-Type': 'application/javascript;charset=UTF-8' });
    }
    if (p === '/otn/queryTrainInfo/init' || p === '/otn/leftTicket/init') {
      return send(200, '<html>init</html>', {
        'Content-Type': 'text/html',
        'Set-Cookie': [`JSESSIONID=MOCK${Date.now()}; Path=/otn`, 'route=6f50b51faa11b987e576cdb301e545c4; Path=/', 'BIGipServerotn=1; path=/'],
      });
    }
    if (p === '/search/v1/train/search') {
      const kw = String(q.get('keyword') || '').toUpperCase();
      const date = toDate(q.get('date') || '');
      if (!kw) return send(200, { data: [], status: true, errorMsg: '' });
      // 模拟 12306 只能查询有限的天数（MOCK_MAX_DATE=YYYY-MM-DD 之后返回 status=false）
      if (process.env.MOCK_MAX_DATE && date > process.env.MOCK_MAX_DATE) return send(200, { data: null, status: false, errorMsg: '查询日期超出预售期' });
      const rows = [];
      for (const { code, t } of codeIndex) {
        if (!code.startsWith(kw) || !runsOn(t, date)) continue;
        rows.push({
          date: date.replaceAll('-', ''), from_station: t.stops[0].name, station_train_code: code,
          to_station: t.stops[t.stops.length - 1].name, train_no: t.no, total_num: String(t.stops.length),
        });
        if (rows.length >= CAP) break;
      }
      return send(200, { data: rows, status: true, errorMsg: '' });
    }
    if (p === '/otn/queryTrainInfo/query') {
      if (!/JSESSIONID/.test(req.headers.cookie || '')) {
        return send(200, '<!DOCTYPE html><html>请先访问 init 页面</html>', { 'Content-Type': 'text/html' });
      }
      const t = trainsByNo.get(q.get('leftTicketDTO.train_no'));
      const date = q.get('leftTicketDTO.train_date');
      const rows = t && runsOn(t, date) ? queryTrainInfoRows(t) : [];
      return send(200, { validateMessagesShowId: '_validatorMessage', status: true, httpstatus: 200, data: { data: rows }, messages: [], validateMessages: {} });
    }
    if (p === '/otn/czxx/queryByTrainNo') {
      const t = trainsByNo.get(q.get('train_no'));
      const rows = t && runsOn(t, q.get('depart_date')) && teleOf.get(t.stops[0].name) === q.get('from_station_telecode')
        ? queryByTrainNoRows(t) : [];
      return send(200, { validateMessagesShowId: '_validatorMessage', status: true, httpstatus: 200, data: { data: rows }, messages: [], validateMessages: {} });
    }
    if (p === '/api/interpreter') {
      let query = q.get('data') || '';
      if (req.method === 'POST') {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks).toString('utf8');
        query = new URLSearchParams(body).get('data') || body;
      }
      const r = overpass(query);
      if (r.status) return send(r.status, r.body, { 'Content-Type': 'text/plain' });
      return send(200, r.json);
    }
    if (p === '/api/status') return send(200, 'Connected as: mock\nRate limit: 2\n2 slots available now.', { 'Content-Type': 'text/plain' });
    send(404, { error: 'not found', path: p });
  } catch (e) {
    send(500, { error: e.message });
  }
});

server.listen(Number(args.port), '127.0.0.1', () => {
  log(`模拟接口已启动：http://127.0.0.1:${args.port}（车次 ${trainsByNo.size}，故障率 ${FAULTS}，搜索上限 ${CAP}）`);
  if (process.send) process.send({ ready: true, port: server.address().port });
});
