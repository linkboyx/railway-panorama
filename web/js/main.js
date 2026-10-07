// 中国铁路全景 —— 主程序
/* global maplibregl */
import { loadModel, loadBasemap } from './data.js';
import { buildStyle, railGeoJSON, stationsGeoJSON, setRailMode, trainColor, THEMES } from './map.js';
import { TrainLayers } from './trains.js';
import {
  cst, dayStartMs, dayNumOf, dateOfDayNum, fmtClock, WEEKDAYS, TRAIN_CLASSES, haversine, DAY,
} from './model.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CLASS_ORDER = ['G', 'D', 'C', 'Z', 'T', 'K', 'O', 'S', 'Y', 'L'];
const SPEEDS = [1, 10, 60, 300, 1200, 3600];
const PLAYBACK_SPEEDS = [60, 240, 900];
const LABEL_PRIORITY = { G: 9, D: 8, C: 6, Z: 7, T: 6, K: 5, O: 3, S: 3, Y: 2, L: 2 };

const store = (() => { try { return window.localStorage; } catch { return null; } })();
const pref = (k, d) => { try { return store?.getItem('rp-' + k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { store?.setItem('rp-' + k, v); } catch { /* 无痕模式等 */ } };

const state = {
  T: Date.now(), playing: true, speed: 1, live: true,
  sel: null,            // { t, day }
  follow: false, playbackOf: null, playbackSpeed: 240,
  station: null,        // 车站下标
  filters: Object.fromEntries(CLASS_ORDER.map((c) => [c, true])),
  theme: document.documentElement.dataset.theme || 'dark',
  traffic: false, labels: pref('labels', '1') === '1',
  dirty: true,
};
let model; let map; let trains; let basemap;
let frame = { n: 0, pos: new Float32Array(0), ang: new Float32Array(0), col: new Uint8Array(0), runs: [] };
let counts = {};
let hoverRun = null;
let lastTrainClick = 0;

// ---------------- 启动 ----------------
async function init() {
  try {
    [model, basemap] = await Promise.all([
      loadModel('data/', ({ label, mb }) => { $('#loading-text').textContent = `${label} ${mb ? mb.toFixed(1) + ' MB' : ''}`; }),
      loadBasemap('data/basemap/'),
    ]);
  } catch (e) {
    console.error(e);
    $('#loading').innerHTML = `<div class="err"><b>数据加载失败</b><br>${esc(e.message)}<br><br>
      请先生成数据：演示数据运行 <code>npm run demo</code>，真实数据依次运行
      <code>npm run fetch:osm</code>、<code>npm run fetch:12306</code>、<code>npm run build</code>，
      然后用 <code>npm start</code> 启动本地服务器访问（不能直接双击打开 index.html）。</div>`;
    return;
  }
  const meta = model.meta;
  const range = `${meta.dates[0].slice(5).replace('-', '/')}–${meta.dates[meta.dates.length - 1].slice(5).replace('-', '/')}`;
  $('#data-badge').innerHTML = (meta.source === 'demo' ? '<span class="badge-demo">演示数据</span>' : '') +
    `${model.trains.length.toLocaleString()} 个车次 · 时刻 ${range}`;
  if (meta.source === 'demo') $('#data-badge').title = '演示数据：线路走向与时刻为程序生成，仅用于展示功能。运行 npm run fetch:osm / fetch:12306 / build 生成真实数据。';

  map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(state.theme, basemap),
    bounds: [[73.5, 17.8], [135, 53.6]],
    fitBoundsOptions: { padding: window.innerWidth < 720 ? { top: 90, bottom: 150, left: 10, right: 10 } : { top: 40, bottom: 130, left: 60, right: 250 } },
    minZoom: 2.5, maxZoom: 16,
    localIdeographFontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif',
    attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: meta.source === 'demo'
      ? '演示数据（模拟生成） · 底图：cn-atlas、Natural Earth'
      : '线路 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 贡献者 · 时刻：12306 · 底图：cn-atlas、Natural Earth',
  }), 'bottom-right');
  map.on('load', onMapLoad);
}

function onMapLoad() {
  setMapData();
  trains = new TrainLayers(map, {
    onHover: onTrainHover,
    onClick: (r) => { lastTrainClick = performance.now(); selectTrain(r.t, r.day, { fly: false }); },
  });
  buildTimebar(); buildStats(); bindSearch(); bindKeys(); bindMapEvents();
  $('#btn-od').addEventListener('click', () => openOd({ run: false }));
  applyHash();
  requestAnimationFrame(loop);
  $('#loading').classList.add('fade');
  setTimeout(() => $('#loading').remove(), 500);
}

function setMapData() {
  map.getSource('rail').setData(railGeoJSON(model));
  map.getSource('stations').setData(stationsGeoJSON(model));
  if (state.traffic) setRailMode(map, state.theme, true);
  updateRouteLayer(true);
}

// ---------------- 主循环 ----------------
let lastTs = 0; let lastTrainDraw = 0; let lastUi = 0;
function loop(ts) {
  const dt = lastTs ? Math.min(ts - lastTs, 250) : 16;
  lastTs = ts;
  if (state.playing) {
    if (state.live) state.T = Date.now();
    else state.T += dt * state.speed;
  }
  // 回放到终点自动暂停
  if (state.playbackOf && state.sel && state.playbackOf === state.sel.t && state.playing) {
    const { t, od: leg } = state.sel;
    const rel = (state.T - dayStartMs(state.sel.day)) / 60000;
    const endK = leg ? leg.kb : t.n - 1;
    if (rel > (leg ? t.arr[endK] : t.end) + 0.5) {
      state.playing = false; state.playbackOf = null; state.dirty = true;
      toast(`${t.code} 已到达${leg ? '' : '终点'} ${model.stations[t.st[endK]].name}`);
    }
  }
  const zoom = map.getZoom();
  const mpp = 156543 * Math.cos((map.getCenter().lat * Math.PI) / 180) / 2 ** zoom; // 米/像素
  const pxPerSec = (90 * (state.playing ? state.speed : 0)) / mpp;
  const interval = state.sel ? 33 : Math.min(1000, Math.max(16, 500 / Math.max(pxPerSec, 0.01)));
  if (state.dirty || ts - lastTrainDraw >= interval) {
    computeFrame(zoom);
    lastTrainDraw = ts;
  }
  if (state.dirty || ts - lastUi > 250) {
    updateClock(); updateStats(); updatePanel();
    lastUi = ts;
  }
  state.dirty = false;
  requestAnimationFrame(loop);
}

function filterFn(t) { return state.filters[t.cls] !== false; }

const perf = { compute: 0 };
function computeFrame(zoom) {
  const tStart = performance.now();
  const runs = model.activeRuns(state.T, filterFn);
  const n = runs.length;
  if (frame.pos.length < n * 2) {
    const cap = Math.ceil(n * 1.3) + 64;
    frame.pos = new Float32Array(cap * 2); frame.ang = new Float32Array(cap); frame.col = new Uint8Array(cap * 4);
  }
  const { pos, ang, col } = frame;
  const out = [];
  counts = {};
  const theme = state.theme;
  const colorCache = {};
  let j = 0;
  for (let i = 0; i < n; i++) {
    const r = runs[i];
    const st = model.state(r.t, r.rel);
    if (!st) continue;
    pos[2 * j] = st.lon; pos[2 * j + 1] = st.lat;
    ang[j] = -st.bearing;
    const c = colorCache[r.t.cls] || (colorCache[r.t.cls] = trainColor(r.t.cls, theme));
    col[4 * j] = c[0]; col[4 * j + 1] = c[1]; col[4 * j + 2] = c[2]; col[4 * j + 3] = 255;
    r.st = st;
    out.push(r);
    counts[r.t.cls] = (counts[r.t.cls] || 0) + 1;
    j++;
  }
  frame.n = j; frame.runs = out;
  // 选中车次
  let sel = null;
  if (state.sel) {
    const { t, day } = state.sel;
    const rel = (state.T - dayStartMs(day)) / 60000;
    const st = model.state(t, rel);
    if (st) {
      sel = { lon: st.lon, lat: st.lat, code: t.code, color: trainColor(t.cls, theme) };
      if (state.follow) map.jumpTo({ center: [st.lon, st.lat] });
    }
    updateRoutePassed(rel);
  }
  // 车次号标签（仅高缩放级别、视野内）；按优先级在屏幕空间避让，避免重叠
  let labels = null;
  if (state.labels && zoom >= 8.2) {
    const b = map.getBounds();
    const w = b.getWest(); const e = b.getEast(); const s = b.getSouth(); const nn = b.getNorth();
    const cands = [];
    for (const r of out) {
      const { lon, lat } = r.st;
      if (lon < w || lon > e || lat < s || lat > nn) continue;
      if (state.sel && r.t === state.sel.t && r.day === state.sel.day) continue;
      cands.push(r);
    }
    cands.sort((a, c) => (LABEL_PRIORITY[c.t.cls] || 0) - (LABEL_PRIORITY[a.t.cls] || 0));
    labels = [];
    const grid = new Map(); const CELL = 64;
    for (const r of cands) {
      const p = map.project([r.st.lon, r.st.lat]);
      const x0 = p.x + 11; const y0 = p.y - 8; const x1 = x0 + r.t.code.length * 7.4 + 4; const y1 = p.y + 8;
      let hit = false;
      const cx0 = Math.floor((x0 - 20) / CELL); const cx1 = Math.floor(x1 / CELL); const cy0 = Math.floor(y0 / CELL); const cy1 = Math.floor(y1 / CELL);
      for (let cx = cx0; cx <= cx1 && !hit; cx++) {
        for (let cy = cy0; cy <= cy1 && !hit; cy++) {
          for (const bx of grid.get(cx * 4096 + cy) || []) { if (x0 < bx[2] && x1 > bx[0] && y0 < bx[3] && y1 > bx[1]) { hit = true; break; } }
        }
      }
      if (hit) continue;
      const box = [x0 - 14, y0, x1, y1];
      for (let cx = Math.floor(box[0] / CELL); cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) { const k = cx * 4096 + cy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(box); }
      labels.push({ lon: r.st.lon, lat: r.st.lat, code: r.t.code });
      if (labels.length >= 400) break;
    }
  }
  trains.render(frame, { zoom, theme, sel, labels });
  if (hoverRun) refreshTooltip();
  perf.compute = perf.compute * 0.9 + (performance.now() - tStart) * 0.1;
}

