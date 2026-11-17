#!/usr/bin/env node
'use strict';
/**
 * indexnow-push —— 把 URL 批量提交给 IndexNow（必应 / Yandex / Seznam / Naver 共用）
 *
 * 为什么值得做：百度主动推送每天只有个位数额度，而 IndexNow 没有这个限制，
 * 提交后通常几分钟到几小时内就会被抓。前提是你的站能提供一个
 * 「文件名 = 内容 = 密钥」的 txt，放在根目录下可公开访问。
 *
 * 准备（一次性）：
 *   1. 生成一个 8~128 位的十六进制密钥，例如：openssl rand -hex 16
 *   2. 在站点根目录放一个同名 txt，内容就是这个密钥本身：
 *        echo "你的密钥" > public/你的密钥.txt
 *   3. 确认 https://你的域名/你的密钥.txt 能打开，且内容与密钥一致
 *
 * 用法：
 *   node bin/indexnow-push.js --host www.example.com --key 你的密钥
 *   node bin/indexnow-push.js --host www.example.com --key 你的密钥 --urls /a,/b,/c
 *   node bin/indexnow-push.js --host www.example.com --key 你的密钥 --from-sitemap sitemap-posts.xml
 *   node bin/indexnow-push.js ... --dry-run        # 只打印，不发请求
 *
 * 注意：
 *   · 单次最多 10000 条，脚本自动分批；
 *   · 不要拿它去刷别人的站 —— 密钥必须由目标站自己托管，否则会 403；
 *   · 提交前最好确认 URL 返回 200，提交 404 只会浪费额度。
 */
const https = require('https');
const { request, locsOf } = require('../lib/http');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes('--' + k);

const HOST = arg('host', '');
const KEY = arg('key', '');
const KEY_LOCATION = arg('keylocation', '');
const DRY = has('dry-run');
const FROM_SM = arg('from-sitemap', '');
const RAW_URLS = arg('urls', '');
const CONC_CHECK = Number(arg('check', '0')) || 0;

if (!HOST || !KEY) {
  console.error('用法：node bin/indexnow-push.js --host www.example.com --key <密钥> [--urls /a,/b | --from-sitemap sitemap-posts.xml]');
  process.exit(2);
}
if (!/^https?:\/\//.test(HOST) && HOST.includes('/')) {
  console.error('--host 只写主机名，不要带路径');
  process.exit(2);
}
const ORIGIN = /^https?:\/\//.test(HOST) ? HOST.replace(/\/+$/, '') : 'https://' + HOST;
const HOSTNAME = new URL(ORIGIN).hostname;
const KEY_URL = KEY_LOCATION || (ORIGIN + '/' + KEY + '.txt');

(async () => {
  // 1) 收集 URL
  let urls = [];
  if (RAW_URLS) {
    urls = RAW_URLS.split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => (/^https?:\/\//.test(s) ? s : ORIGIN + (s.startsWith('/') ? s : '/' + s)));
  } else if (FROM_SM) {
    const r = await request({ url: ORIGIN + '/' + FROM_SM.replace(/^\/+/, '') });
    if (r.status !== 200) { console.error('读不到 sitemap：' + FROM_SM); process.exit(1); }
    urls = locsOf(r.body);
    console.log('从 ' + FROM_SM + ' 读到 ' + urls.length + ' 条');
  } else {
    console.error('请给 --urls 或 --from-sitemap');
    process.exit(2);
  }
  urls = [...new Set(urls)];
  if (!urls.length) { console.error('没有可提交的 URL'); process.exit(1); }

  // 2) 可选：先探一遍状态码，404/410 不提交
  if (CONC_CHECK > 0) {
    console.log('预检 ' + urls.length + ' 条（并发 ' + CONC_CHECK + '）…');
    const { pool } = require('../lib/http');
    const keep = [];
    await pool(urls, CONC_CHECK, async (u) => {
      const r = await request({ url: u, timeout: 10000 });
      if (r.status === 200) keep.push(u);
    });
    console.log('  预检通过 ' + keep.length + ' 条，丢弃 ' + (urls.length - keep.length));
    urls = keep;
    if (!urls.length) process.exit(0);
  }

  // 3) 分批提交
  const BATCH = 10000;
  let okCount = 0;
  for (let i = 0; i < urls.length; i += BATCH) {
    const chunk = urls.slice(i, i + BATCH);
    const payload = JSON.stringify({
      host: HOSTNAME,
      key: KEY,
      keyLocation: KEY_URL,
      urlList: chunk,
    });
    if (DRY) {
      console.log('[dry-run] 将提交 ' + chunk.length + ' 条，首条 ' + chunk[0]);
      continue;
    }
    const res = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.indexnow.org', path: '/indexnow', method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 20000,
      }, (r) => {
        const cs = [];
        r.on('data', (c) => cs.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(cs).toString('utf8') }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
      req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
      req.write(payload);
      req.end();
    });
    // 200 = 接收成功；202 = 接收但待校验密钥；400/403 多为密钥或格式问题
    const ok = res.status === 200 || res.status === 202;
    console.log('批次 ' + (i / BATCH + 1) + '：' + chunk.length + ' 条，HTTP ' + res.status +
      (ok ? ' ✓' : ' ✗ ' + res.body.slice(0, 200)));
    if (ok) okCount += chunk.length;
  }
  if (!DRY) console.log('\n完成，成功提交 ' + okCount + ' / ' + urls.length + ' 条');
  console.log('密钥位置：' + KEY_URL + '（提交前请确认它返回 200 且内容是密钥本身）');
})();
