#!/usr/bin/env node
import { HttpClient } from '../lib/http.mjs';
import { todayCST, compactDate } from '../lib/util.mjs';
import { parseSearchResult, parseTimetable } from '../lib/rail12306.mjs';

const date = todayCST();
const http = new HttpClient({ name: '12306 connectivity', minIntervalMs: 3000, retries: 1, timeoutMs: 20000 });
const json = await http.getJSON(`https://search.12306.cn/search/v1/train/search?keyword=G1&date=${compactDate(date)}`);
const trains = parseSearchResult(json, 'G1');
const train = trains.find(t => t.code === 'G1');
if (!train) throw new Error('GitHub 运行器无法取得当天 G1 车次，停止更新');
const timetable = await http.getJSON(`https://kyfw.12306.cn/otn/queryTrainInfo/query?leftTicketDTO.train_no=${encodeURIComponent(train.no)}&leftTicketDTO.train_date=${date}&rand_code=`);
const parsed = parseTimetable(timetable.data?.data);
if (parsed.stops.length < 2) throw new Error('GitHub 运行器无法取得 G1 时刻，停止更新');
console.log(`直连自检通过：${date} G1，${parsed.stops.length} 个经停站。`);
