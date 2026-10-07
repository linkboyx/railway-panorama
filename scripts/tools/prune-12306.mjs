#!/usr/bin/env node
// Keep the same most recent 14 daily lists used by the website build.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON } from '../lib/util.mjs';
import { timetableFileName } from '../lib/rail12306.mjs';

const root = path.join(ROOT, 'data/raw/12306');
const trainDir = path.join(root, 'trains');
const timetableDir = path.join(root, 'timetable');
const dryRun = process.argv.includes('--dry-run');
const files = fs.readdirSync(trainDir).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
const keep = files.slice(-14);
if (!keep.length) throw new Error('无完整车次列表，停止清理缓存');
const names = new Set();
for (const file of keep) {
  for (const train of readJSON(path.join(trainDir, file)).trains) names.add(timetableFileName(train.no));
}
const expiredDates = files.slice(0, -14);
const expiredTimetables = fs.readdirSync(timetableDir).filter(n => /^[-A-Za-z0-9_]+\.json$/.test(n) && !names.has(n));
if (!dryRun) {
  for (const file of expiredDates) fs.unlinkSync(path.join(trainDir, file));
  for (const file of expiredTimetables) fs.unlinkSync(path.join(timetableDir, file));
  const metaFile = path.join(root, 'meta.json');
  if (fs.existsSync(metaFile)) {
    const meta = readJSON(metaFile);
    meta.dates = keep.map(n => n.slice(0, 10));
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  }
}
console.log(`${dryRun ? '预计清理' : '已清理'}：${expiredDates.length} 个旧日期、${expiredTimetables.length} 个过期时刻；保留 ${keep.length} 个日期。`);
