// 读取 12306 原始数据：车站表、每日车次列表、经停时刻
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, log, warn, naturalCompare } from '../lib/util.mjs';
import { parseTimetable, trainClassOf, normalizeName, timetableFileName } from '../lib/rail12306.mjs';

export function loadRail(dir, { maxDates = 14 } = {}) {
  const stFile = path.join(dir, 'stations.json');
  if (!fs.existsSync(stFile)) throw new Error(`没有找到车站表：${stFile}（请先运行 npm run fetch:12306）`);
  const stationList = readJSON(stFile);
  // 每日车次列表 → train_no 的开行日期
  const trainDir = path.join(dir, 'trains');
  const dates = [];
  const runDates = new Map(); // no -> Set(date)
  const listInfo = new Map(); // no -> {codes:Set, from, to}
  if (fs.existsSync(trainDir)) {
    // 只用最近 maxDates 天（多次抓取后旧日期会累积）
    const files = fs.readdirSync(trainDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().slice(-maxDates);
    for (const f of files) {
      const date = f.slice(0, 10);
      const j = readJSON(path.join(trainDir, f));
      if (!j.trains?.length) continue;
      dates.push(date);
      for (const t of j.trains) {
        if (!runDates.has(t.no)) runDates.set(t.no, new Set());
        runDates.get(t.no).add(date);
        if (!listInfo.has(t.no)) listInfo.set(t.no, { codes: new Set(), from: t.from, to: t.to });
        listInfo.get(t.no).codes.add(t.code);
      }
    }
  }
  if (!dates.length) throw new Error('没有找到任何日期的车次列表（data/raw/12306/trains/）');
  // 经停时刻
  const ttDir = path.join(dir, 'timetable');
  const trains = [];
  let bad = 0; let noTimetable = 0;
  const warnings = [];
  for (const [no, dset] of runDates) {
    const f = path.join(ttDir, timetableFileName(no));
    if (!fs.existsSync(f)) { noTimetable++; continue; }
    const raw = readJSON(f);
    const tt = parseTimetable(raw.rows);
    if (tt.stops.length < 2) { bad++; continue; }
    const span = tt.stops[tt.stops.length - 1].arr - tt.stops[0].dep;
    if (span <= 0 || span > 6 * 1440) { bad++; warnings.push(`${raw.code} 运行时长异常（${span} 分钟）`); continue; }
    // 相邻重复站去重
    const stops = [];
    for (const s of tt.stops) {
      if (stops.length && stops[stops.length - 1].name === s.name) { stops[stops.length - 1].dep = s.dep; continue; }
      stops.push(s);
    }
    const info = listInfo.get(no);
    const codes = tt.codes.length ? tt.codes : [...info.codes];
    for (const c of info.codes) if (!codes.includes(c)) codes.push(c);
    const code = codes[0] || raw.code;
    trains.push({
      no, code, codes, cls: trainClassOf(code), className: tt.className,
      stops, dates: [...dset].sort(),
    });
    if (tt.warnings.length && warnings.length < 200) warnings.push(`${code}: ${tt.warnings.join('; ')}`);
  }
  trains.sort((a, b) => naturalCompare(a.code, b.code) || a.stops[0].dep - b.stops[0].dep);
  log(`12306：${dates.length} 天（${dates[0]} ~ ${dates[dates.length - 1]}），车次 ${trains.length}` +
    `，缺少时刻 ${noTimetable}，数据异常 ${bad}`);
  if (noTimetable) warn(`${noTimetable} 个车次没有经停数据，可重新运行 npm run fetch:12306 补抓`);
  return { stationList, dates, trains, warnings };
}

export { normalizeName };
