'use strict';
/**
 * 极简 HTTP 客户端：只做一件事 —— 用指定 Host 头去请求一台机器。
 *
 * 为什么不用 fetch / axios：
 *   ① 要能直连源站（127.0.0.1:8080）却带上真实域名做 Host 头，等价于 curl 的 --resolve；
 *   ② 要能自己解 gzip / brotli，因为源站多半开了压缩，不解压就统计不到正文长度；
 *   ③ 零依赖 —— 别人 clone 下来 `node bin/xxx.js` 就能跑，不用 npm i。
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const DEFAULT_UA = 'Mozilla/5.0 (compatible; SiteOpsAudit/1.0; bot)';

/**
 * @param {object} o
 * @param {string} o.url       完整 URL（https://example.com/a 或 http://127.0.0.1:8080/a）
 * @param {string} [o.hostHeader] Host 头，直连源站时必须给真实域名
 * @param {string} [o.proto] X-Forwarded-Proto 取值。直连源站时**必须**传原始协议：
 *        源站通常按这个头判断要不要 301 跳到 https，传错就会拿到一整页 301。
 * @param {string} [o.ua]
 * @param {number} [o.timeout]
 * @returns {Promise<{status:number, headers:object, body:string, bytes:number}>}
 */
function request(o) {
  const u = new URL(o.url);
  const lib = u.protocol === 'https:' ? https : http;
  const headers = {
    'User-Agent': o.ua || DEFAULT_UA,
    'Accept-Encoding': 'gzip, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (o.hostHeader) {
    headers.Host = o.hostHeader;
    headers['X-Forwarded-Proto'] = o.proto || (u.protocol === 'https:' ? 'https' : 'http');
  }
  return new Promise((resolve) => {
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'GET', headers,
        timeout: o.timeout || 20000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          } catch (e) { /* 解不开就按原样返回，至少状态码还有用 */ }
          resolve({ status: res.statusCode || 0, headers: res.headers, body: buf.toString('utf8'), bytes: buf.length });
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '', bytes: 0 }); });
    req.on('error', () => resolve({ status: 0, headers: {}, body: '', bytes: 0 }));
    req.end();
  });
}

/** 把任意 URL 折成「协议 + 主机 + 路径」的规范形式，去掉末尾斜杠 */
function normalize(u, base) {
  try {
    const x = new URL(u, base);
    return x.origin + (x.pathname.replace(/\/+$/, '') || '/') + (x.search || '');
  } catch (e) { return ''; }
}

/** 极简并发池：控制同时在飞的请求数，别把人家站打疼 */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const k = i++;
      out[k] = await worker(items[k], k);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, run));
  return out;
}

/** 从 sitemap XML 里抽 <loc>（支持 sitemap index 递归一层） */
function locsOf(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].trim());
}

module.exports = { request, normalize, pool, locsOf, DEFAULT_UA };
