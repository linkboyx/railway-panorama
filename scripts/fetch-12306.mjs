#!/usr/bin/env node
/**
 * 从 12306 抓取：车站表 → 每天的全部车次列表 → 每个车次的经停时刻。
 *
 * 用法：
 *   node scripts/fetch-12306.mjs                    # 从今天起抓 7 天（可断点续传）
 *   node scripts/fetch-12306.mjs --days 3           # 只抓 3 天
 *   node scripts/fetch-12306.mjs --start 2026-10-01 --days 7
 *   node scripts/fetch-12306.mjs --steps list       # 只做某几步：stations,list,timetable
 *   node scripts/fetch-12306.mjs --interval 1000   # 更慢更稳（最小请求间隔，毫秒）
 *   node scripts/fetch-12306.mjs --sample 50        # 只抓 50 个车次时刻，用来试跑
 *
 * 输出（data/raw/12306/）：
 *   stations.json               车站表（名称、电报码、拼音、城市）
 *   trains/<日期>.json          当天开行的全部车次（车次号、train_no、始发、终到）
 *   timetable/<train_no>.json   经停站原始数据
 *   meta.json                   抓取信息
 *
 * 请合理控制频率：默认最快约 2.5 次/秒，被限流（连续失败）时自动放慢并暂停，恢复后再逐步加快。
 * 中途按 Ctrl+C 会保存进度，重新运行同一命令即可继续。
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  parseArgs, ROOT, readJSON, writeJSON, writeText, exists, log, warn, todayCST, dateRange,
  compactDate, Progress, pool, naturalCompare, sleep,
} from './lib/util.mjs';
import { HttpClient } from './lib/http.mjs';
import { parseStationNameJS, parseSearchResult, timetableFileName } from './lib/rail12306.mjs';

const args = parseArgs(process.argv.slice(2), {
  out: path.join(ROOT, 'data/raw/12306'),
  days: '7',
  start: '',
  steps: 'stations,list,timetable',
  concurrency: '2',
  interval: '400',      // 最小请求间隔（毫秒）；被限流时会自动加大
  searchConcurrency: '2',
  retryMissing: '',    // daily: retry unavailable timetables once per Beijing date
  breakMs: '60000',     // 连续失败后的首次暂停时长（毫秒），反复触发时加倍，最长 10 分钟
  maxInterval: '10000', // 被限流时请求间隔最多放慢到多少毫秒
  kyfw: process.env.KYFW_BASE || 'https://kyfw.12306.cn',
  search: process.env.SEARCH_BASE || 'https://search.12306.cn',
  www: process.env.WWW_BASE || 'https://www.12306.cn',
});
const OUT = path.resolve(args.out);
const STEPS = new Set(String(args.steps).split(',').map((s) => s.trim()));
const START = args.start || todayCST();
const DATES = dateRange(START, Number(args.days));

const http = new HttpClient({
  name: '12306', minIntervalMs: Number(args.interval), adaptive: true, maxIntervalMs: Number(args.maxInterval), timeoutMs: 20000, retries: 4,
  breakAfter: 12, breakMs: Number(args.breakMs), breakMaxMs: 10 * 60e3, maxBreaks: 6, verbose: !!args.verbose, retryStatuses: [403, 418],
  headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
});
http.onBreak = () => initSession(true);

// ---------------- 1. 车站表 ----------------
async function fetchStations() {
  const file = path.join(OUT, 'stations.json');
  let text = null;
  const candidates = [`${args.kyfw}/otn/resources/js/framework/station_name.js`];
  try {
    // 新版地址需要从首页解析（形如 /index/script/core/common/station_name_vXXXX.js）
    const html = await http.getText(`${args.www}/index/`, { retries: 1 });
    const m = html.match(/(?:\.\/|\/)?(?:index\/)?script\/core\/common\/station_name[^"'\s>?]*?\.js/);
    if (m) {
      const ref = m[0];
      candidates.unshift(new URL(ref.startsWith('/') ? ref : './' + ref.replace(/^\.\//, ''), `${args.www}/index/`).href);
    }
  } catch (e) { warn('读取 12306 首页失败，改用旧地址：' + e.message); }
  for (const url of candidates) {
    try {
      text = await http.getText(url, { validate: (t) => t.includes('|') || '内容不像车站表' });
      log(`车站表：${url}`);
      break;
    } catch (e) { warn(`车站表 ${url} 失败：${e.message}`); }
  }
  if (!text) throw new Error('无法获取车站表');
  const stations = parseStationNameJS(text);
  if (stations.length < 500) throw new Error(`车站表只有 ${stations.length} 个车站，格式可能变化`);
  writeText(path.join(OUT, 'station_name.js'), text);
  writeJSON(file, stations, { pretty: false });
  log(`车站表：${stations.length} 个车站`);
  return stations;
}

// ---------------- 会话 Cookie ----------------
async function initSession(reset = false) {
  if (reset) http.clearCookies();
  for (const p of ['/otn/queryTrainInfo/init', '/otn/leftTicket/init']) {
    // 熔断暂停后重新初始化（reset）时只试一次，避免被封期间多发请求
    try { await http.getText(`${args.kyfw}${p}`, { retries: reset ? 0 : 1, bypassBreaker: reset }); } catch (e) { if (!reset || args.verbose) warn(`初始化会话 ${p} 失败：${e.message}`); }
  }
}

// ---------------- 2. 车次列表（按前缀递归展开） ----------------
// 搜索接口每次最多返回若干条（上限未知，自动探测），因此从首字母开始，结果“满了”就继续细分前缀：
// G → G1…G9 → G10…G19 → …，直到每个前缀的结果都没有被截断。
const FIRST = [...'GDCKZTSYLPQNABEFHJMRUVWX', ...'123456789'];
const searchState = { maxSeen: 0 };
async function searchKeyword(kw, date) {
  const url = `${args.search}/search/v1/train/search?keyword=${encodeURIComponent(kw)}&date=${compactDate(date)}`;
  const json = await http.getJSON(url, {
    referer: `${args.kyfw}/otn/queryTrainInfo/init`,
    retries: 2,
    validate: (j) => {
      if (!j || typeof j !== 'object') return '空响应';
      // “查无此车次”一类的提示当作空结果，其余 status=false（如系统繁忙）视为失败重试
      if (j.status === false && /暂无|没有|不存在|未找到|无数据|无结果|无此/.test(j.errorMsg || '')) return true;
      if (j.status === false) return `status=false ${j.errorMsg || ''}`.trim();
      if (!(Array.isArray(j.data) || j.data == null)) return '搜索接口返回格式不对';
      return true;
    },
  });
  const data = Array.isArray(json.data) ? json.data : [];
  return { rows: parseSearchResult(json, kw), raw: data.length, codes: data.map((r) => String(r.station_train_code || '').toUpperCase()) };
}

/**
 * 枚举某一天的全部车次。resume：上次中断/不完整时保存的进度 { trains, done, pending, truncated, queries }。
 * 进度每 40 次查询保存一次到 trains/<日期>.partial.json，Ctrl+C 时也会保存。
 */
