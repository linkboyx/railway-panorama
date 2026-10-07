import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ROOT, addDays, dateRange, todayCST, writeJSON, readJSON } from '../lib/util.mjs';
import { inspectWindow } from '../lib/window.mjs';
import { loadRail } from '../build/timetables.mjs';

function fixture(t) {
  const parent = path.join(ROOT, 'data/backups');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'test-window-'));
  fs.mkdirSync(path.join(dir, 'trains'));
  fs.mkdirSync(path.join(dir, 'timetable'));
  writeJSON(path.join(dir, 'stations.json'), [{ name: '甲', tele: 'AAA' }, { name: '乙', tele: 'BBB' }]);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(parent));
    fs.rmSync(dir, { recursive: true });
  });
  return dir;
}
const train = (no = 'A', code = 'G1') => ({ no, code, from: '甲', to: '乙' });
function list(dir, date, trains = [train()], extra = {}) {
  writeJSON(path.join(dir, 'trains', date + '.json'), { date, trains, incomplete: false, ...extra });
}
const rows = [
  { station_name: '甲', station_no: '01', arrive_time: '----', start_time: '08:00', station_train_code: 'G1', train_class_name: '高速' },
  { station_name: '乙', station_no: '02', arrive_time: '09:00', start_time: '----', station_train_code: 'G1', arrive_day_diff: '0' },
];

test('15-day coverage includes day 14; tomorrow needs only the newly added day', t => {
  const dir = fixture(t), start = '2026-10-07';
  for (const date of dateRange(start, 15)) list(dir, date);
  let state = inspectWindow(dir, { start, retryDay: start });
  assert.equal(state.availableDates.length, 15);
  assert.equal(state.end, '2026-10-21');
  assert.deepEqual(state.missingDates, []);
  assert.equal(state.missingTimetables.length, 1, 'one shared train_no requires one timetable, not 15');
  state = inspectWindow(dir, { start: addDays(start, 1) });
  assert.deepEqual(state.missingDates, ['2026-10-22']);
  assert.equal(state.availableDates.length, 14);
});

test('incomplete, truncated and damaged caches remain pending and cannot enter a build', t => {
  const dir = fixture(t), start = '2026-10-07';
  list(dir, start, [train()], { incomplete: true, failedKeywords: ['G1'] });
  list(dir, addDays(start, 1), [train()], { truncatedKeywords: ['G2'] });
  fs.writeFileSync(path.join(dir, 'trains', addDays(start, 2) + '.json'), '{broken');
  list(dir, addDays(start, 3));
  const state = inspectWindow(dir, { start, days: 4 });
  assert.deepEqual(state.availableDates, ['2026-10-10']);
  assert.deepEqual(state.missingDates, ['2026-10-07', '2026-10-08', '2026-10-09']);
});

test('missing timetables are retried once per Beijing date and cached successes are reused', t => {
  const dir = fixture(t), start = '2026-10-07';
  list(dir, start, [train('A'), train('B', 'G2')]);
  writeJSON(path.join(dir, 'timetable-retries.json'), { A: start });
  let state = inspectWindow(dir, { start, days: 1, retryDay: start });
  assert.deepEqual(state.retryableTimetables.map(t => t.no), ['B']);
  writeJSON(path.join(dir, 'timetable/B.json'), { rows });
  state = inspectWindow(dir, { start, days: 1, retryDay: start });
  assert.equal(state.retryableTimetables.length, 0);
  assert.equal(state.missingTimetables.length, 1);
  state = inspectWindow(dir, { start, days: 1, retryDay: addDays(start, 1) });
  assert.deepEqual(state.retryableTimetables.map(t => t.no), ['A']);
});

test('build preserves all 15 requested dates and excludes dates outside the window or incomplete lists', t => {
  const dir = fixture(t), start = '2026-10-07', end = addDays(start, 14);
  for (const date of dateRange(addDays(start, -1), 17)) list(dir, date);
  writeJSON(path.join(dir, 'timetable/A.json'), { rows, code: 'G1' });
  let rail = loadRail(dir, { dateStart: start, dateEnd: end });
  assert.deepEqual(rail.dates, dateRange(start, 15));
  assert.equal(rail.trains[0].dates.length, 15);
  list(dir, addDays(start, 2), [train()], { incomplete: true });
  rail = loadRail(dir, { dateStart: start, dateEnd: end });
  assert.equal(rail.dates.length, 14);
  assert.ok(!rail.dates.includes(addDays(start, 2)));
});

test('actual fetch batches advance past unavailable trains, reuse successes, and retry on the next day', { timeout: 30000 }, async t => {
  const dir = fixture(t), start = todayCST(), requested = [];
  list(dir, start, [train('A'), train('B', 'G2')]);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.includes('/queryTrainInfo/query') || url.pathname.includes('/czxx/queryByTrainNo')) {
      const no = url.searchParams.get('leftTicketDTO.train_no') || url.searchParams.get('train_no');
      requested.push(no);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { data: no === 'A' ? null : rows } }));
    } else res.end('<html>local test</html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/fetch-12306.mjs'), '--out', dir,
      '--start', start, '--days', '1', '--steps', 'timetable', '--sample', '1', '--retry-missing', 'daily', '--interval', '0'],
    { env: { ...process.env, KYFW_BASE: base, SEARCH_BASE: base, WWW_BASE: base, NODE_USE_ENV_PROXY: '0' } });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(output)));
  });
  await run();
  assert.equal(readJSON(path.join(dir, 'timetable-retries.json')).A, todayCST());
  assert.ok(!fs.existsSync(path.join(dir, 'timetable/A.json')));
  assert.ok(requested.includes('A'));
  requested.length = 0;
  await run();
  assert.deepEqual(requested, ['B']);
  assert.ok(fs.existsSync(path.join(dir, 'timetable/B.json')));
  requested.length = 0;
  await run();
  assert.deepEqual(requested, []);
  writeJSON(path.join(dir, 'timetable-retries.json'), { A: addDays(todayCST(), -1) });
  await run();
  assert.ok(requested.includes('A'));
});
