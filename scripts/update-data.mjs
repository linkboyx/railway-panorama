#!/usr/bin/env node
// Run the refresh pipeline with an explicitly direct network connection.
import { spawnSync } from 'node:child_process';
import { ROOT, todayCST } from './lib/util.mjs';

const env = { ...process.env, NODE_USE_ENV_PROXY: '0' };
for (const key of Object.keys(env)) {
  if (/^(https?|all)_proxy$/i.test(key)) delete env[key];
}
const start = todayCST();
const steps = [
  ['scripts/fetch-12306.mjs', '--start', start, '--days', '7', '--interval', '1000'],
  ['scripts/tools/check-update.mjs', '--start', start],
  ['--max-old-space-size=6144', 'scripts/build.mjs'],
  ['scripts/tools/check-data.mjs'],
];
console.log('无代理更新：抓取 7 天车次 → 检查完整性 → 构建 → 校验。');
for (const args of steps) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
