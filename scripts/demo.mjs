#!/usr/bin/env node
/**
 * 一键生成演示数据：生成模拟世界 → 启动模拟接口 → 用真实的抓取脚本抓取 → 处理 → 输出到 web/data
 *   npm run demo              # 约 1–2 分钟
 *   npm run demo -- --regen   # 重新生成模拟世界
 * 这条流程和真实数据完全一致，只是把 12306 / Overpass 换成了本地模拟接口。
 */
import { fork, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, parseArgs, log, exists } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2), { days: '3', port: '8931' });
const RAW = path.join(ROOT, 'data/raw-demo');
const WORLD = path.join(ROOT, 'data/mock/world.json.gz');

function run(script, argv, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--max-old-space-size=4096', path.join(ROOT, script), ...argv], { stdio: 'inherit', env: { ...process.env, ...env } });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} 退出码 ${code}`))));
  });
}

async function main() {
  if (!exists(WORLD) || args.regen) {
    log('① 生成模拟世界…');
    await run('scripts/mock/generate.mjs', []);
  } else log('① 已有模拟世界（--regen 可重新生成）');
  if (args.clean !== false) fs.rmSync(RAW, { recursive: true, force: true });

  log('② 启动模拟接口…');
  const server = fork(path.join(ROOT, 'scripts/mock/server.mjs'), ['--port', args.port], {
    env: { ...process.env, MOCK_FAULTS: process.env.MOCK_FAULTS ?? '0.01' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  await new Promise((resolve, reject) => {
    server.on('message', (m) => m?.ready && resolve());
    server.on('exit', (c) => reject(new Error('模拟接口启动失败 ' + c)));
  });
  const base = `http://127.0.0.1:${args.port}`;
  try {
    log('③ 抓取铁路线（模拟 Overpass）…');
    await run('scripts/fetch-osm.mjs', ['--overpass', `${base}/api/interpreter`, '--out', path.join(RAW, 'osm'), '--interval', '0']);
    log('④ 抓取车站、车次与时刻（模拟 12306）…');
    await run('scripts/fetch-12306.mjs', ['--kyfw', base, '--search', base, '--www', base, '--out', path.join(RAW, '12306'),
      '--days', args.days, '--interval', '0', '--concurrency', '16', '--search-concurrency', '12']);
  } finally {
    server.kill();
  }
  log('⑤ 处理数据…');
  await run('scripts/build.mjs', ['--raw', RAW, '--source', 'demo', '--report', path.join(ROOT, 'data/build-report-demo.json')]);
  log('演示数据已生成。运行 npm start，然后打开 http://localhost:8080');
}

main().catch((e) => { console.error('\n演示数据生成失败：', e.message); process.exit(1); });
