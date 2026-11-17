#!/usr/bin/env node
'use strict';
/**
 * precompress —— 给静态文件生成 .gz / .br 预压缩副本
 *
 * 解决的问题：nginx 开了 gzip_static / brotli_static 之后，会优先发
 * 磁盘上的 xxx.js.gz、xxx.js.br。你改了 js/css 却忘了重新生成副本，
 * 浏览器拿到的永远是旧的那份 —— 表现是「文件明明改了，强刷也没用」。
 * 这个脚本把这一步自动化：内容没变就跳过，不会把 mtime 全都刷新一遍。
 *
 * 用法：
 *   node bin/precompress.js --dir public
 *   node bin/precompress.js --dir public --ext .js,.css,.html,.svg,.json
 *   node bin/precompress.js --dir public --br-level 11 --gz-level 9
 *   node bin/precompress.js --dir public --dry-run
 *
 * 建议接在部署脚本的最后一步，别放到请求路径里。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes('--' + k);

const DIR = arg('dir', '');
if (!DIR) { console.error('缺少 --dir，例如 --dir public'); process.exit(2); }
if (!fs.existsSync(DIR)) { console.error('目录不存在：' + DIR); process.exit(2); }

const EXTS = (arg('ext', '.js,.css,.html,.htm,.svg,.json,.xml,.txt') || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const GZ_LEVEL = Math.min(9, Math.max(1, Number(arg('gz-level', '9')) || 9));
const BR_LEVEL = Math.min(11, Math.max(1, Number(arg('br-level', '11')) || 11));
const MIN_BYTES = Number(arg('min', '1024')) || 0;   // 太小的文件压了反而变大
const DRY = has('dry-run');

let files = 0, wrote = 0, skipped = 0, totalRaw = 0, totalOut = 0;

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) { walk(full, out); continue; }
    const ext = path.extname(name).toLowerCase();
    if (!EXTS.includes(ext)) continue;
    if (st.size < MIN_BYTES) continue;
    out.push({ full, size: st.size, mtime: st.mtimeMs });
  }
}

const list = [];
walk(DIR, list);
files = list.length;

for (const f of list) {
  const raw = fs.readFileSync(f.full);
  totalRaw += raw.length;
  for (const [suffix, fn, level] of [
    ['.gz', zlib.gzipSync, { level: GZ_LEVEL }],
    ['.br', zlib.brotliCompressSync, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BR_LEVEL } }],
  ]) {
    const outPath = f.full + suffix;
    const buf = fn(raw, level);
    totalOut += buf.length;
    /* 内容没变就跳过。
       判据 = 压缩后长度一致 + 副本 mtime 不早于源文件。
       这里必须留 2 秒容差：utimes 只能设置到秒级（部分文件系统到毫秒），
       源文件 mtime 带亚毫秒精度，直接比大小会把「刚写完的副本」判成旧的，
       于是每次跑都重写一遍 —— 白费 CPU，还会把 mtime 全刷成当前时间。 */
    let need = true;
    if (fs.existsSync(outPath)) {
      const st = fs.statSync(outPath);
      if (st.size === buf.length && st.mtimeMs >= f.mtime - 2000) need = false;
    }
    if (!need) { skipped++; continue; }
    if (!DRY) {
      fs.writeFileSync(outPath, buf);
      // 副本 mtime 对齐源文件，避免出现「源文件比副本旧」的错觉
      try { fs.utimesSync(outPath, new Date(), new Date(f.mtime)); } catch (e) {}
    }
    wrote++;
    console.log((DRY ? '[dry-run] ' : '') + '写入 ' + path.relative(DIR, outPath) +
      '  ' + raw.length + ' → ' + buf.length + ' 字节');
  }
}

console.log('\n共 ' + files + ' 个源文件，写入 ' + wrote + ' 个副本，跳过 ' + skipped + ' 个（未变化）');
if (totalRaw) {
  const ratio = (1 - totalOut / (totalRaw * 2)) * 100;
  console.log('gz + br 两份合计 ' + totalOut + ' 字节，源文件 ' + totalRaw + ' 字节，平均省下 ' + ratio.toFixed(1) + '%');
}
console.log('\n提醒：nginx 需要开启 gzip_static on; （brotli 需 brotli_static on;），否则副本不会被使用。');