// ---------------- 时间控制 ----------------
function setTime(ms, { keepPlaying = true } = {}) {
  state.T = ms; state.live = false;
  if (!keepPlaying) state.playing = false;
  state.dirty = true;
  scheduleHash();
}
function goLive() {
  state.live = true; state.playing = true; state.speed = 1; state.T = Date.now(); state.playbackOf = null; state.dirty = true;
  updateSpeedButtons(); scheduleHash();
}
function setSpeed(s) {
  state.speed = s;
  if (s !== 1) state.live = false;
  state.playing = true; state.dirty = true;
  updateSpeedButtons();
}
function togglePlay() {
  state.playing = !state.playing;
  if (state.playing && state.live) state.T = Date.now();
  if (!state.playing) state.live = false;
  state.dirty = true;
}

function buildTimebar() {
  const sp = $('#speeds');
  sp.innerHTML = SPEEDS.map((s) => `<button type="button" data-s="${s}" title="${s}倍速">${s === 1 ? '1×' : s >= 3600 ? '1时/秒' : s >= 60 ? `${s / 60}分/秒` : `${s}×`}</button>`).join('') +
    '<button type="button" data-custom="1" class="hidden"></button>';
  sp.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.dataset.custom) setSpeed(Number(b.dataset.s)); });
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-now').addEventListener('click', goLive);
  $('#btn-back').addEventListener('click', () => setTime(state.T - 3600e3));
  $('#btn-fwd').addEventListener('click', () => setTime(state.T + 3600e3));
  const slider = $('#slider');
  slider.addEventListener('input', () => {
    const c = cst(state.T);
    setTime(dayStartMs(c.dayNum) + Number(slider.value) * 60000 + (c.minutes % 1) * 60000);
  });
  $('#in-date').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const c = cst(state.T);
    setTime(dayStartMs(dayNumOf(e.target.value)) + c.minutes * 60000);
  });
  $('#in-time').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const [h, m] = e.target.value.split(':').map(Number);
    setTime(dayStartMs(cst(state.T).dayNum) + (h * 60 + m) * 60000);
  });
  updateSpeedButtons();
}
function updateSpeedButtons() {
  const custom = !SPEEDS.includes(state.speed);
  document.querySelectorAll('#speeds button').forEach((b) => {
    if (b.dataset.custom) { b.classList.toggle('hidden', !custom); b.textContent = `${state.speed}×`; b.classList.toggle('on', custom); return; }
    b.classList.toggle('on', Number(b.dataset.s) === state.speed);
  });
}

let lastDateStr = '';
function updateClock() {
  const c = cst(state.T);
  $('#clock-time').textContent = fmtClock(c.minutes, true);
  const dateStr = dateOfDayNum(c.dayNum);
  const m = model.mapDay(c.dayNum);
  $('#clock-date').textContent = `${dateStr} 星期${WEEKDAYS[c.weekday]}${m.exact ? '' : ' · 按' + model.dates[m.idx].slice(5) + '时刻推算'}`;
  $('#clock-date').title = m.exact ? '' : `所选日期不在已抓取的时刻表范围内（${model.dates[0]} ~ ${model.dates[model.dates.length - 1]}），按同星期几的时刻显示`;
  if (document.activeElement !== $('#slider')) $('#slider').value = Math.floor(c.minutes);
  if (dateStr !== lastDateStr && document.activeElement !== $('#in-date')) { $('#in-date').value = dateStr; lastDateStr = dateStr; }
  if (document.activeElement !== $('#in-time')) $('#in-time').value = fmtClock(c.minutes);
  const live = state.live && state.playing && Math.abs(state.T - Date.now()) < 5000;
  $('#btn-now').classList.toggle('on', live);
  $('#btn-now').textContent = live ? '实时' : '回到现在';
  $('#ico-play').classList.toggle('hidden', state.playing);
  $('#ico-pause').classList.toggle('hidden', !state.playing);
}

// ---------------- 统计与图例 ----------------
function buildStats() {
  const list = $('#stat-classes');
  list.innerHTML = CLASS_ORDER.map((c) => `<button type="button" class="cls-item" data-c="${c}" title="点击显示/隐藏">
    <span class="cls-dot" data-dot="${c}"></span><span class="cls-name">${c === 'O' ? '普客' : c + ' ' + TRAIN_CLASSES[c].short}</span><span class="cls-count" data-count="${c}">0</span></button>`).join('');
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.cls-item'); if (!b) return;
    const c = b.dataset.c;
    if (e.altKey || e.metaKey) { for (const k of CLASS_ORDER) state.filters[k] = k === c; }
    else state.filters[c] = !state.filters[c];
    document.querySelectorAll('.cls-item').forEach((x) => x.classList.toggle('off', !state.filters[x.dataset.c]));
    state.dirty = true;
  });
  $('#opt-traffic').addEventListener('change', (e) => { state.traffic = e.target.checked; setRailMode(map, state.theme, state.traffic); renderLegend(); });
  $('#opt-labels').checked = state.labels;
  $('#opt-labels').addEventListener('change', (e) => { state.labels = e.target.checked; setPref('labels', state.labels ? '1' : '0'); state.dirty = true; });
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-about').addEventListener('click', showAbout);
  $('#about').addEventListener('click', (e) => { if (e.target.id === 'about' || e.target.closest('[data-close]')) $('#about').classList.add('hidden'); });
  $('#stats .stat-main').addEventListener('click', () => $('#stats').classList.toggle('expanded'));
  paintStatColors(); renderLegend();
}
function paintStatColors() {
  document.querySelectorAll('[data-dot]').forEach((d) => { d.style.background = `rgb(${trainColor(d.dataset.dot, state.theme).join(',')})`; });
  $('#btn-theme').textContent = state.theme === 'dark' ? '切换浅色主题' : '切换深色主题';
  // 没有该类车次时隐藏
  const present = new Set(model.trains.map((t) => t.cls));
  document.querySelectorAll('.cls-item').forEach((x) => x.classList.toggle('hidden', !present.has(x.dataset.c)));
}
function renderLegend() {
  const C = THEMES[state.theme];
  const el = $('#legend-lines');
  if (state.traffic) {
    el.innerHTML = `<div class="legend-line">线路日均通过列车（双向合计）</div>
      <div class="legend-traffic" style="background:linear-gradient(90deg,${C.traffic.join(',')})"></div>
      <div class="legend-traffic-labels"><span>0</span><span>40</span><span>200</span><span>400+</span></div>`;
  } else {
    const rows = [[0, '高速铁路', 3], [1, '快速/城际铁路', 2.5], [2, '普速干线', 2], [3, '普速支线/货运线', 1.5]];
    el.innerHTML = rows.map(([c, name, w]) => `<div class="legend-line"><i style="height:${w}px;background:${C.rail[c]}"></i>${name}</div>`).join('');
  }
}
function updateStats() {
  $('#stat-total').textContent = frame.n.toLocaleString();
  for (const c of CLASS_ORDER) { const el = document.querySelector(`[data-count="${c}"]`); if (el) el.textContent = (counts[c] || 0).toLocaleString(); }
}
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  setPref('theme', state.theme);
  map.setStyle(buildStyle(state.theme, basemap), { diff: false });
  map.once('styledata', () => { setMapData(); state.dirty = true; });
  paintStatColors(); renderLegend();
  if (state.sel) renderTrainPanel();
}

