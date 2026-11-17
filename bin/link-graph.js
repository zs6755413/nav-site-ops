#!/usr/bin/env node
'use strict';
/**
 * link-graph —— 站内链接图审计：谁链到谁、哪些页面没有任何入链
 *
 * 解决的问题：Google 看一个页面重不重要，先看你自己的站里有没有人链它。
 * 「只出现在 sitemap 里、站内没有任何页面指向」的页面，往往长期停在
 * 「已发现，尚未编入索引」。这个脚本把这类页面找出来。
 *
 * ⚠️ 一个必须避开的坑（我踩过两次）：
 *   只抓 sitemap 里的 URL 会**高估**孤儿数量。因为分类页的分页（?page=2）、
 *   论坛列表、详情页里的相关推荐，都不在 sitemap 里，但它们是真实的链接入口。
 *   所以要加 --follow 把抓到的站内链接也纳入抓取队列（默认跟一层）。
 *
 * 用法：
 *   node bin/link-graph.js --base https://www.example.com
 *   node bin/link-graph.js --base https://www.example.com --follow 2 --conc 4
 *   node bin/link-graph.js --base https://www.example.com --resolve 127.0.0.1:8080 --json /tmp/graph.json
 */
const fs = require('fs');
const { request, normalize, pool, locsOf } = require('../lib/http');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const BASE = (arg('base', '') || '').replace(/\/+$/, '');
if (!BASE) { console.error('缺少 --base'); process.exit(2); }
const HOST = new URL(BASE).host;
const RESOLVE = arg('resolve', '');
const CONC = Number(arg('conc', '4')) || 4;
const FOLLOW = Math.min(3, Number(arg('follow', '1')) || 0);
const JSON_OUT = arg('json', '');
const MAX_PAGES = Number(arg('max', '3000')) || 3000;

function targetOf(u) {
  if (!RESOLVE) return { url: u, hostHeader: '' };
  const p = new URL(u);
  return { url: 'http://' + RESOLVE + p.pathname + p.search, hostHeader: p.host, proto: p.protocol.replace(':', '') };
}

/** 只保留同主机、去锚点、去末尾斜杠 */
function sameHost(u, from) {
  try {
    const x = new URL(u, from);
    if (x.host !== HOST) return '';
    if (!/^https?:$/.test(x.protocol)) return '';
    return x.origin + (x.pathname.replace(/\/+$/, '') || '/') + x.search;
  } catch (e) { return ''; }
}

(async () => {
  // 1) 种子：sitemap 全部 URL
  const t0 = targetOf(BASE + '/sitemap.xml');
  const idx = await request({ url: t0.url, hostHeader: t0.hostHeader, proto: t0.proto });
  const subs = locsOf(idx.body);
  let seeds = [];
  if (subs.length) {
    for (const s of subs) {
      const t = targetOf(s);
      const r = await request({ url: t.url, hostHeader: t.hostHeader, proto: t.proto });
      seeds.push(...locsOf(r.body));
    }
  } else {
    seeds = locsOf(idx.body);
  }
  seeds = [...new Set(seeds.map((x) => sameHost(x, BASE)).filter(Boolean))];
  seeds.push(BASE + '/');
  seeds = [...new Set(seeds)];
  console.log('种子 URL（sitemap）：' + seeds.length);

  // 2) 抓取：先种子，再按 --follow 逐层扩散
  const graph = new Map();      // page -> [out links]
  const inSitemap = new Set(seeds);
  let frontier = seeds.slice(0, MAX_PAGES);

  for (let depth = 0; depth <= FOLLOW && frontier.length; depth++) {
    console.log('第 ' + (depth + 1) + ' 层抓取：' + frontier.length + ' 个页面');
    const res = await pool(frontier, CONC, async (u) => {
      const t = targetOf(u);
      const r = await request({ url: t.url, hostHeader: t.hostHeader, proto: t.proto });
      const links = new Set();
      if (r.status === 200) {
        for (const m of r.body.matchAll(/<a\s[^>]*href="([^"]+)"/g)) {
          const l = sameHost(m[1].replace(/&amp;/g, '&'), u);
          if (l && l !== u) links.add(l);
        }
      }
      return { u, links: [...links], status: r.status };
    });
    const next = [];
    for (const r of res) {
      graph.set(r.u, r.links);
      for (const l of r.links) {
        if (!graph.has(l) && !next.includes(l)) next.push(l);
      }
    }
    frontier = next.slice(0, MAX_PAGES - graph.size);
  }

  // 3) 统计入链（目标限定为 sitemap 内页面，来源为所有已抓页面）
  const inbound = new Map();
  for (const [from, tos] of graph) {
    for (const t of tos) {
      if (!inSitemap.has(t)) continue;
      inbound.set(t, (inbound.get(t) || 0) + 1);
    }
  }
  const sm = [...inSitemap];
  const orphans = sm.filter((p) => !inbound.get(p));
  const weak = sm.filter((p) => (inbound.get(p) || 0) === 1);
  const avgIn = (sm.reduce((s, p) => s + (inbound.get(p) || 0), 0) / (sm.length || 1)).toFixed(1);
  const avgOut = ([...graph.values()].reduce((s, a) => s + a.length, 0) / (graph.size || 1)).toFixed(1);

  console.log('\n== 总览 ==');
  console.log('  抓取页面: ' + graph.size + '，sitemap URL: ' + sm.length);
  console.log('  平均入链: ' + avgIn + '，平均出链: ' + avgOut);
  console.log('  孤儿页（0 入链）: ' + orphans.length);
  console.log('  只有 1 条入链: ' + weak.length);

  // 按路径前缀分类，方便看出是哪一类页面在掉队
  const byPrefix = {};
  sm.forEach((p) => {
    const k = '/' + (p.split('/')[3] || '(根)');
    byPrefix[k] = byPrefix[k] || { n: 0, orphan: 0 };
    byPrefix[k].n++;
    if (!inbound.get(p)) byPrefix[k].orphan++;
  });
  console.log('\n== 按一级路径 ==');
  Object.entries(byPrefix).sort((a, b) => b[1].n - a[1].n).slice(0, 12)
    .forEach(([k, v]) => console.log('  ' + k.padEnd(14) + ' 页面 ' + String(v.n).padStart(5) + '  孤儿 ' + v.orphan));

  if (orphans.length) {
    console.log('\n== 孤儿页（前 20）==');
    orphans.slice(0, 20).forEach((p) => console.log('  ' + p + '  出链 ' + (graph.get(p) || []).length));
    console.log('\n提示：孤儿页先别急着加链接。多半是「入口在分页或详情页里」但没抓到，');
    console.log('      用 --follow 2 再跑一次，或者手工打开其中两个确认一下。');
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      pages: graph.size, sitemap: sm.length, orphans,
      inbound: Object.fromEntries(inbound),
    }, null, 2));
    console.log('\n明细已写入 ' + JSON_OUT);
  }
})();
