// 通用工具：命令行参数、文件读写、日期（北京时间）、日志与进度
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 解析 --key=value / --key value / --flag 形式的参数 */
export function parseArgs(argv = process.argv.slice(2), defaults = {}) {
  const out = { ...defaults, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) { out._.push(a); continue; }
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (m[2] !== undefined) out[key] = m[2];
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

export function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
export const exists = (p) => fs.existsSync(p);

export function readJSON(file) {
  const buf = fs.readFileSync(file);
  const text = file.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return JSON.parse(text);
}
export function writeJSON(file, obj, { gzip = file.endsWith('.gz'), pretty = false } = {}) {
  ensureDir(path.dirname(file));
  const text = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, gzip ? zlib.gzipSync(text, { level: 6 }) : text);
  fs.renameSync(tmp, file);
}
export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (ms, ratio = 0.3) => Math.round(ms * (1 - ratio + Math.random() * ratio * 2));

// ---------- 北京时间（UTC+8，无夏令时） ----------
const CST_OFFSET = 8 * 3600 * 1000;
export function todayCST(now = Date.now()) {
  return new Date(now + CST_OFFSET).toISOString().slice(0, 10);
}
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function dateRange(start, days) {
  return Array.from({ length: days }, (_, i) => addDays(start, i));
}
export const compactDate = (dateStr) => dateStr.replaceAll('-', '');
export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function nowCSTString() {
  return new Date(Date.now() + CST_OFFSET).toISOString().replace('T', ' ').slice(0, 19) + ' (北京时间)';
}

// ---------- 日志 ----------
const t0 = Date.now();
export function log(...args) {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
  console.log(`[${s}s]`, ...args);
}
export function warn(...args) { console.warn('\x1b[33m[警告]\x1b[0m', ...args); }
export function fmtDuration(sec) {
  if (!isFinite(sec)) return '--';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  return h ? `${h}时${m}分` : m ? `${m}分${s}秒` : `${s}秒`;
}

/** 简单进度显示：每隔一段时间打印一行，适合重定向到日志文件 */
export class Progress {
  constructor(label, total, { interval = 3000 } = {}) {
    this.label = label; this.total = total; this.done = 0; this.fail = 0;
    this.start = Date.now(); this.last = 0; this.interval = interval;
  }
  tick(ok = true, extra = '') {
    this.done++; if (!ok) this.fail++;
    const now = Date.now();
    if (now - this.last > this.interval || this.done === this.total) {
      this.last = now;
      const el = (now - this.start) / 1000;
      const rate = this.done / Math.max(el, 0.001);
      const eta = (this.total - this.done) / Math.max(rate, 1e-6);
      log(`${this.label} ${this.done}/${this.total}` +
        (this.fail ? ` 失败 ${this.fail}` : '') +
        ` | ${rate.toFixed(1)}/秒 | 剩余约 ${fmtDuration(eta)}${extra ? ' | ' + extra : ''}`);
    }
  }
}

/** 并发池：以 n 个并发执行 fn(item, index) */
export async function pool(items, n, fn) {
  let next = 0;
  const results = new Array(items.length);
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

/** 按自然顺序比较车次，如 G2 < G10 */
export function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const pa = String(a).match(re) || []; const pb = String(b).match(re) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]; const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x); const ny = /^\d/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 确定性伪随机数（用于模拟数据） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