function showAbout() {
  const m = model.meta;
  const demo = m.source === 'demo';
  $('#about-body').innerHTML = `
    ${demo ? '<p><span class="badge-demo">演示数据</span>当前显示的是程序生成的演示数据：车站名称与大致位置取自公开数据集，线路按真实线路途经站平滑连接，车次号取自历史车次表，<b>停站与时刻均为模拟</b>。按 README 运行抓取与构建脚本即可换成真实数据。</p>' : ''}
    <h3>数据范围</h3>
    <p>时刻表日期：${m.dates[0]} ~ ${m.dates[m.dates.length - 1]}（共 ${m.dates.length} 天）；车次 ${m.counts.trains.toLocaleString()} 个，其中可在地图上定位 ${m.counts.drawable.toLocaleString()} 个；车站 ${m.counts.stations.toLocaleString()} 个。
    数据生成于 ${new Date(m.generatedAt).toLocaleString('zh-CN', { hour12: false })}。${m.osmBase ? `路网数据时间 ${m.osmBase.slice(0, 10)}。` : ''}</p>
    <p>选择范围之外的日期时，按“同星期几”的时刻推算。</p>
    <h3>列车位置是怎么算的</h3>
    <p>位置按<b>图定时刻表</b>推算，不是实时 GPS：两站之间沿铁路线的径路插值，并考虑起步加速和进站减速；晚点、停运、临时调整不会反映出来。</p>
    <h3>数据来源</h3>
    <ul>
      <li>铁路线与车站位置：© OpenStreetMap 贡献者（ODbL）</li>
      <li>车次与时刻：中国铁路 12306 公开查询接口</li>
      <li>底图：cn-atlas（省界）、Natural Earth（陆地、河湖）、南海断续线</li>
    </ul>
    <h3>快捷键</h3>
    <p><kbd>空格</kbd> 播放/暂停 · <kbd>←</kbd><kbd>→</kbd> 前后 10 分钟（按住 Shift 为 1 小时） · <kbd>/</kbd> 搜索 · <kbd>Esc</kbd> 关闭面板</p>
    <h3>站到站查询</h3>
    <p>在搜索框输入“北京到上海”，或点顶栏的「站到站」。城市名查询该城市全部车站，车站名（如“北京南站”）只查这一站。结果基于已抓取的时刻表，余票和票价请以 12306 为准。</p>`;
  $('#about').classList.remove('hidden');
}

// ---------------- 搜索 ----------------
let searchCodes = null;
function bindSearch() {
  const input = $('#search'); const dd = $('#search-results');
  searchCodes = [...model.trainByCode.keys()].sort(naturalCompare);
  let items = []; let active = -1;
  const render = () => {
    const q = input.value.trim();
    if (!q) { dd.classList.remove('open'); return; }
    items = searchAll(q);
    active = items.length ? 0 : -1;
    if (!items.length) { dd.innerHTML = '<div class="dd-empty">没有找到匹配的车次或车站</div>'; dd.classList.add('open'); return; }
    let html = ''; let group = '';
    items.forEach((it, i) => {
      if (it.type !== group) { group = it.type; html += `<div class="dd-group">${{ train: '车次', station: '车站', od: '站到站' }[group]}</div>`; }
      html += `<div class="dd-item${i === active ? ' active' : ''}" data-i="${i}" role="option">${it.html}</div>`;
    });
    dd.innerHTML = html; dd.classList.add('open');
  };
  const choose = (i) => {
    const it = items[i]; if (!it) return;
    dd.classList.remove('open'); input.blur();
    if (it.type === 'od') { input.value = ''; openOd({ from: it.a, to: it.b }); return; }
    if (it.type === 'train') selectTrain(it.t, null, { fly: true }); else selectStation(it.s.i, { fly: true });
    input.value = it.type === 'train' ? it.t.code : it.s.name;
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      dd.querySelectorAll('.dd-item').forEach((x) => x.classList.toggle('active', Number(x.dataset.i) === active));
      dd.querySelector('.dd-item.active')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); choose(active < 0 ? 0 : active); }
    else if (e.key === 'Escape') { dd.classList.remove('open'); input.blur(); }
  });
  dd.addEventListener('mousedown', (e) => { const it = e.target.closest('.dd-item'); if (it) { e.preventDefault(); choose(Number(it.dataset.i)); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) dd.classList.remove('open'); });
}

function searchAll(q) {
  const out = [];
  const Q = q.toUpperCase();
  const today = cst(state.T).dayNum;
  // “北京到上海”“bjn shhq”：两端都能精确识别时，给出站到站查询
  const odm = q.match(/^(.+?)\s*(?:到|至|→|->|—|－|-|>|\s)\s*(.+)$/);
  if (odm) {
    const a = resolvePlaceExact(odm[1]); const b = resolvePlaceExact(odm[2]);
    if (a && b && a.key !== b.key) {
      out.push({ type: 'od', a, b, html: `<div class="main"><div class="title">${esc(placeText(a))} → ${esc(placeText(b))}</div>
        <div class="desc">两地之间的直达车次和中转方案</div></div><div class="side">站到站</div>` });
    }
  }
  if (/^[A-Z]?\d{0,5}$/.test(Q) && Q) {
    const hits = [];
    for (const c of searchCodes) {
      if (c === Q) hits.unshift(c); else if (c.startsWith(Q)) hits.push(c);
      if (hits.length >= 40) break;
    }
    for (const c of hits.slice(0, 8)) {
      for (const t of model.trainByCode.get(c).slice(0, 2)) {
        const runs = model.runsOnDay(t, today);
        const s0 = model.stations[t.st[0]].name; const s1 = model.stations[t.st[t.n - 1]].name;
        out.push({
          type: 'train', t,
          html: `${badge(t)}<div class="main"><div class="title">${esc(s0)} → ${esc(s1)}</div>
            <div class="desc">${fmtClock(t.dep[0])} 开 · ${fmtClock(t.arr[t.n - 1])}${dayMark(t.arr[t.n - 1])} 到 · 全程 ${fmtDur(t.end - t.start)}</div></div>
            <div class="side">${runs ? '今日开行' : '今日不开'}</div>`,
        });
      }
    }
  }
  for (const { s } of stationMatches(q).slice(0, 6)) {
    out.push({
      type: 'station', s,
      html: `<div class="main"><div class="title">${esc(s.name)}</div><div class="desc">${esc(s.city || '')}${s.tele ? ' · ' + s.tele : ''}${s.flag === 2 ? ' · 位置为推算' : s.flag ? '' : ' · 无坐标'}</div></div>
        <div class="side">日均 ${s.rank} 趟</div>`,
    });
  }
  return out;
}

/** 车站名称匹配：全名、前缀、包含、电报码、简拼、全拼；停靠车次多的靠前 */
function stationMatches(q) {
  const Q = q.toUpperCase(); const ql = q.toLowerCase();
  const qn = q.length > 1 ? q.replace(/站$/, '') : q;
  const st = [];
  for (const s of model.stations) {
    let score = -1;
    if (s.name === qn) score = 100;
    else if (s.name.startsWith(qn)) score = 80;
    else if (s.name.includes(qn)) score = 60;
    else if (s.tele && s.tele === Q) score = 90;
    else if (s.abbr && s.abbr.startsWith(ql) && ql.length >= 2) score = 50;
    else if (s.py && s.py.startsWith(ql) && ql.length >= 2) score = 45;
    if (score >= 0) st.push({ s, score: score + Math.min(19, Math.log2(1 + s.rank) * 2) });
  }
  return st.sort((a, b) => b.score - a.score);
}

// ---------------- 选择车次 ----------------
function pickRunDay(t, T) {
  const { dayNum, minutes } = cst(T);
  // 当前在途的那一趟
  for (let k = 0; k <= model.maxSpanDays; k++) {
    const d = dayNum - k; const rel = minutes + k * 1440;
    if (model.runsOnDay(t, d) && rel >= t.start && rel <= t.end) return d;
  }
  // 否则：今天还没开的那趟 → 明天起最近开行的一趟 → 最近已开过的一趟
  if (model.runsOnDay(t, dayNum) && minutes < t.start) return dayNum;
  for (let k = 1; k <= 14; k++) if (model.runsOnDay(t, dayNum + k)) return dayNum + k;
  for (let k = 0; k <= 14; k++) if (model.runsOnDay(t, dayNum - k)) return dayNum - k;
  return dayNum;
}

function selectTrain(t, day, { fly = true, od: leg = null } = {}) {
  if (day == null) day = pickRunDay(t, state.T);
  state.sel = { t, day, od: leg }; state.station = null; state.playbackOf = null; state.follow = false;
  od.open = false; $('#panel').classList.remove('od-mode');
  updateRouteLayer(true);
  renderTrainPanel();
  if (fly && t.drawable) {
    const rel = (state.T - dayStartMs(day)) / 60000;
    const st = model.state(t, rel);
    if (st) map.flyTo({ center: [st.lon, st.lat], zoom: Math.max(map.getZoom(), 7), duration: 900 });
    else fitRoute(t);
  }
  state.dirty = true;
  scheduleHash();
}

function fitRoute(t) {
  const coords = model.routeCoords(t);
  if (coords.length < 2) return;
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  for (const c of coords) b.extend(c);
  const narrow = window.innerWidth < 720;
  map.fitBounds(b, { padding: narrow ? { top: 90, bottom: 380, left: 30, right: 30 } : { top: 80, bottom: 160, left: 420, right: 280 }, duration: 900, maxZoom: 10 });
}

