#!/usr/bin/env node
/**
 * 从 OpenStreetMap（Overpass API）分块下载全国铁路线和车站。
 *
 * 用法：
 *   node scripts/fetch-osm.mjs                       # 下载全部（已下载的分块会跳过，可断点续传）
 *   node scripts/fetch-osm.mjs --only rail           # 只下载铁路线
 *   node scripts/fetch-osm.mjs --only stations       # 只下载车站
 *   node scripts/fetch-osm.mjs --overpass https://overpass-api.de/api/interpreter   # 指定服务器（逗号分隔多个）
 *   node scripts/fetch-osm.mjs --force               # 重新下载全部
 *   node scripts/fetch-osm.mjs --verbose             # 显示每次重试的细节
 *
 * 输出：data/raw/osm/rail/*.json.gz、data/raw/osm/stations/*.json.gz、data/raw/osm/meta.json
 * 数据许可：© OpenStreetMap contributors，ODbL 1.0
 */
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs, ROOT, readJSON, writeJSON, exists, log, warn, sleep, fmtDuration } from './lib/util.mjs';
import { HttpClient } from './lib/http.mjs';
import { railQuery, stationQuery, makeTiles, tileId, splitTile, DEFAULT_OVERPASS_ENDPOINTS, OVERPASS_UA } from './lib/osm.mjs';
import { bboxIntersectsGeometry } from './lib/geo.mjs';

const args = parseArgs(process.argv.slice(2), {
  out: path.join(ROOT, 'data/raw/osm'),
  step: '3',            // 铁路线分块大小（度），失败时自动细分
  interval: '1500',     // 两次请求最小间隔（毫秒），公共 Overpass 服务请勿调得太小
  stationStep: '6',     // 车站分块大小（度）
  timeout: '180',       // 声明给服务器的查询时限（秒）：服务器繁忙时时限小的查询更容易被接受，超时的分块会自动拆小
  only: '',
});

