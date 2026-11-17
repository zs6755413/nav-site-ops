#!/usr/bin/env node
'use strict';
/**
 * sitemap-audit —— 按 sitemap 逐页体检：状态码 / canonical / noindex / 重复内容 / 薄页
 *
 * 解决的问题：Search Console 里「已发现，尚未编入索引」堆成山时，
 * 你要先分清是「谷歌没来抓」还是「页面本身不合格」。这个脚本负责回答后者。
 *
 * 用法：
 *   node bin/sitemap-audit.js --base https://www.example.com
 *   node bin/sitemap-audit.js --base https://www.example.com --resolve 127.0.0.1:8080
 *   node bin/sitemap-audit.js --base https://www.example.com --sitemaps sitemap-posts.xml,sitemap-qa.xml
 *   node bin/sitemap-audit.js --base https://www.example.com --json /tmp/audit.json --conc 4
 *
 * 参数：
 *   --base     站点根地址（必填），脚本会先读 {base}/sitemap.xml 找出所有分片
 *   --sitemaps 指定分片（逗号分隔），默认自动从 sitemap index 取
 *   --resolve  直连源站：形如 127.0.0.1:8080，此时仍用 --base 的域名做 Host 头
 *   --conc     并发数，默认 4。别调太高，这是在对真实站点做全量请求
 *   --limit    只查前 N 条，用来快速试探
 *   --json     明细输出路径
 *
 * 退出码：0 全部正常 / 1 存在 4xx、5xx 或超时
 */
const fs = require('fs');
const { request, normalize, pool, locsOf } = require('../lib/http');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const BASE = (arg('base', '') || '').replace(/\/+$/, '');
if (!BASE) {
  console.error('缺少 --base，例如：--base https://www.example.com');
  process.exit(2);
}
const RESOLVE = arg('resolve', '');
const CONC = Number(arg('conc', '4')) || 4;
const LIMIT = Number(arg('limit', '0')) || 0;
const JSON_OUT = arg('json', '');

/** 真实请求地址：直连源站时替换协议主机，但 Host 头保留域名 */
function targetOf(u) {
  if (!RESOLVE) return { url: u, hostHeader: '' };
  const p = new URL(u);
  return { url: 'http://' + RESOLVE + p.pathname + p.search, hostHeader: p.host, proto: p.protocol.replace(':', '') };
}

async function probe(u) {
  const t = targetOf(u);
  const r = await request({ url: t.url, hostHeader: t.hostHeader, proto: t.proto });
  const html = r.body || '';
  const pick = (re) => { const m = html.match(re); return m ? m[1].trim() : ''; };
  const robots = pick(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)/i).toLowerCase();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    url: u,
    path: new URL(u).pathname,
    status: r.status,
    bytes: r.bytes,
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    canonical: pick(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i),
    noindex: robots.includes('noindex'),
    h1: (html.match(/<h1[\s>]/gi) || []).length,
    textLen: text.length,
    excerpt: text.slice(0, 200),
  };
}

(async () => {
  // 1) 确定要查哪些 URL
  let u = [];
  const sitemapArg = arg('sitemaps', '');
  if (sitemapArg) {
    for (const f of sitemapArg.split(',')) {
      const t = targetOf(BASE + '/' + f.replace(/^\/+/, ''));
      const r = await request({ url: t.url, hostHeader: t.hostHeader, proto: t.proto });
      u.push(...locsOf(r.body));
    }
  } else {
    const t = targetOf(BASE + '/sitemap.xml');
    const idx = await request({ url: t.url, hostHeader: t.hostHeader, proto: t.proto });
    const subs = locsOf(idx.body);
    if (!subs.length) {
      console.error('读不到 sitemap.xml 或其中没有 <loc>');
      console.error('  实际请求：' + t.url + (t.hostHeader ? '（Host: ' + t.hostHeader + '）' : ''));
      console.error('  返回状态：' + idx.status + '，响应前 120 字：' + String(idx.body).slice(0, 120).replace(/\s+/g, ' '));
      if (idx.status >= 300 && idx.status < 400) {
        console.error('  提示：3xx 多半是源站按协议或域名做了跳转。直连源站时确认 --resolve 用法，');
        console.error('        脚本会自动带上原始协议与 Host 头；仍然跳转就检查站点是否强制 www/https。');
      }
      process.exit(2);
    }
    for (const s of subs) {
      const tt = targetOf(s);
      const r = await request({ url: tt.url, hostHeader: tt.hostHeader, proto: tt.proto });
      u.push(...locsOf(r.body));
    }
  }
  u = [...new Set(u.map((x) => normalize(x, BASE)))].filter(Boolean);
  if (LIMIT) u = u.slice(0, LIMIT);
  console.log('待检查 URL：' + u.length + (RESOLVE ? '（直连 ' + RESOLVE + '）' : ''));

  // 2) 逐页抓
  const rows = await pool(u, CONC, probe);
  let done = 0;
  for (const r of rows) { if (++done % 200 === 0) console.log('  已查 ' + done); }

  // 3) 汇总
  const ok = rows.filter((r) => r.status === 200);
  const stat = {};
  rows.forEach((r) => { stat[r.status] = (stat[r.status] || 0) + 1; });
  console.log('\n== 状态码 ==');
  Object.keys(stat).sort().forEach((k) => console.log('  ' + (k === '0' ? '超时/连不上' : k) + ': ' + stat[k]));

  const noSelfCanon = ok.filter((r) => {
    if (!r.canonical) return true;
    return normalize(r.canonical, BASE) !== normalize(r.url, BASE);
  });
  const noindexed = ok.filter((r) => r.noindex);
  const thin = ok.filter((r) => r.textLen < 600);
  const noH1 = ok.filter((r) => r.h1 === 0);

  console.log('\n== 200 页面里的问题项 ==');
  console.log('  canonical 缺失或非自指: ' + noSelfCanon.length);
  console.log('  带 noindex: ' + noindexed.length + '（有意的请忽略，但别放进 sitemap）');
  console.log('  正文 < 600 字（薄页）: ' + thin.length);
  console.log('  没有 h1: ' + noH1.length);

  // 重复：标题 + 正文前 400 字做指纹
  const g = new Map();
  ok.forEach((r) => {
    const k = (r.title + '|' + r.excerpt.slice(0, 400)).replace(/\s+/g, '');
    if (!k || k === '|') return;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r.path);
  });
  const dups = [...g.values()].filter((a) => a.length > 1);
  console.log('  重复内容组: ' + dups.length + '（涉及 ' + dups.reduce((s, a) => s + a.length - 1, 0) + ' 个多余页）');
  dups.slice(0, 5).forEach((a) => console.log('    x' + a.length + ' ' + a.join(' ')));

  console.log('\n== 抽样 ==');
  noSelfCanon.slice(0, 5).forEach((r) => console.log('  canonical: ' + r.path + ' -> ' + (r.canonical || '(无)')));
  thin.slice(0, 5).forEach((r) => console.log('  薄页: ' + r.path + ' ' + r.textLen + ' 字'));

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
    console.log('\n明细已写入 ' + JSON_OUT);
  }

  const bad = rows.filter((r) => r.status === 0 || (r.status >= 400));
  if (bad.length) {
    console.log('\n== 异常页（前 10）==');
    bad.slice(0, 10).forEach((r) => console.log('  ' + (r.status || 'ERR') + ' ' + r.path));
    process.exit(1);
  }
})();
