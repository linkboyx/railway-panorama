// 12306 数据解析：车站表、车次类型、时刻表（兼容 queryTrainInfo 与 queryByTrainNo 两种返回格式）

export const normalizeName = (s) => String(s ?? '').replace(/\s+/g, '').trim();

/**
 * 解析 station_name.js
 * 格式：var station_names ='@bjb|北京北|VAP|beijingbei|bjb|0|0357|北京|||@bjd|北京东|...';
 * 每 10 个字段为一个车站：id|名称|电报码|全拼|简拼|序号|城市代码|城市名|r1|r2
 */
export function parseStationNameJS(text) {
  let raw = text;
  const m = text.match(/station_names\s*=\s*'([^']*)'/) || text.match(/station_names\s*=\s*"([^"]*)"/);
  if (m) raw = m[1];
  const out = [];
  const seen = new Set();
  // 按 '@' 切分比按固定 10 字段更稳健（字段数量将来可能变化）
  for (const chunk of raw.split('@')) {
    if (!chunk.trim()) continue;
    const f = chunk.split('|');
    const name = normalizeName(f[1]);
    const tele = (f[2] || '').trim();
    if (!name || !/^[A-Z]{3}$/.test(tele) || seen.has(tele)) continue;
    seen.add(tele);
    out.push({ id: '@' + (f[0] || ''), name, tele, py: f[3] || '', abbr: f[4] || f[0] || '', city: normalizeName(f[7] || '') });
  }
  return out;
}

/** 车次类型：G 高速 / C 城际 / D 动车 / Z 直达 / T 特快 / K 快速 / S 市域 / Y 旅游 / L 临客 / O 其他（普快普客） */
export function trainClassOf(code) {
  const c = String(code || '').toUpperCase().charAt(0);
  if ('GCDZTKSYL'.includes(c) && c) return c;
  return 'O';
}

const hm = (s) => {
  const m = String(s ?? '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * 解析经停站列表 rows（12306 返回的 data.data 数组）。
 * 返回 { stops: [{name, arr, dep, code}], codes, className, warnings }
 * arr/dep 为相对始发日 0 点的分钟数（可超过 1440）。
 */
export function parseTimetable(rows) {
  const warnings = [];
  if (!Array.isArray(rows) || rows.length < 2) return { stops: [], codes: [], className: '', warnings: ['经停站少于 2 个'] };
  const first = rows[0] || {};
  const stops = [];
  let prev = -Infinity;
  const dep0 = hm(first.start_time);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = normalizeName(r.station_name);
    let a = hm(r.arrive_time);
    let d = hm(r.start_time);
    if (i === 0) a = d;
    if (i === rows.length - 1 && d === null) d = a;
    if (a === null && d !== null) a = d;
    if (d === null && a !== null) d = a;
    if (a === null) { warnings.push(`${name} 无时刻`); continue; }
    // 到达：优先使用 arrive_day_diff（第几天到达），其次用 running_time（累计运行时间）校正，最后按单调递增推断跨日
    let arr = null;
    const diff = r.arrive_day_diff !== undefined && r.arrive_day_diff !== '' ? Number(r.arrive_day_diff) : NaN;
    if (i > 0 && Number.isFinite(diff) && diff >= 0 && diff < 8) {
      // 以 arrive_day_diff 为准；若比上一站发车还早（数据小误差），钳到上一站发车时刻
      const cand = a + diff * 1440;
      if (cand >= prev) arr = cand;
      else if (prev - cand < 180) { arr = prev; warnings.push(`${name} 到达时刻早于上一站发车，已修正`); }
    }
    if (arr === null && i > 0 && dep0 !== null) {
      const rtm = String(r.running_time || '').match(/^(\d+):(\d{2})$/);
      const rt = rtm ? Number(rtm[1]) * 60 + Number(rtm[2]) : null;
      if (rt !== null && rt > 0) {
        const expected = dep0 + rt;
        const k = Math.round((expected - a) / 1440);
        const cand = a + Math.max(0, k) * 1440;
        if (cand >= prev && Math.abs(cand - expected) <= 90) arr = cand;
      }
    }
    if (arr === null) {
      arr = a;
      while (arr < prev) arr += 1440;
      // 倒退不到 3 小时视为数据误差（而不是跨日），避免后续所有站平白多出一天
      if (arr - 1440 > prev - 180 && arr - 1440 < prev) { warnings.push(`${name} 时刻倒退，已修正`); arr = prev; }
    }
    let dep = arr + ((d - a + 1440) % 1440);
    if (i === 0) { arr = d; dep = d; }
    // 终到站的“开车时间”没有意义（12306 常返回比到达还早的值，会被当成停站将近一天）
    if (i === rows.length - 1) dep = arr;
    if (dep - arr > 12 * 60) warnings.push(`${name} 停站 ${dep - arr} 分钟，异常`);
    prev = dep;
    stops.push({ name, arr, dep, code: String(r.station_train_code || first.station_train_code || '').trim() });
  }
  const codes = [];
  for (const s of stops) if (s.code && !codes.includes(s.code)) codes.push(s.code);
  return { stops, codes, className: first.train_class_name || '', warnings };
}

/** 经停时刻缓存文件名：macOS 默认文件系统不区分大小写，小写字母前加 _ 以免 train_no 冲突 */
export const timetableFileName = (no) => String(no).replace(/[^A-Za-z0-9-]/g, '-').replace(/[a-z]/g, (c) => '_' + c) + '.json';

/** 从 12306 搜索接口返回中提取车次列表 */
export function parseSearchResult(json, keyword) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const kw = String(keyword || '').toUpperCase();
  return rows
    .filter((r) => r && r.station_train_code && r.train_no)
    .map((r) => ({
      code: String(r.station_train_code).trim().toUpperCase(),
      no: String(r.train_no).trim(),
      from: normalizeName(r.from_station),
      to: normalizeName(r.to_station),
      total: Number(r.total_num) || 0,
    }))
    .filter((r) => !kw || r.code.startsWith(kw));
}