const endpoints = (args.overpass || process.env.OVERPASS_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
const ENDPOINTS = endpoints.length ? endpoints : DEFAULT_OVERPASS_ENDPOINTS;
const POLITE = Number(args.interval) >= 1000; // 公共服务器：遇到繁忙多等一会儿

// 覆盖范围：中国全境（含港澳台）+ 中老铁路老挝段
const CHINA_BBOX = [73, 17.5, 135.5, 54];
const EXTRA_BBOXES = [[100, 17.5, 104, 22]];

const OUT = path.resolve(args.out);
const http = new HttpClient({
  name: 'Overpass', minIntervalMs: Number(args.interval), timeoutMs: (Number(args.timeout) + 60) * 1000, retries: 0, breakAfter: 1e9,
  userAgent: OVERPASS_UA,
});
let osmBase = null;

// ---------------- 服务器健康状况 ----------------
// 连不上（网络层失败）两次的服务器暂停使用 20 分钟；繁忙（429/502/503/504）时在同一台上稍等再试；
// 成功过的服务器优先使用。
const host = (u) => { try { return new URL(u).host; } catch { return u; } };
const health = new Map(ENDPOINTS.map((u) => [u, { fails: 0, deadUntil: 0, ok: 0 }]));
let current = null;
const verbose = (msg) => { if (args.verbose) warn(msg); };

function pickEndpoint(tried) {
  const now = Date.now();
  const alive = ENDPOINTS.filter((u) => health.get(u).deadUntil <= now);
  if (!alive.length) return null;
  if (current && alive.includes(current) && !tried.has(current)) return current;
  const fresh = alive.filter((u) => !tried.has(u));
  const pool = fresh.length ? fresh : alive;
  pool.sort((a, b) => health.get(b).ok - health.get(a).ok || ENDPOINTS.indexOf(a) - ENDPOINTS.indexOf(b));
  return pool[0];
}

async function overpass(query) {
  let lastErr;
  const tried = new Set();
  let busy = 0;
  // 每个分块最多请求 6 次；仍失败时由调用方决定稍后重试或拆小
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = pickEndpoint(tried);
    if (!url) {
      // 所有服务器都在暂停期：等最早恢复的那台
      const soonest = Math.min(...[...health.values()].map((h) => h.deadUntil));
      const wait = Math.max(5000, soonest - Date.now());
      if (wait > 10 * 60e3) {
        const err = new Error(`所有 Overpass 服务器都无法连接（${lastErr?.message || ''}）`);
        err.network = true;
        throw err;
      }
      warn(`所有 Overpass 服务器暂时不可用，${Math.round(wait / 1000)} 秒后再试`);
      await sleep(wait);
      continue;
    }
    const h = health.get(url);
    try {
      const json = await http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' },
        body: 'data=' + encodeURIComponent(query),
        expect: 'json',
      });
      if (json.remark && /runtime error|timed out|out of memory|Dispatcher/i.test(json.remark)) {
        const err = new Error(`Overpass 运行错误：${json.remark.slice(0, 160)}`);
        err.tooBig = /timed out|out of memory/i.test(json.remark);
        err.status = 200;
        throw err;
      }
      if (!Array.isArray(json.elements)) throw Object.assign(new Error('返回缺少 elements'), { status: 200 });
      if (json.osm3s?.timestamp_osm_base) osmBase = json.osm3s.timestamp_osm_base;
      h.fails = 0; h.ok++;
      if (url !== current) { if (current) log(`  → 改用 ${host(url)}`); current = url; }
      return json;
    } catch (err) {
      lastErr = err;
      if (err.tooBig) throw err;
      if (!err.status) {
        // 网络层失败：fetch failed、超时、域名解析失败、连接被拒等 → 立刻换一台
        h.fails++;
        const why = `${err.cause?.code || err.cause?.errors?.[0]?.code || err.name || ''} ${err.message}`.trim();
        if (h.fails >= 2 || /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED/.test(why)) {
          h.deadUntil = Date.now() + 20 * 60e3;
          warn(`${host(url)} 连接失败（${why}），20 分钟内不再使用`);
        } else verbose(`${host(url)} 连接失败（${why}），换一台服务器`);
        tried.add(url);
        continue;
      }
      if ([429, 502, 503, 504].includes(err.status) || err.status === 200) {
        // 服务器繁忙：在同一台上等一会儿再试两次，仍不行再换
        busy++;
        if (busy <= 2) {
          const wait = POLITE ? (err.status === 429 ? 30000 : 10000 * busy) : Math.max(1000, Number(args.interval) * 3);
          verbose(`${host(url)} 繁忙（HTTP ${err.status}），${Math.round(wait / 1000)} 秒后重试`);
          await sleep(wait);
          continue;
        }
        busy = 0;
        tried.add(url);
        verbose(`${host(url)} 持续繁忙，换一台服务器`);
        continue;
      }
      if (err.status === 400) throw err; // 查询语句错误，重试无意义
      // 其他错误（406 等）：本次运行内不再使用该服务器
      h.deadUntil = Date.now() + 60 * 60e3;
      warn(`${host(url)} 返回 ${err.message}，本次不再使用`);
      tried.add(url);
    }
  }
  // 服务器能连上、只是繁忙：标记出来，调用方把分块放到队尾稍后再试，而不是当作网络故障
  if (lastErr && ([429, 502, 503, 504].includes(lastErr.status) || lastErr.status === 200)) lastErr.busy = true;
  throw lastErr;
}

function chinaTiles(step) {
  let outline = null;
  const f = path.join(ROOT, 'web/data/basemap/china-outline.json');
  if (exists(f)) {
    const fc = readJSON(f);
    outline = fc.features ? fc.features[0].geometry : fc;
  }
  const tiles = [];
  for (const t of makeTiles(CHINA_BBOX, step)) {
    const [w, s, e, n] = t;
    const pad = 0.4;
    if (!outline || bboxIntersectsGeometry([w - pad, s - pad, e + pad, n + pad], outline, 8)) tiles.push(t);
  }
  for (const bb of EXTRA_BBOXES) tiles.push(...makeTiles(bb, step));
  return tiles;
}

const LABEL = { rail: '铁路线', stations: '车站' };