function clearSelection() {
  state.sel = null; state.station = null; state.follow = false; state.playbackOf = null;
  od.open = false;
  $('#panel').classList.add('hidden'); $('#panel').classList.remove('od-mode');
  updateRouteLayer(true);
  map.getSource('boardHi')?.setData({ type: 'FeatureCollection', features: [] });
  state.dirty = true; scheduleHash();
}

let routeCoordsCache = null; let routeCumCache = null; let lastPassedIdx = -2; let lastRouteUpdate = 0;
function updateRouteLayer(rebuild) {
  if (!map.getSource('route')) return;
  if (!state.sel || !state.sel.t.drawable) {
    map.getSource('route').setData({ type: 'FeatureCollection', features: [] });
    map.getSource('routeStops').setData({ type: 'FeatureCollection', features: [] });
    routeCoordsCache = null;
    return;
  }
  const { t } = state.sel;
  if (rebuild || !routeCoordsCache) {
    routeCoordsCache = model.routeCoords(t);
    routeCumCache = [0];
    for (let i = 1; i < routeCoordsCache.length; i++) {
      const a = routeCoordsCache[i - 1]; const b = routeCoordsCache[i];
      routeCumCache.push(routeCumCache[i - 1] + haversine(a[0], a[1], b[0], b[1]));
    }
    lastPassedIdx = -2;
  }
  updateRoutePassed((state.T - dayStartMs(state.sel.day)) / 60000, true);
}
function updateRoutePassed(rel, force = false) {
  if (!state.sel || !routeCoordsCache) return;
  const { t } = state.sel;
  const st = model.state(t, rel);
  // 用已走过的比例切分高亮线
  let frac = rel <= t.t0 ? 0 : rel >= t.t1 ? 1 : null;
  if (frac === null && st) {
    const total = t.dist[t.anchors[t.anchors.length - 1]] - t.dist[t.anchors[0]];
    frac = total > 0 ? (st.d - t.dist[t.anchors[0]]) / total : 0;
  }
  const L = routeCumCache[routeCumCache.length - 1];
  const target = (frac ?? 0) * L;
  let idx = routeCumCache.findIndex((c) => c >= target);
  if (idx < 0) idx = routeCoordsCache.length - 1;
  if (!force && (idx === lastPassedIdx || performance.now() - lastRouteUpdate < 200)) return;
  lastPassedIdx = idx; lastRouteUpdate = performance.now();
  const passed = routeCoordsCache.slice(0, idx + 1);
  const rest = routeCoordsCache.slice(Math.max(0, idx));
  if (st && idx > 0) { passed.push([st.lon, st.lat]); rest.unshift([st.lon, st.lat]); }
  const features = [];
  if (passed.length >= 2) features.push({ type: 'Feature', properties: { part: 'passed' }, geometry: { type: 'LineString', coordinates: passed } });
  if (rest.length >= 2) features.push({ type: 'Feature', properties: { part: 'rest' }, geometry: { type: 'LineString', coordinates: rest } });
  map.getSource('route').setData({ type: 'FeatureCollection', features });
  const stops = [];
  for (let k = 0; k < t.n; k++) {
    const s = model.stations[t.st[k]];
    if (s.lon == null || t.dist[k] < 0) continue;
    stops.push({ type: 'Feature', properties: { label: `${s.name} ${fmtClock(k === 0 ? t.dep[k] : t.arr[k])}`, order: k === 0 || k === t.n - 1 ? 0 : 1 + k, passed: t.dep[k] < rel },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
  }
  map.getSource('routeStops').setData({ type: 'FeatureCollection', features: stops });
}

// ---------------- 车次面板 ----------------
function badge(t, big = false) {
  const c = trainColor(t.cls, state.theme);
  return `<span class="code-badge" style="background:rgb(${c.join(',')})${big ? ';font-size:15px' : ''}">${esc(t.code)}</span>`;
}
const dayMark = (m) => (m >= 1440 ? `<span class="plus-day">+${Math.floor(m / 1440)}</span>` : '');
function fmtDur(min) { const h = Math.floor(min / 60); const m = Math.round(min % 60); return h ? `${h}小时${m ? m + '分' : ''}` : `${m}分钟`; }

function runDaysText(t) {
  const n = t.days.length; const total = model.dates.length;
  if (n === total) return '每日开行';
  return '开行：' + t.days.map((i) => model.dates[i].slice(5).replace('-', '/')).join('、');
}

function renderTrainPanel() {
  const { t, day } = state.sel;
  const p = $('#panel');
  p.classList.remove('hidden');
  const s0 = model.stations[t.st[0]]; const s1 = model.stations[t.st[t.n - 1]];
  const hasEst = [...t.st].some((si) => model.stations[si].flag !== 1);
  const leg = state.sel.od; // 从站到站查询进来时：乘车区间
  const rows = [];
  for (let k = 0; k < t.n; k++) {
    const s = model.stations[t.st[k]];
    const km = t.dist[k] >= 0 ? Math.round((t.dist[k] - t.dist[t.anchors[0] ?? 0]) / 1000) : '';
    const dwell = k > 0 && k < t.n - 1 ? t.dep[k] - t.arr[k] : null;
    const odCls = !leg ? '' : k === leg.ka ? ' class="leg-from"' : k === leg.kb ? ' class="leg-to"' : k > leg.ka && k < leg.kb ? ' class="leg-mid"' : '';
    const odTag = !leg ? '' : k === leg.ka ? '<span class="od-tag">上车</span>' : k === leg.kb ? '<span class="od-tag">下车</span>' : '';
    rows.push(`<tr data-k="${k}"${odCls}><td class="seq">${k + 1}</td>
      <td class="name">${esc(s.name)}${odTag}${s.flag === 2 ? '<span class="est" title="OSM 中未找到该站，位置按运行时刻推算">推算</span>' : s.flag ? '' : '<span class="est">无坐标</span>'}</td>
      <td class="time">${k === 0 ? '—' : fmtClock(t.arr[k]) + dayMark(t.arr[k])}</td>
      <td class="time">${k === t.n - 1 ? '—' : fmtClock(t.dep[k]) + dayMark(t.dep[k])}</td>
      <td class="num">${dwell != null ? dwell + '′' : ''}</td><td class="num">${km}</td></tr>`);
  }
  const legInfo = leg ? (() => {
    const L = model.leg(t, day, leg.ka, leg.kb);
    return `<div class="p-sub od-legline">乘车区间：${esc(model.stations[t.st[leg.ka]].name)} ${fmtClock(t.dep[leg.ka])} → ${esc(model.stations[t.st[leg.kb]].name)} ${fmtClock(t.arr[leg.kb])}${dayMark(t.arr[leg.kb] - Math.floor(t.dep[leg.ka] / 1440) * 1440)} · ${fmtDur(L.dur)}${L.km ? ` · ${Math.round(L.km)} km` : ''}</div>`;
  })() : '';
  p.innerHTML = `
    <div class="p-head">
      ${leg && od.from && od.to ? `<button class="od-back" type="button" data-act="od-back">‹ 返回「${esc(placeText(od.from))} → ${esc(placeText(od.to))}」查询结果</button>` : ''}
      <div class="p-title">${badge(t, true)}<h2>${esc(s0.name)} → ${esc(s1.name)}</h2><button class="p-close" type="button" aria-label="关闭" data-act="close">×</button></div>
      ${legInfo}
      <div class="p-sub">${esc(TRAIN_CLASSES[t.cls]?.name || '')}${t.codes.includes('/') ? ' · 车次 ' + esc(t.codes) : ''} · 全程 ${fmtDur(t.end - t.start)}
        · <span title="${esc(runDaysText(t))}">${t.days.length === model.dates.length ? '每日开行' : '非每日开行'}</span></div>
      <div class="p-status"><div class="st-main" id="ps-main"></div><div class="st-sub" id="ps-sub"></div></div>
      <div class="progress" id="ps-progress" title="点击跳转到该时刻"><div class="bar"></div><div class="knob"></div></div>
      <div class="progress-labels"><span>${fmtClock(t.dep[0])} ${esc(s0.name)}</span><button type="button" class="day-switch" data-act="day" title="切换到其他开行日期">${dateOfDayNum(day)} 始发 ▾</button><span>${esc(s1.name)} ${fmtClock(t.arr[t.n - 1])}${dayMark(t.arr[t.n - 1])}</span></div>
      <div class="p-actions">
        <button class="btn primary" type="button" data-act="play">▶ ${leg ? '回放乘车区间' : '回放全程'}</button>
        <span class="seg-speed" id="pb-speed">${PLAYBACK_SPEEDS.map((s) => `<button type="button" data-pb="${s}" class="${s === state.playbackSpeed ? 'on' : ''}">${s}×</button>`).join('')}</span>
        <button class="btn ${state.follow ? 'on' : ''}" type="button" data-act="follow">跟随</button>
        <button class="btn" type="button" data-act="fit">全程</button>
      </div>
    </div>
    ${!t.drawable ? '<div class="p-note">该车次的车站在路网数据中定位不足，无法在地图上显示位置。</div>' : hasEst ? '<div class="p-note">标“推算”的车站在 OpenStreetMap 中未找到，位置按运行时刻沿线推算。</div>' : ''}
    <div class="p-body"><table class="stops"><thead><tr><th>#</th><th>车站</th><th>到达</th><th>发车</th><th>停留</th><th>公里</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  p.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const pb = e.target.closest('[data-pb]')?.dataset.pb;
    if (pb) { state.playbackSpeed = Number(pb); p.querySelectorAll('[data-pb]').forEach((b) => b.classList.toggle('on', b.dataset.pb === pb)); if (state.playbackOf) setSpeed(state.playbackSpeed); return; }
    if (act === 'close') return clearSelection();
    if (act === 'od-back') return openOd({ run: false });
    if (act === 'play') return startPlayback();
    if (act === 'follow') { state.follow = !state.follow; e.target.classList.toggle('on', state.follow); state.dirty = true; return; }
    if (act === 'fit') { state.follow = false; p.querySelector('[data-act="follow"]').classList.remove('on'); return fitRoute(t); }
    if (act === 'day') return cycleDay();
    const tr = e.target.closest('tr[data-k]');
    if (tr) {
      const k = Number(tr.dataset.k);
      const base = dayStartMs(state.sel.day);
      setTime(base + (k === 0 ? t.dep[k] - 1 : t.arr[k]) * 60000);
      const s = model.stations[t.st[k]];
      if (s.lon != null) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 9), duration: 700 });
    }
  };
  $('#ps-progress').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setTime(dayStartMs(state.sel.day) + (t.start + f * (t.end - t.start)) * 60000);
  };
  lastPanelKey = '';
  updatePanel();
}

function cycleDay() {
  const { t, day } = state.sel;
  const cands = [];
  for (let k = -3; k <= 10; k++) if (model.runsOnDay(t, day + k) && k !== 0) cands.push(day + k);
  const next = cands.find((d) => d > day) ?? cands[0];
  if (next == null) { toast('没有其他开行日期'); return; }
  state.sel.day = next;
  renderTrainPanel(); updateRouteLayer(true);
  toast(`已切换到 ${dateOfDayNum(next)} 始发的 ${t.code}`);
}

function startPlayback() {
  const { t, day, od: leg } = state.sel;
  if (!t.drawable) { toast('该车次无法在地图上显示'); return; }
  state.playbackOf = t;
  state.follow = true;
  setTime(dayStartMs(day) + ((leg ? Math.max(t.t0, t.dep[leg.ka]) : t.t0) - 1) * 60000);
  state.speed = state.playbackSpeed; state.playing = true; state.live = false;
  updateSpeedButtons();
  const st = model.state(t, leg ? Math.max(t.t0, t.dep[leg.ka]) : t.t0);
  if (st) map.flyTo({ center: [st.lon, st.lat], zoom: Math.max(map.getZoom(), 8), duration: 800 });
  document.querySelector('#panel [data-act="follow"]')?.classList.add('on');
  toast(`回放 ${t.code}：${state.playbackSpeed} 倍速`);
}

let lastPanelKey = '';
function updatePanel() {
  if (state.sel && !$('#panel').classList.contains('hidden')) updateTrainStatus();
  else if (state.station != null) updateStationBoard();
  else if (od.open) updateOdStatus();
}

function updateTrainStatus() {
  const { t, day } = state.sel;
  const rel = (state.T - dayStartMs(day)) / 60000;
  const S = (k) => model.stations[t.st[k]].name;
  let main = ''; let sub = ''; let cur = -1; let next = -1;
  if (rel < t.start) {
    const wait = t.start - rel;
    main = `未发车 · ${fmtClock(t.dep[0])} 从 ${S(0)} 始发`;
    sub = wait < 1440 * 2 ? `距发车还有 ${fmtDur(wait)}` : `${dateOfDayNum(day)} 始发`;
    next = 0;
  } else if (rel > t.end) {
    main = `已到达 ${S(t.n - 1)}`;
    sub = `${fmtClock(t.arr[t.n - 1])} 到达，全程 ${fmtDur(t.end - t.start)}`;
    cur = t.n;
  } else {
    let i = 0;
    while (i < t.n - 1 && t.arr[i + 1] <= rel) i++;
    const st = model.state(t, rel);
    if (rel <= t.dep[i] || i === t.n - 1) {
      cur = i; next = i + 1;
      main = `停靠 ${S(i)}`;
      sub = i === 0 ? `${fmtClock(t.dep[i])} 发车` : i === t.n - 1 ? `${fmtClock(t.arr[i])} 到达终点` : `${fmtClock(t.arr[i])} 到 · ${fmtClock(t.dep[i])} 开（还有 ${Math.max(0, Math.ceil(t.dep[i] - rel))} 分钟）`;
    } else {
      cur = -1; next = i + 1;
      const spd = st ? Math.round(st.speed / 5) * 5 : null;
      main = `运行中 · ${S(i)} → ${S(i + 1)}`;
      const left = t.dist[i + 1] >= 0 && st ? Math.max(0, (t.dist[i + 1] - st.d) / 1000) : null;
      sub = `${spd != null ? `约 ${spd} km/h · ` : ''}${left != null ? `距 ${S(i + 1)} ${left < 10 ? left.toFixed(1) : Math.round(left)} km · ` : ''}${fmtClock(t.arr[i + 1])} 到达`;
      if (!st) sub += '（位置不可用）';
    }
  }
  $('#ps-main').textContent = main;
  $('#ps-sub').textContent = sub;
  const f = Math.min(1, Math.max(0, (rel - t.start) / (t.end - t.start || 1)));
  const bar = document.querySelector('#ps-progress .bar'); const knob = document.querySelector('#ps-progress .knob');
  if (bar) { bar.style.width = f * 100 + '%'; knob.style.left = f * 100 + '%'; }
  const key = `${cur}|${next}|${Math.floor(rel)}`;
  if (key === lastPanelKey) return;
  const scroll = !lastPanelKey || lastPanelKey.split('|')[1] !== String(next);
  lastPanelKey = key;
  document.querySelectorAll('#panel tr[data-k]').forEach((tr) => {
    const k = Number(tr.dataset.k);
    tr.classList.toggle('passed', rel > t.dep[k] && k !== cur);
    tr.classList.toggle('current', k === cur);
    tr.classList.toggle('next', k === next && cur !== k);
  });
  if (scroll) {
    const target = document.querySelector('#panel tr.current') || document.querySelector('#panel tr.next');
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ---------------- 车站面板 ----------------
let boardRows = []; let boardKey = '';
function selectStation(i, { fly = true } = {}) {
  const s = model.stations[i];
  state.station = i; state.sel = null; state.follow = false; state.playbackOf = null;
  od.open = false; $('#panel').classList.remove('od-mode');
  updateRouteLayer(true);
  if (fly && s.lon != null) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 9), duration: 900 });
  map.getSource('boardHi')?.setData(s.lon != null ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }] } : { type: 'FeatureCollection', features: [] });
  boardKey = '';
  renderStationPanel();
  state.dirty = true; scheduleHash();
}

function renderStationPanel() {
  const s = model.stations[state.station];
  const p = $('#panel');
  p.classList.remove('hidden');
  const dayNum = cst(state.T).dayNum;
  boardRows = [];
  for (const [ti, k] of model.stationStops[s.i]) {
    const t = model.trains[ti];
    for (let off = 0; off <= model.maxSpanDays; off++) {
      const d = dayNum - off;
      if (!model.runsOnDay(t, d)) continue;
      const base = dayStartMs(d);
      const arr = base + t.arr[k] * 60000; const dep = base + t.dep[k] * 60000;
      const ref = k === 0 ? dep : arr;
      if (cst(ref).dayNum !== dayNum) continue;
      boardRows.push({ t, k, day: d, arr, dep, ref });
    }
  }
  boardRows.sort((a, b) => a.ref - b.ref);
  const dd = dateOfDayNum(dayNum);
  p.innerHTML = `
    <div class="p-head">
      <div class="p-title"><h2>${esc(s.name)}站</h2><button class="p-close" type="button" aria-label="关闭" data-act="close">×</button></div>
      <div class="p-sub">${[s.city, s.tele ? '电报码 ' + s.tele : '', `日均 ${s.rank} 趟停靠`, s.flag === 2 ? '位置为推算' : ''].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="p-sub">${dd} 共 ${boardRows.length} 趟（点击车次查看）</div>
      <div class="p-actions"><button class="btn" type="button" data-act="od-from">从这里出发</button><button class="btn" type="button" data-act="od-to">到这里</button></div>
    </div>
    <div class="p-body"><table class="board"><thead><tr><th>车次</th><th>始发 → 终到</th><th>到达</th><th>发车</th><th>状态</th></tr></thead>
    <tbody>${boardRows.map((r, i) => {
    const t = r.t;
    return `<tr data-i="${i}"><td>${badge(t)}</td><td class="ft">${esc(model.stations[t.st[0]].name)} → ${esc(model.stations[t.st[t.n - 1]].name)}</td>
      <td class="time">${r.k === 0 ? '始发' : fmtClock(t.arr[r.k])}</td><td class="time">${r.k === t.n - 1 ? '终到' : fmtClock(t.dep[r.k])}</td><td class="st"></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="st">当日没有经停车次</td></tr>'}</tbody></table></div>`;
  p.onclick = (e) => {
    if (e.target.closest('[data-act="close"]')) return clearSelection();
    const odAct = e.target.closest('[data-act^="od-"]')?.dataset.act;
    if (odAct) {
      const here = stationPlace(s.i);
      const which = odAct === 'od-from' ? 'from' : 'to'; const other = which === 'from' ? 'to' : 'from';
      if (od[other]?.key === here.key) od[other] = null;
      od[which] = here; od.direct = null;
      return openOd({ run: !!od[other] });
    }
    const tr = e.target.closest('tr[data-i]');
    if (tr) { const r = boardRows[Number(tr.dataset.i)]; selectTrain(r.t, r.day, { fly: true }); }
  };
  boardKey = `${state.station}|${dayNum}`;
  updateStationBoard(true);
}

function updateStationBoard(force = false) {
  const dayNum = cst(state.T).dayNum;
  if (`${state.station}|${dayNum}` !== boardKey) { renderStationPanel(); return; }
  const rows = document.querySelectorAll('#panel tr[data-i]');
  let firstUpcoming = null;
  rows.forEach((tr) => {
    const r = boardRows[Number(tr.dataset.i)];
    let txt = ''; let cls = '';
    if (state.T > r.dep) { txt = r.k === r.t.n - 1 ? '已到达' : '已开'; cls = 'gone'; }
    else if (state.T >= r.arr) { txt = '停靠中'; cls = 'at'; }
    else {
      const m = Math.round((r.arr - state.T) / 60000);
      txt = m <= 60 ? `${m} 分钟后${r.k === 0 ? '发车' : '到'}` : '';
      if (!firstUpcoming) firstUpcoming = tr;
    }
    tr.className = cls;
    tr.lastElementChild.textContent = txt;
  });
  if (force) (document.querySelector('#panel tr.at') || firstUpcoming)?.scrollIntoView({ block: 'center' });
}

// ---------------- 站到站查询 ----------------
const od = {
  from: null, to: null, day: null, // 地点：{ type: 'station' | 'city', name, set（车站下标）, key }
  direct: null, xfer: null, xferShown: false, view: [],
  filter: 'all', sort: 'dep', open: false, scroll: 0,
};
const OD_FILTERS = [['all', '全部'], ['GC', '高铁/城际'], ['D', '动车'], ['P', '普速']];
const OD_SORTS = [['dep', '发车早'], ['arr', '到达早'], ['dur', '历时短']];
const odFilterFn = (t) => (od.filter === 'all' ? true : od.filter === 'GC' ? t.cls === 'G' || t.cls === 'C' : od.filter === 'D' ? t.cls === 'D' : !'GCD'.includes(t.cls));
const hmOf = (ms) => fmtClock(cst(ms).minutes);
const plusDay = (ms, d0) => { const n = Math.floor((ms - d0) / DAY); return n > 0 ? `<sup>+${n}</sup>` : ''; };

function stationPlace(i) { const s = model.stations[i]; return { type: 'station', name: s.name, set: new Set([i]), key: 'S:' + s.name }; }
function cityPlace(name) { return { type: 'city', name, set: new Set(model.cityStations.get(name)), key: 'C:' + name }; }
const placeText = (p) => (p ? (p.type === 'city' ? p.name : p.name + '站') : '');
const isCity = (name) => (model.cityStations.get(name)?.length || 0) > 1;

/** 精确识别：“北京南站”→该站；“北京”→同城全部车站（与 12306 一致）；也认电报码、简拼、全拼 */
function resolvePlaceExact(text) {
  const q = String(text || '').trim().replace(/[（(].*$/, '').trim();
  if (!q) return null;
  const bare = q.replace(/站$/, '');
  if (q.length > 1 && q.endsWith('站') && model.stationByName.has(bare)) return stationPlace(model.stationByName.get(bare).i);
  if (isCity(q)) return cityPlace(q);
  if (model.stationByName.has(q)) return stationPlace(model.stationByName.get(q).i);
  const lq = q.toLowerCase(); const uq = q.toUpperCase();
  const s = model.stations.find((x) => x.tele === uq) || model.stations.find((x) => x.abbr === lq || x.py === lq);
  return s ? stationPlace(s.i) : null;
}
/** 模糊识别：精确不到时取候选第一个 */
function resolvePlace(text) { return resolvePlaceExact(text) || placeCandidates(text, 1)[0]?.place || null; }

/** 输入框下拉候选：城市（同城多站）在前，车站在后 */
function placeCandidates(q, limit = 8) {
  q = String(q || '').trim().replace(/[（(].*$/, '').trim();
  if (!q) return [];
  const lq = q.toLowerCase();
  const out = [];
  for (const [name, list] of model.cityStations) {
    if (list.length < 2) continue;
    const s0 = model.stationByName.get(name);
    let score = -1;
    if (name === q) score = 130;
    else if (name.startsWith(q)) score = 95;
    else if (s0 && lq.length >= 2 && (s0.py?.startsWith(lq) || s0.abbr?.startsWith(lq))) score = 75;
    if (score >= 0) out.push({ place: cityPlace(name), score: score + Math.min(19, Math.log2(1 + list.reduce((a, i) => a + (model.stations[i].rank || 0), 0))) });
  }
  for (const { s, score } of stationMatches(q).slice(0, 12)) out.push({ place: stationPlace(s.i), score });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
function placeItemHtml(p) {
  if (p.type === 'city') {
    const names = [...p.set].slice(0, 5).map((i) => model.stations[i].name).join('、');
    return `<div class="main"><div class="title">${esc(p.name)} <span class="od-city">全部 ${p.set.size} 个车站</span></div><div class="desc">${esc(names)}${p.set.size > 5 ? '…' : ''}</div></div>`;
  }
  const s = model.stations[[...p.set][0]];
  return `<div class="main"><div class="title">${esc(s.name)}站</div><div class="desc">${esc(s.city || '')}${s.tele ? ' · ' + s.tele : ''}</div></div><div class="side">日均 ${s.rank} 趟</div>`;
}

function bindPlaceInput(input, dd, which) {
  let items = []; let active = -1;
  const render = () => {
    const q = input.value.trim();
    if (!q || (od[which] && q === placeText(od[which]))) { dd.classList.remove('open'); return; }
    items = placeCandidates(q);
    active = items.length ? 0 : -1;
    dd.innerHTML = items.length
      ? items.map((it, i) => `<div class="dd-item${i === active ? ' active' : ''}" data-i="${i}" role="option">${placeItemHtml(it.place)}</div>`).join('')
      : '<div class="dd-empty">没有找到这个车站或城市</div>';
    dd.classList.add('open');
  };
  const choose = (i) => { const it = items[i]; if (!it) return; dd.classList.remove('open'); setOdPlace(which, it.place); };
  input.addEventListener('input', () => { od[which] = null; render(); });
  input.addEventListener('focus', () => { input.select(); render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      dd.querySelectorAll('.dd-item').forEach((x) => x.classList.toggle('active', Number(x.dataset.i) === active));
      dd.querySelector('.dd-item.active')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (dd.classList.contains('open') && items.length) choose(active < 0 ? 0 : active);
      else runOd();
    } else if (e.key === 'Escape') { e.stopPropagation(); dd.classList.remove('open'); }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    dd.classList.remove('open');
    if (!od[which] && input.value.trim()) { const p = resolvePlace(input.value); if (p) { od[which] = p; input.value = placeText(p); } }
  }, 150));
  dd.addEventListener('mousedown', (e) => { const it = e.target.closest('.dd-item'); if (it) { e.preventDefault(); choose(Number(it.dataset.i)); } });
}

function setOdPlace(which, p) {
  od[which] = p;
  const input = $(which === 'from' ? '#od-from' : '#od-to');
  if (input) input.value = placeText(p);
  if (od.from && od.to) { input?.blur(); runOd(); } else $(which === 'from' ? '#od-to' : '#od-from')?.focus();
}

function fmtOdDate(day) {
  const [, mo, d] = dateOfDayNum(day).split('-').map(Number);
  const diff = day - cst(Date.now()).dayNum;
  const rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : '';
  return `${mo}月${d}日 周${WEEKDAYS[new Date(day * DAY).getUTCDay()]}${rel ? `（${rel}）` : ''}`;
}

function openOd({ from, to, day, run = true } = {}) {
  if (from !== undefined) od.from = from;
  if (to !== undefined) od.to = to;
  if (day != null) od.day = day;
  if (od.day == null) od.day = cst(state.T).dayNum;
  state.sel = null; state.station = null; state.follow = false; state.playbackOf = null;
  od.open = true;
  updateRouteLayer(true);
  map.getSource('boardHi')?.setData({ type: 'FeatureCollection', features: [] });
  renderOdPanel();
  if (run && od.from && od.to) runOd();
  else if (od.direct && od.from && od.to) renderOdResults(true);
  else (od.from ? $('#od-to') : $('#od-from'))?.focus();
  state.dirty = true; scheduleHash();
}

function renderOdPanel() {
  const p = $('#panel');
  p.classList.remove('hidden'); p.classList.add('od-mode');
  p.innerHTML = `
    <div class="p-head od-head">
      <div class="p-title"><h2>站到站查询</h2><button class="p-close" type="button" aria-label="关闭" data-act="close">×</button></div>
      <div class="od-form">
        <div class="od-fields">
          <div class="od-field"><span class="od-label">出发</span><input id="od-from" type="text" placeholder="车站或城市，如 北京、bjn" autocomplete="off" spellcheck="false" value="${esc(placeText(od.from))}" aria-label="出发站"><div id="od-from-dd" class="dropdown" role="listbox"></div></div>
          <div class="od-field"><span class="od-label">到达</span><input id="od-to" type="text" placeholder="车站或城市，如 上海虹桥" autocomplete="off" spellcheck="false" value="${esc(placeText(od.to))}" aria-label="到达站"><div id="od-to-dd" class="dropdown" role="listbox"></div></div>
        </div>
        <button class="od-swap" type="button" data-act="swap" title="交换出发和到达" aria-label="交换出发和到达">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <div class="od-row">
        <button class="od-day" type="button" data-act="prev" aria-label="前一天">‹</button>
        <input id="od-date" type="date" value="${dateOfDayNum(od.day)}" aria-label="出发日期">
        <button class="od-day" type="button" data-act="next" aria-label="后一天">›</button>
        <span id="od-wd" class="od-wd"></span>
        <button class="btn primary od-go" type="button" data-act="go">查询</button>
      </div>
      <div class="od-tools hidden" id="od-tools">
        <span class="seg-speed">${OD_FILTERS.map(([k, n]) => `<button type="button" data-f="${k}" class="${k === od.filter ? 'on' : ''}">${n}</button>`).join('')}</span>
        <span class="seg-speed">${OD_SORTS.map(([k, n]) => `<button type="button" data-s="${k}" class="${k === od.sort ? 'on' : ''}">${n}</button>`).join('')}</span>
      </div>
    </div>
    <div class="p-body" id="od-body"><div class="od-empty">输入出发地和目的地。输入城市名（如“北京”）会查该城市的全部车站，输入车站名（如“北京南站”）只查这一站；支持拼音和简拼。</div></div>`;
  bindPlaceInput($('#od-from'), $('#od-from-dd'), 'from');
  bindPlaceInput($('#od-to'), $('#od-to-dd'), 'to');
  $('#od-wd').textContent = fmtOdDate(od.day).replace(/^\d+月\d+日 /, '');
  $('#od-date').addEventListener('change', (e) => { if (!e.target.value) return; setOdDay(dayNumOf(e.target.value)); });
  p.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') return clearSelection();
    if (act === 'swap') {
      [od.from, od.to] = [od.to, od.from];
      $('#od-from').value = placeText(od.from); $('#od-to').value = placeText(od.to);
      if (od.from && od.to) runOd();
      return;
    }
    if (act === 'prev' || act === 'next') return setOdDay(od.day + (act === 'prev' ? -1 : 1));
    if (act === 'go') return runOd();
    if (act === 'xfer') return showTransfers();
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (f) { od.filter = f; p.querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('on', b.dataset.f === f)); return renderOdResults(); }
    const so = e.target.closest('[data-s]')?.dataset.s;
    if (so) { od.sort = so; p.querySelectorAll('[data-s]').forEach((b) => b.classList.toggle('on', b.dataset.s === so)); return renderOdResults(); }
    const item = e.target.closest('[data-leg]');
    if (item) pickOdLeg(item.dataset.leg);
  };
}

function setOdDay(day) {
  od.day = day;
  const inp = $('#od-date'); if (inp) inp.value = dateOfDayNum(day);
  const wd = $('#od-wd'); if (wd) wd.textContent = fmtOdDate(day).replace(/^\d+月\d+日 /, '');
  if (od.from && od.to) runOd(); else scheduleHash();
}

function runOd() {
  // 输入框里有文字但没从下拉里选的，按最接近的结果识别
  for (const w of ['from', 'to']) {
    const input = $(w === 'from' ? '#od-from' : '#od-to');
    if (!od[w] && input?.value.trim()) { const p = resolvePlace(input.value); if (p) { od[w] = p; input.value = placeText(p); } }
  }
  if (!od.from || !od.to) { toast(!od.from ? '请填写出发站' : '请填写到达站'); (od.from ? $('#od-to') : $('#od-from'))?.focus(); return; }
  if (od.from.key === od.to.key) { toast('出发地和目的地不能相同'); return; }
  od.direct = model.queryDirect(od.from.set, od.to.set, od.day);
  // 直达很少时（如北京→拉萨只有一趟）顺便给出中转方案
  od.xfer = od.direct.length < 3 ? model.transferOptions(od.from.set, od.to.set, od.day) : null;
  od.xferShown = !!od.xfer;
  od.scroll = 0;
  renderOdResults();
  scheduleHash();
}

function showTransfers() {
  if (!od.xfer) od.xfer = model.transferOptions(od.from.set, od.to.set, od.day);
  od.xferShown = true;
  renderOdResults(true);
  $('#od-xfer-sec')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function renderOdResults(restore = false) {
  const body = $('#od-body');
  if (!body || !od.direct) return;
  $('#od-tools')?.classList.toggle('hidden', od.direct.length < 2);
  const m = model.mapDay(od.day);
  const list = od.direct.filter((r) => odFilterFn(r.t));
  const key = { dep: (r) => r.dep, arr: (r) => r.arr, dur: (r) => r.dur }[od.sort];
  list.sort((a, b) => key(a) - key(b) || a.dep - b.dep);
  od.view = list;
  const d0 = dayStartMs(od.day);
  const fastest = od.direct.length ? Math.min(...od.direct.map((r) => r.dur)) : 0;
  let html = `<div class="od-summary"><b>${esc(placeText(od.from))} → ${esc(placeText(od.to))}</b> · ${fmtOdDate(od.day)}<br>
    直达 <b>${od.direct.length}</b> 趟${list.length !== od.direct.length ? `，筛选后 ${list.length} 趟` : ''}${fastest ? `，最快 ${fmtDur(fastest)}` : ''}
    ${m.exact ? '' : `<span class="od-warn" title="所选日期不在已抓取的时刻范围内（${model.dates[0]} ~ ${model.dates[model.dates.length - 1]}）">· 按 ${model.dates[m.idx].slice(5)}（同为周${WEEKDAYS[new Date(od.day * DAY).getUTCDay()]}）的时刻推算</span>`}</div>`;
  html += list.map((r, i) => odRowHtml(r, i, d0)).join('');
  if (!od.direct.length) html += '<div class="od-empty">这一天没有直达车次。</div>';
  else if (!list.length) html += '<div class="od-empty">没有符合筛选条件的车次。</div>';
  if (od.xferShown) html += odTransferHtml(d0);
  else html += '<div class="od-more"><button class="btn" type="button" data-act="xfer">查看中转方案</button></div>';
  html += `<div class="od-foot">时刻来自 12306（${model.dates[0].slice(5)} ~ ${model.dates[model.dates.length - 1].slice(5)}），仅供参考；余票和票价请以 12306 为准。点车次可在地图上查看。</div>`;
  body.innerHTML = html;
  body.scrollTop = restore ? od.scroll : 0;
  updateOdStatus();
  // 查询当天、按发车排序时，滚到第一趟还没开的车（已开走的显示为灰色）
  const gone = body.querySelectorAll('.od-item.gone').length;
  if (gone) {
    body.querySelector('.od-summary')?.insertAdjacentHTML('beforeend', `<br><span class="od-hint">灰色的 ${gone} 趟在地图当前时间（${hmOf(state.T)}）已经开出</span>`);
    const next = body.querySelector('.od-item:not(.gone)');
    if (!restore && od.sort === 'dep' && next) body.scrollTop = next.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
  }
}

function odRowHtml(r, i, d0) {
  const t = r.t;
  const via = r.kb - r.ka - 1;
  const meta = [TRAIN_CLASSES[t.cls]?.name, via ? `经停 ${via} 站` : '中途不停', r.km ? `${Math.round(r.km)} km` : '',
    t.codes.includes('/') ? `车次 ${t.codes}` : '', t.days.length < model.dates.length ? '非每日开行' : ''].filter(Boolean).join(' · ');
  return `<div class="od-item" data-leg="d:${i}" data-dep="${r.dep}" role="button" tabindex="0">
    <div class="od-code">${badge(t)}</div>
    <div class="od-end"><b>${hmOf(r.dep)}</b><span>${esc(model.stations[t.st[r.ka]].name)}</span></div>
    <div class="od-mid"><span>${fmtDur(r.dur)}</span><i></i></div>
    <div class="od-end od-right"><b>${hmOf(r.arr)}${plusDay(r.arr, d0)}</b><span>${esc(model.stations[t.st[r.kb]].name)}</span></div>
    <div class="od-meta">${esc(meta)}</div>
  </div>`;
}

function odTransferHtml(d0) {
  const xs = od.xfer || [];
  const head = `<div class="od-sec" id="od-xfer-sec">中转方案 · 换乘一次${xs.length ? `（${xs.length} 个）` : ''}</div>`;
  if (!xs.length) return head + '<div class="od-empty">没有找到换乘一次能到达的方案，可能需要换乘两次以上。</div>';
  return head + xs.map((o, i) => {
    const X = model.stations[o.x].name; const Y = model.stations[o.y].name;
    const how = o.x === o.y ? `在 ${esc(X)} 换乘` : `${esc(X)} 下车，换到同城的 ${esc(Y)}`;
    return `<div class="od-xfer">
      <div class="od-xhead"><b>${hmOf(o.dep)} → ${hmOf(o.arr)}${plusDay(o.arr, d0)}</b><span>全程 ${fmtDur(o.dur)}</span></div>
      ${odXLeg(o.a, `x:${i}:a`, d0)}
      <div class="od-xwait">${how} · 间隔 ${fmtDur(o.wait)}</div>
      ${odXLeg(o.b, `x:${i}:b`, d0)}
    </div>`;
  }).join('');
}
function odXLeg(l, key, d0) {
  const t = l.t;
  return `<div class="od-xleg" data-leg="${key}" data-dep="${l.dep}" role="button" tabindex="0">${badge(t)}
    <span class="od-xtxt"><b>${hmOf(l.dep)}${plusDay(l.dep, d0)}</b> ${esc(model.stations[t.st[l.ka]].name)} → <b>${hmOf(l.arr)}${plusDay(l.arr, d0)}</b> ${esc(model.stations[t.st[l.kb]].name)}</span></div>`;
}

function pickOdLeg(key) {
  const [kind, i, part] = key.split(':');
  const leg = kind === 'd' ? od.view[Number(i)] : od.xfer?.[Number(i)]?.[part];
  if (!leg) return;
  od.scroll = $('#od-body')?.scrollTop || 0;
  selectTrain(leg.t, leg.day, { fly: false, od: { ka: leg.ka, kb: leg.kb } });
  setTime(leg.dep - 60000);
  const s = model.stations[leg.t.st[leg.ka]];
  if (s.lon != null) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 8), duration: 800 });
  toast(`时间已调到 ${leg.t.code} 在${s.name}发车前 1 分钟`);
}

/** 已经开走的车次变灰（按地图当前时间） */
function updateOdStatus() {
  document.querySelectorAll('#od-body [data-dep]').forEach((el) => el.classList.toggle('gone', Number(el.dataset.dep) < state.T));
}

// ---------------- 地图交互 ----------------
function bindMapEvents() {
  const stLayers = [1, 2, 3, 4].flatMap((t) => [`st-dot-${t}`, `st-label-${t}`]);
  map.on('click', (e) => {
    if (performance.now() - lastTrainClick < 300) return; // 点在列车上，交给列车图层处理
    const f = map.queryRenderedFeatures(e.point, { layers: stLayers.filter((l) => map.getLayer(l)) })[0];
    if (f) { selectStation(f.properties.i, { fly: false }); return; }
  });
  for (const l of stLayers) {
    map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
  }
  let railTimer = 0;
  map.on('mousemove', (e) => {
    if (hoverRun) return;
    clearTimeout(railTimer);
    railTimer = setTimeout(() => {
      if (hoverRun || map.getZoom() < 5) { if (!hoverRun) hideTooltip(); return; }
      const layers = [0, 1, 2, 3, 4, 5, 6].map((c) => `rail-${c}`).filter((l) => map.getLayer(l));
      const box = [[e.point.x - 3, e.point.y - 3], [e.point.x + 3, e.point.y + 3]];
      const f = map.queryRenderedFeatures(box, { layers })[0];
      if (f && f.properties.n) {
        const cls = model.meta.edgeClasses[f.properties.c]?.name || '';
        showTooltip(e.point, `<div class="tt-title">${esc(f.properties.n)}</div><div class="tt-row">${esc(cls)}${f.properties.t ? ` · 日均约 ${f.properties.t} 列` : ''}</div>`);
      } else hideTooltip();
    }, 60);
  });
  map.on('mouseout', hideTooltip);
  map.on('dragstart', () => { if (state.follow) { state.follow = false; document.querySelector('#panel [data-act="follow"]')?.classList.remove('on'); } });
  map.on('moveend', scheduleHash);
}

let hoverInfo = null;
function onTrainHover(run, info) {
  hoverRun = run; hoverInfo = info;
  map.getCanvas().style.cursor = run ? 'pointer' : '';
  if (!run) { hideTooltip(); return; }
  refreshTooltip();
}
function refreshTooltip() {
  if (!hoverRun || !hoverInfo) return;
  const r = frame.runs.find((x) => x.t === hoverRun.t && x.day === hoverRun.day) || hoverRun;
  const t = r.t; const st = r.st;
  const S = (k) => model.stations[t.st[k]].name;
  let line = '';
  if (st) {
    line = st.moving ? `${S(st.i)} → ${S(st.j)} · 约 ${Math.round(st.speed / 5) * 5} km/h` : `停靠 ${S(st.i)}`;
  }
  showTooltip({ x: hoverInfo.x, y: hoverInfo.y }, `<div class="tt-title">${badge(t)} ${esc(S(0))} → ${esc(S(t.n - 1))}</div>
    <div class="tt-row">${esc(line)}</div><div class="tt-row">${fmtClock(t.dep[0])} 开 · ${fmtClock(t.arr[t.n - 1])}${t.arr[t.n - 1] >= 1440 ? '（+' + Math.floor(t.arr[t.n - 1] / 1440) + '日）' : ''} 到 · 点击查看详情</div>`);
}
function showTooltip(pt, html) {
  const el = $('#tooltip');
  el.innerHTML = html; el.classList.remove('hidden');
  const w = el.offsetWidth; const h = el.offsetHeight;
  let x = pt.x + 14; let y = pt.y + 14;
  if (x + w > window.innerWidth - 8) x = pt.x - w - 14;
  if (y + h > window.innerHeight - 8) y = pt.y - h - 14;
  el.style.left = x + 'px'; el.style.top = y + 'px';
}
function hideTooltip() { $('#tooltip').classList.add('hidden'); }

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') setTime(state.T - (e.shiftKey ? 3600e3 : 600e3));
    else if (e.key === 'ArrowRight') setTime(state.T + (e.shiftKey ? 3600e3 : 600e3));
    else if (e.key === 'Escape') { if (!$('#about').classList.contains('hidden')) $('#about').classList.add('hidden'); else clearSelection(); }
    else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  });
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ---------------- 地址栏状态（可分享链接） ----------------
let hashTimer = 0;
function scheduleHash() { clearTimeout(hashTimer); hashTimer = setTimeout(writeHash, 400); }
function writeHash() {
  if (!map) return;
  const c = map.getCenter();
  const parts = [`map=${map.getZoom().toFixed(2)}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`];
  if (!state.live) {
    const k = cst(state.T);
    parts.push(`t=${dateOfDayNum(k.dayNum)}T${fmtClock(k.minutes)}`);
  }
  if (state.sel) parts.push(`train=${encodeURIComponent(state.sel.t.code)}`, `day=${dateOfDayNum(state.sel.day)}`);
  else if (state.station != null) parts.push(`station=${encodeURIComponent(model.stations[state.station].name)}`);
  else if (od.open && od.from && od.to) parts.push(`od=${encodeURIComponent(placeText(od.from))}~${encodeURIComponent(placeText(od.to))}~${dateOfDayNum(od.day)}`);
  history.replaceState(null, '', '#' + parts.join('&'));
}
function applyHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const m = h.get('map');
  if (m) { const [z, lat, lon] = m.split('/').map(Number); if ([z, lat, lon].every(Number.isFinite)) map.jumpTo({ zoom: z, center: [lon, lat] }); }
  const t = h.get('t');
  if (t && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) {
    const [d, hm] = t.split('T'); const [hh, mm] = hm.split(':').map(Number);
    state.T = dayStartMs(dayNumOf(d)) + (hh * 60 + mm) * 60000; state.live = false; state.playing = false;
  }
  const code = h.get('train');
  if (code && model.trainByCode.has(code)) {
    const day = h.get('day');
    const variants = model.trainByCode.get(code);
    const dn = day ? dayNumOf(day) : null;
    const t = (dn != null && variants.find((v) => model.runsOnDay(v, dn))) || variants[0];
    selectTrain(t, dn, { fly: !m });
  } else if (h.get('station') && model.stationByName.has(h.get('station'))) {
    selectStation(model.stationByName.get(h.get('station')).i, { fly: !m });
  } else if (h.get('od')) {
    const [a, b, d] = h.get('od').split('~');
    const from = resolvePlace(a || ''); const to = resolvePlace(b || '');
    openOd({ from, to, day: /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? dayNumOf(d) : null, run: !!(from && to) });
  }
  state.dirty = true;
}

function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) || []; const pb = b.match(re) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]; const y = pb[i];
    if (x === undefined) return -1; if (y === undefined) return 1;
    const nx = /^\d/.test(x); const ny = /^\d/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d; } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

window.__rp = { state, perf, get model() { return model; }, get map() { return map; }, selectTrain, selectStation, setTime, setSpeed };
init();
