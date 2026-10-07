#!/usr/bin/env node
// One slow batch, followed by a validated publication and an optional next run.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, parseArgs, todayCST, readJSON, writeJSON } from './lib/util.mjs';
import { inspectWindow } from './lib/window.mjs';

const args = parseArgs(process.argv.slice(2), {
  start: todayCST(), days: '15', interval: '5000', timetableBatch: '300',
});
const days = Number(args.days), interval = Number(args.interval), limit = Number(args.timetableBatch);
if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start) || !Number.isInteger(days) || days < 1 || days > 15 ||
    !Number.isInteger(interval) || interval < 1000 || interval > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
  throw new Error('日期窗口须为 1..15 天，间隔须为 1000..10000ms，时刻批次须为 1..1000。');
}
const railDir = path.join(ROOT, 'data/raw/12306');
const options = { start: args.start, days };
const before = inspectWindow(railDir, options);
if (args.plan) {
  console.log(JSON.stringify({ ...before, missingTimetables: before.missingTimetables.length, retryableTimetables: before.retryableTimetables.length }, null, 2));
  process.exit(0);
}
const env = { ...process.env, NODE_USE_ENV_PROXY: '0' };
for (const key of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(key)) delete env[key];
const directArgs = Number(process.versions.node.split('.')[0]) >= 24 ? ['--no-use-env-proxy'] : [];
const run = (...command) => {
  const result = spawnSync(process.execPath, [...directArgs, ...command], { cwd: ROOT, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command.join(' ')} 未完成，网站保留原有快照。`);
};
console.log(`滚动窗口 ${before.start} ~ ${before.end}；已完成 ${before.availableDates.length}/${days} 天，本批最多补 1 天、${limit} 个时刻。`);
const nextDate = before.missingDates[0];
if (nextDate) {
  const file = path.join(railDir, 'trains', `${nextDate}.json`);
  let refresh = false;
  if (fs.existsSync(file)) {
    try {
      const cached = readJSON(file);
      refresh = !cached.incomplete || !cached.failedKeywords?.length;
    } catch { refresh = true; }
  }
  run('scripts/fetch-12306.mjs', '--start', nextDate, '--days', '1', '--steps', 'list', '--interval', String(interval), '--search-concurrency', '1', ...(refresh ? ['--refresh-list'] : []));
  run('scripts/tools/check-update.mjs', '--start', nextDate, '--days', '1');
}
run('scripts/fetch-12306.mjs', '--start', args.start, '--days', String(days), '--steps', 'timetable',
  '--interval', String(interval), '--concurrency', '1', '--sample', String(limit), '--retry-missing', 'daily');
const state = inspectWindow(railDir, options);
if (!state.availableDates.length) throw new Error('窗口内尚无完整日期，停止发布。');
const stageRoot = path.join(ROOT, 'data/backups');
fs.mkdirSync(stageRoot, { recursive: true });
const stage = fs.mkdtempSync(path.join(stageRoot, 'window-'));
run('--max-old-space-size=6144', 'scripts/build.mjs', '--out', stage, '--report', path.join(stage, 'build-report.json'),
  '--max-dates', String(days), '--date-start', state.start, '--date-end', state.end);
run('scripts/tools/check-data.mjs', '--data', stage);
fs.mkdirSync(path.join(stage, 'previous'));
for (const name of ['network', 'stations', 'trains', 'paths', 'meta']) {
  const target = path.join(ROOT, 'web/data', `${name}.json`);
  if (fs.existsSync(target)) fs.copyFileSync(target, path.join(stage, 'previous', `${name}.json`));
  fs.copyFileSync(path.join(stage, `${name}.json`), target + '.tmp');
  fs.renameSync(target + '.tmp', target);
}
const status = {
  ...state, missingTimetables: state.missingTimetables.length, retryableTimetables: state.retryableTimetables.length,
  unavailableCodes: state.missingTimetables.map(t => t.code), updatedAt: new Date().toISOString(),
};
writeJSON(path.join(railDir, 'window-status.json'), status, { pretty: true });
const needsContinue = state.missingDates.length > 0 || state.retryableTimetables.length > 0;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
  `needs_continue=${needsContinue}\ncovered=${state.availableDates.length}\nwindow_start=${state.start}\nwindow_end=${state.end}\n`);
const meta = readJSON(path.join(stage, 'meta.json'));
const summary = `Window: ${state.start} — ${state.end}\n\nComplete daily lists: ${state.availableDates.length}/${days}\n\n` +
  `Remaining dates: ${state.missingDates.join(', ') || 'none'}\n\nMissing timetables: ${state.missingTimetables.length}; eligible for next batch: ${state.retryableTimetables.length}\n\n` +
  `Unavailable codes (first 30): ${status.unavailableCodes.slice(0, 30).join(', ') || 'none'}\n\nGenerated: ${meta.generatedAt}\n`;
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
console.log(needsContinue ? '缓存已保存，本批校验通过；仍需继续补齐。' : '未来窗口已补齐；未提供时刻的车次次日再试。');