async function enumerateDate(date, resume = null) {
  const partialFile = path.join(OUT, 'trains', `${date}.partial.json`);
  const found = new Map((resume?.trains || []).map((r) => [r.no + '|' + r.code, r]));
  const done = new Set(resume?.done || []);   // 已成功查询的前缀
  const todo = new Set();                     // 已排队、尚未成功的前缀
  const failed = new Map();                   // 前缀 -> 错误
  const truncated = [...(resume?.truncated || [])];
  let queue = resume ? [...new Set(resume.pending || [])] : [...FIRST];
  let queries = resume?.queries || 0; let okThisRun = 0; let round = 0; let sinceSave = 0;
  let unavailable = null; // 这一天 12306 不提供数据（G 字头都查不到且不是“繁忙”）
  const conc = Number(args.searchConcurrency);
  const save = () => {
    writeJSON(partialFile, {
      date, savedAt: new Date().toISOString(), queries, maxPerQuery: searchState.maxSeen,
      done: [...done], pending: [...new Set([...todo, ...failed.keys()])], truncated, trains: [...found.values()],
    });
    sinceSave = 0;
  };
  saveOnExit = save;
  while (queue.length || (failed.size && round < 2)) {
    if (!queue.length) {
      // 失败的前缀稍后再试（最多两轮），避免因个别请求失败漏掉一整段车次
      round++;
      const wait = round === 1 ? 30 : 90;
      warn(`${date}：${failed.size} 个前缀查询失败，${wait} 秒后重试（第 ${round} 轮）`);
      await sleep(wait * 1000);
      queue = [...failed.keys()];
      failed.clear();
    }
    const batch = [...new Set(queue)].filter((k) => !done.has(k));
    queue = [];
    batch.forEach((k) => todo.add(k));
    const t0 = Date.now(); const q0 = queries;
    await pool(batch, conc, async (kw) => {
      if (unavailable) return;
      let res;
      try { res = await searchKeyword(kw, date); } catch (e) {
        if (e.fatalBreak) throw e;
        todo.delete(kw);
        failed.set(kw, e.message);
        if (args.verbose) warn(`${date} 搜索 ${kw} 失败：${e.message}`);
        if (!resume && kw === 'G' && okThisRun === 0 && /status=false/.test(e.message) && !/忙|频繁|稍后|重试/.test(e.message)) unavailable = e.message;
        return;
      }
      queries++; okThisRun++;
      todo.delete(kw); done.add(kw);
      for (const r of res.rows) found.set(r.no + '|' + r.code, r);
      searchState.maxSeen = Math.max(searchState.maxSeen, res.raw);
      // 结果按车次号排序、每次最多返回 maxSeen 条：没到上限说明这个前缀已经查全，无需细分
      const capped = res.raw >= Math.max(10, Math.floor(searchState.maxSeen * 0.9));
      // 单字符关键字若不被接口支持（返回 0），常见字头仍展开到两位
      const forceExpand = res.raw === 0 && kw.length === 1 && 'GDCKZTSYL123456789'.includes(kw);
      if ((capped || forceExpand) && kw.length < 6) {
        // 结果若按车次号排序，同名车次存在时必然排在最前；只有结果未排序时才可能被截断掉
        if (capped && res.raw >= searchState.maxSeen && /^[A-Z]?\d+$/.test(kw) && !res.codes.includes(kw) && !isSorted(res.codes)) truncated.push(kw);
        for (const d of '0123456789') { queue.push(kw + d); todo.add(kw + d); }
      }
      if (++sinceSave >= 40) save();
    });
    if (unavailable && okThisRun === 0) { saveOnExit = null; return { unavailable: true, reason: unavailable }; }
    if (okThisRun === 0 && batch.length >= 10 && failed.size >= 10) {
      save();
      const errs = [...failed.values()];
      throw new Error(`车次搜索全部失败（${errs[0]}）。请运行 npm run diagnose 检查网络，或过一段时间再试（可能被临时限流）。进度已保存，重新运行会继续。`);
    }
    save();
    const speed = (queries - q0) / Math.max(0.001, (Date.now() - t0) / 1000);
    log(`  ${date}：已查询 ${queries} 次，找到 ${found.size} 个车次${queue.length ? `，继续细分 ${queue.length} 个前缀` : ''}` +
      `（这一轮约 ${speed.toFixed(1)} 次/秒）`);
  }
  saveOnExit = null;
  if (failed.size) {
    const why = new Map();
    for (const m of failed.values()) { const k = m.slice(0, 50); why.set(k, (why.get(k) || 0) + 1); }
    warn(`${date}：失败原因 ${[...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ×${n}`).join('；')}`);
  }
  return { trains: [...found.values()].sort((a, b) => naturalCompare(a.code, b.code)), queries, failed: [...failed.keys()], truncated };
}
const failedSearch = [];
const isSorted = (codes) => codes.every((c, i) => i === 0 || naturalCompare(codes[i - 1], c) <= 0) ||
  codes.every((c, i) => i === 0 || codes[i - 1] <= c);

// Ctrl+C：保存当天的枚举进度再退出（经停时刻每抓到一个就写入文件，无需额外保存）
let saveOnExit = null;
process.on('SIGINT', () => {
  try { if (saveOnExit) { saveOnExit(); console.log('\n已保存车次枚举进度。'); } } catch (e) { console.error('\n保存进度失败：', e.message); }
  console.log('已停止。重新运行同一命令会从中断处继续。');
  process.exit(130);
});

async function fetchTrainLists() {
  const lists = {};
  for (const date of DATES) {
    const file = path.join(OUT, 'trains', `${date}.json`);
    const partial = path.join(OUT, 'trains', `${date}.partial.json`);
    let resume = null;
    if (exists(file) && !args.refreshList) {
      const saved = readJSON(file);
      if (saved.maxPerQuery) searchState.maxSeen = Math.max(searchState.maxSeen, saved.maxPerQuery);
      if (!saved.incomplete) {
        lists[date] = saved.trains;
        log(`${date}：已存在 ${saved.trains.length} 个车次（跳过，--refresh-list 可重新抓取）`);
        continue;
      }
      // 上次不完整：保留已找到的车次，只补查失败的前缀
      resume = { trains: saved.trains, pending: saved.failedKeywords || [], done: [], truncated: saved.truncatedKeywords || [], queries: saved.queries || 0 };
      log(`${date}：上次有 ${resume.pending.length} 个前缀查询失败，补查这些前缀…`);
    } else if (exists(partial) && !args.refreshList) {
      resume = readJSON(partial);
      if (resume.maxPerQuery) searchState.maxSeen = Math.max(searchState.maxSeen, resume.maxPerQuery);
      log(`${date}：从上次中断处继续（已查询 ${resume.queries} 次，找到 ${resume.trains.length} 个车次，还剩 ${resume.pending.length} 个前缀）`);
    } else {
      log(`${date}：开始枚举车次…`);
    }
    const r = await enumerateDate(date, resume);
    if (r.unavailable) { warn(`${date}：12306 不提供该日期的数据（${r.reason}），跳过`); fs.rmSync(partial, { force: true }); continue; }
    if (!r.trains.length) { warn(`${date}：没有找到任何车次（该日期可能超出 12306 可查询范围），跳过`); fs.rmSync(partial, { force: true }); continue; }
    const incomplete = r.failed.length > 0;
    writeJSON(file, {
      date, fetchedAt: new Date().toISOString(), queries: r.queries, maxPerQuery: searchState.maxSeen,
      incomplete, failedKeywords: r.failed, truncatedKeywords: r.truncated, trains: r.trains,
    });
    fs.rmSync(partial, { force: true });
    lists[date] = r.trains;
    if (incomplete) {
      failedSearch.push({ date, keywords: r.failed });
      warn(`${date}：${r.failed.length} 个前缀多次查询失败（${r.failed.slice(0, 8).join('、')}…），车次列表可能不完整；重新运行本命令会补查这些前缀`);
    }
    if (r.truncated.length) warn(`${date}：前缀 ${r.truncated.slice(0, 10).join('、')} 的结果被截断且不含同名车次，若这些车次号实际存在可能被漏掉`);
    const byClass = {};
    for (const t of r.trains) { const c = /^\d/.test(t.code) ? '普' : t.code[0]; byClass[c] = (byClass[c] || 0) + 1; }
    log(`${date}：${r.trains.length} 个车次（查询 ${r.queries} 次，单次最多返回 ${searchState.maxSeen} 条）` +
      ` ${Object.entries(byClass).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  }
  return lists;
}

