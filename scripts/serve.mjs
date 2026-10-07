#!/usr/bin/env node
/**
 * 本地静态服务器（无依赖）：npm start → http://localhost:8080
 *   node scripts/serve.mjs --port 8080 --dir web
 * 对 JSON/JS/CSS 自动 gzip 压缩，数据加载更快。部署时也可以把 web/ 目录交给任意静态服务器（Nginx、OSS、GitHub Pages 等）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseArgs, ROOT } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2), { port: process.env.PORT || '8080', dir: path.join(ROOT, 'web'), host: '0.0.0.0' });
const DIR = path.resolve(args.dir);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pbf': 'application/x-protobuf',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const gzCache = new Map();

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIR)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // 第三方库和底图基本不变，缓存一段时间；页面、脚本、样式和数据每次都校验（更新后刷新即可看到）
    const cache = p.startsWith('/vendor/') || p.startsWith('/data/basemap/') ? 'public, max-age=86400' : 'no-cache';
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    const compressible = /json|javascript|css|html|svg|text/.test(type);
    if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && st.size > 1024) {
      const key = file + ':' + st.mtimeMs;
      let buf = gzCache.get(key);
      if (!buf) { buf = zlib.gzipSync(fs.readFileSync(file), { level: 6 }); gzCache.set(key, buf); }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': buf.length, Vary: 'Accept-Encoding' });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});
server.listen(Number(args.port), args.host, () => {
  console.log(`\n  中国铁路全景 已启动： http://localhost:${args.port}\n  （Ctrl+C 退出）\n`);
});
