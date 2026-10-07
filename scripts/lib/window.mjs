import fs from 'node:fs';
import path from 'node:path';
import { dateRange, readJSON, todayCST } from './util.mjs';
import { timetableFileName } from './rail12306.mjs';

export function isCompleteList(list, date) {
  return list?.date === date && Array.isArray(list.trains) && list.trains.length > 0 &&
    !list.incomplete && !list.failedKeywords?.length && !list.truncatedKeywords?.length;
}

export function inspectWindow(dir, { start = todayCST(), days = 15, retryDay = todayCST() } = {}) {
  const dates = dateRange(start, days);
  const availableDates = [], missingDates = [], trains = new Map();
  for (const date of dates) {
    const file = path.join(dir, 'trains', `${date}.json`);
    let list;
    if (fs.existsSync(file)) {
      try { list = readJSON(file); } catch { /* Treat damaged cache as missing. */ }
    }
    if (!isCompleteList(list, date)) { missingDates.push(date); continue; }
    availableDates.push(date);
    for (const train of list.trains) if (!trains.has(train.no)) trains.set(train.no, train);
  }
  const ledgerFile = path.join(dir, 'timetable-retries.json');
  const ledger = fs.existsSync(ledgerFile) ? readJSON(ledgerFile) : {};
  const missingTimetables = [...trains.values()].filter(t => !fs.existsSync(path.join(dir, 'timetable', timetableFileName(t.no))));
  const retryableTimetables = missingTimetables.filter(t => ledger[t.no] !== retryDay);
  return { start, end: dates.at(-1), days, availableDates, missingDates, missingTimetables, retryableTimetables };
}