// ---------------- 3. 经停时刻 ----------------
async function fetchTimetables(lists, stations) {
  const dir = path.join(OUT, 'timetable');
  const retryFile = path.join(OUT, 'timetable-retries.json');
  const dailyRetry = args.retryMissing === 'daily';
  const retryLedger = dailyRetry && exists(retryFile) ? readJSON(retryFile) : {};
  fs.mkdirSync(dir, { recursive: true });
  const teleByName = new Map(stations.map((s) => [s.name, s.tele]));
  // 每个 train_no 取第一个开行日期
  const jobs = new Map();
  const jobDates = new Map();
  for (const date of Object.keys(lists).sort()) {
    for (const t of lists[date]) {
      if (!jobs.has(t.no)) jobs.set(t.no, { ...t, date });
      if (!jobDates.has(t.no)) jobDates.set(t.no, []);
      jobDates.get(t.no).push(date);
    }
  }
  // 返回经停站数组；接口正常但无数据时返回 []（不重试），被限流/非 JSON 时由 HttpClient 自动重试
  async function queryTrainInfo(no, date) {
    try {
      const url = `${args.kyfw}/otn/queryTrainInfo/query?leftTicketDTO.train_no=${encodeURIComponent(no)}` +
        `&leftTicketDTO.train_date=${date}&rand_code=`;
      const json = await http.getJSON(url, { referer: `${args.kyfw}/otn/queryTrainInfo/init`, validate: (j) => (j && typeof j === 'object') || '空响应' });
      const rows = json?.data?.data;
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      if (e.fatalBreak) throw e;
      if (args.verbose) warn(`${no} queryTrainInfo 失败：${e.message}`);
      return null;
    }
  }
  let todo = [...jobs.values()].filter((j) => !exists(path.join(dir, timetableFileName(j.no))));
  const have = jobs.size - todo.length;
  if (dailyRetry) todo = todo.filter(j => retryLedger[j.no] !== todayCST());
  // 先抓最早一天开行的车次（覆盖了大部分每日开行的车次），中途就可以先 npm run build 预览
  todo.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : naturalCompare(a.code, b.code)));
  if (args.sample) todo = todo.slice(0, Number(args.sample));
  log(`经停时刻：共 ${jobs.size} 个 train_no，已有 ${have} 个，本次抓取 ${todo.length} 个（按 train_no 复用缓存）`);
  if (!todo.length) return;
  await initSession();
  const prog = new Progress('经停时刻', todo.length);
  const failed = [];
  const recent = [];
  await pool(todo, Number(args.concurrency), async (job) => {
    let rows = null; let source = 'queryTrainInfo'; let usedDate = job.date;
    // 依次尝试该车次的几个开行日期（个别情况下某天查不到）
    const tryDates = [job.date, ...(jobDates.get(job.no) || []).filter((d) => d !== job.date)].slice(0, 3);
    for (const date of tryDates) {
      rows = await queryTrainInfo(job.no, date);
      if (rows === null) break; // 请求失败（已重试），不再换日期
      if (rows.length >= 2) { usedDate = date; break; }
    }
    if (!rows || rows.length < 2) {
      // 备用接口：需要始发/终到站电报码
      const ft = teleByName.get(job.from); const tt = teleByName.get(job.to);
      if (ft && tt) {
        try {
          const url = `${args.kyfw}/otn/czxx/queryByTrainNo?train_no=${encodeURIComponent(job.no)}` +
            `&from_station_telecode=${ft}&to_station_telecode=${tt}&depart_date=${job.date}`;
          const json = await http.getJSON(url, { referer: `${args.kyfw}/otn/queryTrainInfo/init`, validate: (j) => (j && typeof j === 'object') || '空响应' });
          const r2 = json?.data?.data;
          if (Array.isArray(r2) && r2.length >= 2) { rows = r2; source = 'queryByTrainNo'; }
        } catch (e) {
          if (e.fatalBreak) throw e;
          if (args.verbose) warn(`${job.code} queryByTrainNo 失败：${e.message}`);
        }
      }
    }
    // 最近 60 个车次里失败超过 80%：多半被限流或网络中断，停止以免长时间无效请求
    recent.push(!rows || rows.length < 2 ? 1 : 0);
    if (dailyRetry && (!rows || rows.length < 2)) {
      retryLedger[job.no] = todayCST();
      writeJSON(retryFile, retryLedger);
    }
    if (recent.length > 60) recent.shift();
    if (recent.length >= 60 && recent.reduce((x, y) => x + y, 0) >= 48) {
      throw new Error('最近的经停站请求大多失败，已停止（多半被 12306 限流）。请过一段时间再运行，或降低频率：--interval 1000。已抓到的数据会保留，重新运行会继续。');
    }
    if (rows && rows.length >= 2) {
      writeJSON(path.join(dir, timetableFileName(job.no)), {
        train_no: job.no, code: job.code, date: usedDate, from: job.from, to: job.to, source,
        fetchedAt: new Date().toISOString(), rows,
      });
      if (dailyRetry && retryLedger[job.no]) {
        delete retryLedger[job.no];
        writeJSON(retryFile, retryLedger);
      }
      prog.tick(true);
    } else {
      failed.push({ no: job.no, code: job.code, date: job.date });
      prog.tick(false, `${job.code} 无经停数据`);
    }
  });
  writeJSON(path.join(OUT, 'timetable-failed.json'), failed, { pretty: true });
  if (failed.length) warn(`${failed.length} 个车次没有取到经停数据（见 timetable-failed.json），重新运行可重试`);
}

