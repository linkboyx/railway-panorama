#!/usr/bin/env node
// Run the refresh pipeline with an explicitly direct network connection.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, todayCST, parseArgs } from './lib/util.mjs';

const env = { ...process.env, NODE_USE_ENV_PROXY: '0' };
for (const key of Object.keys(env)) {
  if (/^(https?|all)_proxy$/i.test(key)) delete env[key];
}
const options = parseArgs(process.argv.slice(2), { start: todayCST(), days: '7', interval: '1000', searchConcurrency: '2' });
const days = Number(options.days);
if (!Number.isInteger(days) || days < 1 || days > 14 || !/^\d{4}-\d{2}-\d{2}$/.test(options.start)) {
  console.error('请使用有效的 --start YYYY-MM-DD 与 --days 1..14。');
  process.exit(1);
}
const start = options.start;
const interval = Number(options.interval);
const searchConcurrency = Number(options.searchConcurrency);
if (!Number.isInteger(interval) || interval < 400 || interval > 10000 || ![1, 2].includes(searchConcurrency)) {
  console.error('--interval 必须为 400..10000 毫秒，--search-concurrency 必须为 1 或 2。');
  process.exit(1);
}
const directArgs = Number(process.versions.node.split('.')[0]) >= 24 ? ['--no-use-env-proxy'] : [];
const backupRoot = path.join(ROOT, 'data/backups');
fs.mkdirSync(backupRoot, { recursive: true });
const stage = fs.mkdtempSync(path.join(backupRoot, 'update-'));
const steps = [
  ['scripts/fetch-12306.mjs', '--start', start, '--days', String(days), '--interval', String(interval), '--search-concurrency', String(searchConcurrency)],
  ['scripts/tools/check-update.mjs', '--start', start, '--days', String(days)],
  ['--max-old-space-size=6144', 'scripts/build.mjs', '--out', stage, '--report', path.join(stage, 'build-report.json')],
  ['scripts/tools/check-data.mjs', '--data', stage],
];
console.log(`无代理更新：抓取 ${days} 天车次 → 检查完整性 → 构建 → 校验。`);
for (const args of steps) {
  const result = spawnSync(process.execPath, [...directArgs, ...args], { cwd: ROOT, env, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
const previous = path.join(stage, 'previous');
fs.mkdirSync(previous);
for (const name of ['network', 'stations', 'trains', 'paths', 'meta']) {
  const target = path.join(ROOT, 'web/data', name + '.json');
  if (fs.existsSync(target)) fs.copyFileSync(target, path.join(previous, name + '.json'));
  fs.copyFileSync(path.join(stage, name + '.json'), target + '.tmp');
  fs.renameSync(target + '.tmp', target);
}
console.log(`校验通过，网站数据已更新。旧快照和构建报告保存在 ${stage}。`);
