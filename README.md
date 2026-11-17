# nav-site-ops

> 这四个脚本来自 [Kan112 AI 网址导航](https://www.kan112.com/) 的日常运维 —— 一个收录 1,000+ AI 工具与建站资源的导航站，也记录建站过程中的排查实录。

四个零依赖的 Node 脚本，用来处理内容站最常见的三件事：**sitemap 体检、站内链接图、索引提交**，外加一个静态资源预压缩工具。

写成这样是因为踩过坑：站点上线两个月，Search Console 里「未编入索引」堆到三千多，「已编入索引」停在 33 页三周没动。翻遍报告才发现，问题不在内容质量（2,654 个页面全部 200、canonical 全自指、零重复内容），而是三件小事叠在一起：

- sitemap 里混着 211 条带 `noindex` 的页面，地图说"请收录"、页面说"别收录"；
- 一个有一千多条出链的枢纽页，站内没有任何链接指向它；
- 提交索引全靠手工，想起来才做一次。

脚本就是那时候写的。没有框架、没有依赖、`clone` 下来直接 `node bin/xxx.js` 就能跑。

## 要求

- Node.js 18 或以上（用到 `zlib.brotliCompressSync` 和 `URL`）
- 不需要 `npm install`，没有第三方包

## 四个工具

| 脚本 | 干什么 | 什么时候用 |
|---|---|---|
| `bin/sitemap-audit.js` | 按 sitemap 逐页查状态码、canonical、noindex、重复内容、薄页 | 怀疑「页面本身不合格」时，先用它排除 |
| `bin/link-graph.js` | 抓站内链接，算入链，找孤儿页 | 页面进不了索引、想知道是不是没人链它 |
| `bin/indexnow-push.js` | 批量提交 URL 给 IndexNow（必应等） | 新内容发布后 |
| `bin/precompress.js` | 生成 `.gz` / `.br` 预压缩副本 | 部署最后一步，改了 js/css 之后 |

## 快速开始

```bash
git clone https://github.com/zs6755413/nav-site-ops.git
cd nav-site-ops
node bin/sitemap-audit.js --base https://www.example.com --limit 50
```

`--limit` 先跑 50 条看看输出长什么样，别一上来就全量。

---

### 1. sitemap-audit：先分清"没来抓"还是"不合格"

```bash
# 全量（自动从 sitemap.xml 找出所有分片）
node bin/sitemap-audit.js --base https://www.example.com --conc 4 --json /tmp/audit.json

# 直连源站绕过 CDN，但 Host 头仍用真实域名（等价于 curl --resolve）
node bin/sitemap-audit.js --base https://www.example.com --resolve 127.0.0.1:8080

# 只查某几个分片
node bin/sitemap-audit.js --base https://www.example.com --sitemaps sitemap-posts.xml,sitemap-qa.xml
```

输出会告诉你：状态码分布、canonical 非自指的条数、带 noindex 的条数、正文不足 600 字的薄页数、重复内容组。

**怎么读**：如果 4xx/5xx 接近 0、canonical 全自指、重复组为 0，那页面本身没问题，别再改模板了 —— 问题在抓取侧，去看 Search Console 的「抓取统计信息」和「链接数量」。

### 2. link-graph：找孤儿页（但别被自己的抓取范围骗了）

```bash
node bin/link-graph.js --base https://www.example.com --follow 2 --conc 4
```

**这条命令有个必须知道的坑**：如果只抓 sitemap 里的 URL，孤儿页数量会被严重高估。因为分类页的分页（`?page=2`）、论坛列表、详情页里的相关推荐都不在 sitemap 里，而它们才是真实的链接入口。

我第一次跑，563 个工具页报出 165 个孤儿。**这是错的。** 补抓分类页的分页之后，只剩 4 个；再往下抓工具详情页，发现那 4 个也被父条目的"同产品另见"区块链着 —— 真实孤儿是 0。

一个数字从 165 掉到 0，全程没改一行页面代码，改的只是抓取范围。

所以流程是：先 `--follow 0` 看个大概（数字一定虚高），再 `--follow 2` 复核，最后手工打开两个"孤儿"确认。**确认之前不要动手加链接。**

### 3. indexnow-push：比百度推送宽松得多的通道

准备阶段（只做一次）：

```bash
# 1. 生成密钥
openssl rand -hex 16

# 2. 放到站点根目录，文件名就是密钥，内容是密钥本身
echo "刚才生成的那串" > public/刚才生成的那串.txt

# 3. 确认能公开访问，且内容一致
curl https://www.example.com/刚才生成的那串.txt
```

之后：

```bash
# 推一篇文章
node bin/indexnow-push.js --host www.example.com --key 刚才生成的那串 --urls /post/abc

# 推整个 sitemap 分片，先预检 404
node bin/indexnow-push.js --host www.example.com --key 那串 \
  --from-sitemap sitemap-posts.xml --check 6

# 只看看会提交什么
node bin/indexnow-push.js --host www.example.com --key 那串 --from-sitemap sitemap-posts.xml --dry-run
```

`HTTP 200` = 接收成功，`202` = 接收但待校验密钥，`403` = 密钥文件校验不过（九成是路径或内容不对）。

### 4. precompress：解决"改了没生效"

```bash
node bin/precompress.js --dir public
node bin/precompress.js --dir public --ext .js,.css,.html --dry-run
```

nginx 需要配合：

```nginx
gzip_static on;
brotli_static on;   # 需要 ngx_brotli 模块
```

不生成副本的后果很具体：改了 CSS，浏览器拿到的还是旧的 `.css.gz`，强刷、换设备、换浏览器都没用 —— 因为服务端就没发新的。

---

## 一点经验

- **别在生产机上全量跑。** 这些脚本会真的发几千个请求。并发默认 4，够用；站点弱的话降到 2。
- **先用 `--limit` 和 `--dry-run`。** 尤其是 `indexnow-push`，提交 404 是纯浪费。
- **cron 里跑记得加日志重定向**，出问题才有痕迹：
  ```
  0 6 * * * cd /path/to/site && node bin/indexnow-push.js --host ... --from-sitemap sitemap-posts.xml --check 4 >> /var/log/indexnow.log 2>&1
  ```

## 更新记录

- [2026-11-17：把「怎么读输出」补上](docs/2026-11-17-update.md) —— 没有新增命令。补的是每个工具的判读标准、安全阀参数、直连源站的头处理，以及什么情况下不该用这套东西。

## 关于

脚本来自 [Kan112 AI 网址导航](https://www.kan112.com/) 的日常运维。站点是一个 AI 工具与建站资源库，同时记录建站过程中的排查过程，包括上面这些坑是怎么踩出来的。

脚本按原样提供。涉及 `systemd`、`data/` 目录、真实域名的操作请先读懂再跑，出问题自己负责。

## 使用许可

**不是开源项目，是源码可见。** 保留所有权利。

- **可以直接用**：阅读源码、复制片段学习、个人非商业自用；
- **需要事先取得书面授权**：任何商业用途（公司内部生产、对外收费产品、接客户项目、SaaS）、再分发、去除版权声明、基于它做竞争产品。

完整条款见 [LICENSE](LICENSE)。商业授权请联系 [站点联系页](https://www.kan112.com/contact.html)。

说明一下原因：脚本本身会对目标站发起大量请求，随便给人商用，出了问题溯源很难。
个人拿去研究、跑自己的站，完全不需要打招呼。
