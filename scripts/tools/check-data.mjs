#!/usr/bin/env node
// 数据自检：用前端同一套模型代码检查每个车次在各停站时刻的位置是否落在车站附近
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, parseArgs } from '../lib/util.mjs';
import { Model, haversine, dayStartMs, dayNumOf } from '../../web/js/model.js';

const args = parseArgs(process.argv.slice(2), { data: path.join(ROOT, 'web/data'), sample: '0' });
const load = (n) => JSON.parse(fs.readFileSync(path.join(args.data, n + '.json'), 'utf8'));
const t0 = Date.now();
const m = new Model({ meta: load('meta'), network: load('network'), stations: load('stations'), trains: load('trains'), paths: load('paths') });
console.log(`模型加载 ${Date.now() - t0} ms：车次 ${m.trains.length}，车站 ${m.stations.length}，边 ${m.edges.length}，区段 ${m.segs.length}`);
let checked = 0; let bad = 0; let nan = 0; const errs = [];
const list = Number(args.sample) ? m.trains.filter((_, i) => i % Math.ceil(m.trains.length / Number(args.sample)) === 0) : m.trains;
for (const t of list) {
  if (!t.drawable) continue;
  for (let k = t.anchors[0]; k <= t.anchors[t.anchors.length - 1]; k++) {
    const s = m.stations[t.st[k]];
    const st = m.state(t, t.arr[k] < t.t0 ? t.t0 : t.arr[k]);
    if (!st) { bad++; errs.push(`${t.code} 在 ${s.name} 无位置`); continue; }
    if (!Number.isFinite(st.lon) || !Number.isFinite(st.lat)) { nan++; continue; }
    checked++;
    const d = haversine(st.lon, st.lat, s.lon, s.lat);
    const tol = s.flag === 1 ? 4500 : 60000;
    if (d > tol) { bad++; if (errs.length < 20) errs.push(`${t.code} ${s.name}：偏离 ${(d / 1000).toFixed(1)} km（flag ${s.flag}）`); }
  }
  // 中途随机时刻
  for (let q = 0; q < 5; q++) {
    const rel = t.t0 + Math.random() * (t.t1 - t.t0);
    const st = m.state(t, rel);
    if (!st || !Number.isFinite(st.lon)) { nan++; if (errs.length < 40) errs.push(`${t.code} rel=${rel.toFixed(1)} 无效位置`); }
  }
}
const day = m.dayNums[0];
const runs = m.activeRuns(dayStartMs(day) + 10 * 3600e3);
console.log(`检查停站位置 ${checked} 个，偏离过大 ${bad}，无效 ${nan}；${m.dates[0]} 10:00 在途车次 ${runs.length}`);
if (errs.length) console.log(errs.slice(0, 30).join('\n'));
process.exitCode = bad + nan > checked * 0.01 ? 1 : 0;