async function main() {
  log(`输出目录：${OUT}`);
  log(`日期范围：${DATES[0]} ~ ${DATES[DATES.length - 1]}（${DATES.length} 天）`);
  let stations = exists(path.join(OUT, 'stations.json')) ? readJSON(path.join(OUT, 'stations.json')) : null;
  if (STEPS.has('stations') || !stations) stations = await fetchStations();
  await initSession();
  let lists = {};
  if (STEPS.has('list')) lists = await fetchTrainLists();
  else {
    for (const d of DATES) {
      const f = path.join(OUT, 'trains', `${d}.json`);
      if (exists(f)) {
        const list = readJSON(f);
        if (!list.incomplete && !list.failedKeywords?.length && !list.truncatedKeywords?.length) lists[d] = list.trains;
      }
    }
  }
  if (STEPS.has('timetable')) await fetchTimetables(lists, stations);
  const metaFile = path.join(OUT, 'meta.json');
  const meta = exists(metaFile) ? readJSON(metaFile) : {};
  const allDates = new Set([...(meta.dates || []), ...Object.keys(lists)]);
  writeJSON(metaFile, {
    ...meta, fetchedAt: new Date().toISOString(), dates: [...allDates].sort(),
    stations: stations.length, http: http.stats, failedSearch,
  }, { pretty: true });
  log(`请求统计：${JSON.stringify(http.stats)}`);
  log('完成。下一步：npm run build');
}

main().catch((e) => {
  try { if (saveOnExit) saveOnExit(); } catch { /* 忽略 */ }
  if (e.fatalBreak) {
    console.error(`\n${e.message}。\n已停止运行，已抓到的数据和进度都已保存。建议过 1 小时左右再运行同一命令（会从中断处继续），必要时加 --interval 1500 放慢速度。`);
    process.exit(2);
  }
  console.error('\n抓取失败：', e.message); console.error(e.stack); process.exit(1);
});