async function fetchTiles(kind, tiles, makeQuery, maxDepth = 3) {
  const label = LABEL[kind] || kind;
  const dir = path.join(OUT, kind);
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = (t) => path.join(dir, tileId(t) + '.json.gz');
  // 断点续传：之前失败后拆成小块下载过的分块，只补下还缺的小块，不重下整块
  const hasAny = (t, d) => exists(fileOf(t)) || (d < maxDepth && splitTile(t).some((s) => hasAny(s, d + 1)));
  const pending = (t, d) => {
    if (exists(fileOf(t))) return [];
    if (d < maxDepth && splitTile(t).some((s) => hasAny(s, d + 1))) return splitTile(t).flatMap((s) => pending(s, d + 1));
    return [{ tile: t, depth: d }];
  };
  const perTile = args.force ? tiles.map((t) => [{ tile: t, depth: 0 }]) : tiles.map((t) => pending(t, 0));
  const have = perTile.filter((p) => !p.length).length;
  const partial = perTile.filter((p) => p.length && p[0].depth > 0).length;
  const queue = perTile.flat();
  let total = queue.length;
  log(`${label}：共 ${tiles.length} 块，已下载 ${have} 块${partial ? `（另有 ${partial} 块已下载一部分）` : ''}，本次需下载 ${total} 块`);
  let done = 0; let elements = 0;
  const start = Date.now();
  while (queue.length) {
    const item = queue.shift();
    const { tile, depth } = item;
    const file = fileOf(tile);
    if (exists(file) && !args.force) { done++; continue; }
    try {
      const json = await overpass(makeQuery(tile, Number(args.timeout)));
      writeJSON(file, { bbox: tile, osm_base: json.osm3s?.timestamp_osm_base, elements: json.elements });
      elements += json.elements.length;
      done++;
      consecutiveFail = 0;
      const el = (Date.now() - start) / 1000;
      const eta = (el / done) * (total - done);
      log(`${label} ${done}/${total}（${Math.round((done / total) * 100)}%）${depth ? `[细分 ${depth} 层] ` : ''}${tileId(tile)}：` +
        `${json.elements.length} 个要素 | 已用 ${fmtDuration(el)}，预计还需 ${fmtDuration(eta)} | ${host(current)}`);
    } catch (err) {
      if (err.network || (!err.tooBig && !err.busy && ++consecutiveFail >= 4)) {
        throw new Error(`连续多个分块下载失败（${err.message}）。请先运行 npm run diagnose 检查网络，或用 --overpass 指定其他服务器。已下载的分块会保留，重新运行会从断点继续。`);
      }
      if (err.busy && !item.retried) {
        // 服务器繁忙：先放到队尾，过一会儿原样再试一次；再失败才拆小
        warn(`${label}分块 ${tileId(tile)}：服务器繁忙（${err.message}），稍后再试`);
        queue.push({ tile, depth, retried: true });
        continue;
      }
      if (depth < maxDepth) {
        warn(`${label}分块 ${tileId(tile)} 失败（${err.message}），拆成 4 个小块重试`);
        for (const sub of splitTile(tile)) queue.push({ tile: sub, depth: depth + 1 });
        total += 3;
      } else {
        warn(`${label}分块 ${tileId(tile)} 最终失败：${err.message}`);
        done++;
        failed.push({ kind, tile, error: err.message });
      }
    }
  }
  log(`${label}完成：本次下载 ${done} 块、${elements} 个要素，用时 ${fmtDuration((Date.now() - start) / 1000)}`);
}

const failed = [];
let consecutiveFail = 0;

async function main() {
  log(`输出目录：${OUT}`);
  log(`Overpass 服务器：${ENDPOINTS.map(host).join('、')}（连不上的会自动跳过）`);
  const step = Number(args.step);
  if (!args.only || args.only === 'rail') await fetchTiles('rail', chinaTiles(step), railQuery);
  if (!args.only || args.only === 'stations') await fetchTiles('stations', chinaTiles(Number(args.stationStep)), stationQuery);
  const metaFile = path.join(OUT, 'meta.json');
  const meta = exists(metaFile) ? readJSON(metaFile) : {};
  writeJSON(metaFile, { ...meta, fetchedAt: new Date().toISOString(), osm_base: osmBase || meta.osm_base || null, endpoints: ENDPOINTS, failed }, { pretty: true });
  if (failed.length) {
    warn(`${failed.length} 个分块下载失败，已记录在 meta.json。可稍后重新运行本命令（已成功的分块会跳过）。`);
    process.exitCode = 2;
  } else log('OSM 数据全部完成。下一步：npm run fetch:12306（如已完成）→ npm run build');
}

main().catch((e) => { console.error('\n下载失败：', e.message); process.exit(1); });
