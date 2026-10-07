#!/usr/bin/env node
// Reject incomplete daily lists before replacing the website's existing snapshot.
import path from 'node:path';
import { ROOT, dateRange, todayCST, exists, readJSON, parseArgs } from '../lib/util.mjs';
import { isCompleteList } from '../lib/window.mjs';

const dir = path.join(ROOT, 'data/raw/12306/trains');
const args = parseArgs(process.argv.slice(2), { start: todayCST(), days: '7' });
const days = Number(args.days);
if (!Number.isInteger(days) || days < 1 || days > 15) throw new Error('--days 必须为 1..15');
const errors = [];
for (const date of dateRange(args.start, days)) {
  const file = path.join(dir, `${date}.json`);
  if (!exists(file)) {
    errors.push(`${date}：尚未抓取完成`);
    continue;
  }
  const list = readJSON(file);
  if (!isCompleteList(list, date)) {
    errors.push(`${date}：车次列表为空、日期不符或存在未完成的查询`);
  }
}
if (errors.length) {
  console.error(`本次更新未完成，保留网站原有数据。\n${errors.join('\n')}\n稍后重新运行 npm run update:data 可从断点继续。`);
  process.exitCode = 1;
} else {
  console.log(`${args.start} 起 ${days} 天车次列表完整，开始构建网站数据。`);
}
