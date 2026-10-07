#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, readJSON } from '../lib/util.mjs';

const file = process.argv[2];
if (!file) throw new Error('请指定原始缓存压缩包路径');
const manifest = readJSON(path.join(ROOT, 'data/bootstrap.json'));
const bytes = fs.readFileSync(file);
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (bytes.length !== manifest.bytes || sha256 !== manifest.sha256) {
  throw new Error('原始缓存校验失败，停止解压');
}
console.log(`原始缓存 SHA-256 校验通过：${bytes.length} bytes`);
