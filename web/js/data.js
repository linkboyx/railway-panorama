// 数据加载：带进度的 JSON 下载 + 构建模型
import { Model } from './model.js';

const FILES = ['meta', 'network', 'stations', 'trains', 'paths'];

async function fetchJSON(url, onBytes) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}：HTTP ${res.status}`);
  if (!res.body || !res.body.getReader) return res.json();
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onBytes?.(value.length);
  }
  const buf = new Uint8Array(got);
  let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}

export async function loadModel(base = 'data/', onProgress = () => {}) {
  let loaded = 0;
  const report = (label) => onProgress({ label, mb: loaded / 1048576 });
  report('正在加载数据…');
  const meta = await fetchJSON(base + 'meta.json');
  const parts = await Promise.all(FILES.slice(1).map((n) => fetchJSON(base + n + '.json', (b) => { loaded += b; report('正在加载数据…'); })));
  report('正在解析时刻表与路网…');
  await new Promise((r) => setTimeout(r, 20));
  const [network, stations, trains, paths] = parts;
  return new Model({ meta, network, stations, trains, paths });
}

export async function loadBasemap(base = 'data/basemap/') {
  const names = ['land', 'provinces', 'province-lines', 'nation-line', 'dashline', 'rivers', 'lakes', 'cities', 'province-labels'];
  const out = {};
  await Promise.all(names.map(async (n) => {
    try { out[n] = await fetchJSON(base + n + '.json'); } catch { out[n] = { type: 'FeatureCollection', features: [] }; }
  }));
  return out;
}
