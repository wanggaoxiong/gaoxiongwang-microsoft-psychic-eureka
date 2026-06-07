/**
 * 通用 source listing crawler
 *
 * 用 Playwright 加载货源的"列表/主页"，模拟用户下滑加载更多，
 * 然后用三条管线提取商品候选：
 *
 *   1) network — 监听 page.on('response') 收集所有 JSON 响应，
 *      递归遍历找出含 {code, 主图} 字段的对象。Vue/React SPA 的商品列表
 *      接口几乎总会被这条管线挖到，结果最干净。（gxhyapp 的
 *      /market/api/... 接口正是这种）
 *
 *   2) dom — 在浏览器里找匹配该 source 详情页 URL 模式的 <a>，
 *      并就近找它附属的 <img> 当主图。仅作为兜底（很多 SPA 用
 *      onclick + router.push，根本没 href，命中率低）。
 *
 *   3) ai-assisted (TODO) — 当 1+2 都很少时，把渲染后的截图 + DOM 摘要
 *      喂给已配置的 AI 模型，让模型把"哪个区域对应哪个商品"抽出来。
 *
 * 注意：这里**不**抓详情页内容（那一步走 /api/suppliers/scrape），
 * 只把 (detailUrl, mainImage, title?, priceHint?) 这种"候选卡片"挖出来。
 */

import { chromium, type Browser } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type CrawlCandidate = {
  detailUrl: string;
  sourceCode: string;
  mainImage: string;
  title?: string;
  priceHint?: string;
  merchantHint?: string;
};

export type CrawlResult = {
  startUrl: string;
  scannedAnchors: number;
  scannedImages: number;
  scannedJsonResponses: number;
  scannedXhrRequests: number;
  scannedCards: number;
  sampleXhrUrls: string[];
  candidates: CrawlCandidate[];
  via: 'network' | 'dom' | 'card' | 'network+dom' | 'network+card' | 'dom+card' | 'network+dom+card';
  warnings: string[];
};

const VIEWPORT = { width: 414, height: 896 } as const;
const STATIC_EXT = /\.(js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp4|m4s|wasm)(\?|$)/i;
const NAV_TIMEOUT_MS = 45_000;
const HYDRATION_WAIT_MS = 3500;
// 慢站（如 gxhyapp）首屏常要十几秒、还会弹「加载超时,点击刷新」。给足耐心 + 自动点刷新重试。
const PRODUCT_WAIT_BUDGET_MS = 40_000;
const PRODUCT_WAIT_POLL_MS = 1_000;
const MAX_RELOAD_RETRIES = 2;
const MAX_SCROLLS = 8;
const SCROLL_DELAY_MS = 800;
// 部分站（如 gxhyapp）用「下一页」按钮显式翻页（非无限滚动），单页仅十几个商品。
// 扫描时自动翻页累积，最多翻这么多页，避免无限循环。
const MAX_PAGES = 30;

let cachedBrowserPromise: Promise<Browser> | null = null;

const STATE_DIR = path.join(process.cwd(), 'data', 'playwright-state');

function stateFilePath(sourceId: string) {
  return path.join(STATE_DIR, `${sourceId}.json`);
}

async function loadStorageState(sourceId: string): Promise<string | undefined> {
  const p = stateFilePath(sourceId);
  try {
    await fs.access(p);
    return p;
  } catch {
    return undefined;
  }
}

export async function hasStoredSession(sourceId: string): Promise<boolean> {
  return !!(await loadStorageState(sourceId));
}

/**
 * 启动一个 headed Chromium 让用户手动登录，关闭窗口后把 cookies/localStorage
 * 持久化到 data/playwright-state/<sourceId>.json，下次 crawl 时自动加载。
 */
export async function openLoginSession(
  sourceId: string,
  loginUrl: string
): Promise<{ saved: boolean; stateFile: string }> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const stateFile = stateFilePath(sourceId);
  const existing = await loadStorageState(sourceId);

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation']
  });
  try {
    const loginRule = pickRule(sourceId);
    const context = await browser.newContext({
      viewport: loginRule?.viewport ?? VIEWPORT,
      userAgent: loginRule?.userAgent ?? MOBILE_UA,
      deviceScaleFactor: loginRule?.viewport ? 1 : 2,
      locale: 'zh-CN',
      storageState: existing
    });
    await installBrowserEvasions(context);
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);

    // 等用户手动关闭页面/窗口（最长 10 分钟）
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 10 * 60 * 1000);
      page.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      browser.on('disconnected', () => {
        clearTimeout(t);
        resolve();
      });
    });

    try {
      await context.storageState({ path: stateFile });
      return { saved: true, stateFile };
    } catch {
      return { saved: false, stateFile };
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function getBrowser(): Promise<Browser> {
  if (!cachedBrowserPromise) {
    cachedBrowserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation']
    });
    const close = async () => {
      try {
        const b = await cachedBrowserPromise;
        await b?.close();
      } catch {
        /* ignore */
      }
    };
    process.once('exit', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }
  return cachedBrowserPromise;
}

async function installBrowserEvasions(context: import('playwright').BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
}

/**
 * 各 source 怎么从一个原始记录构造详情页 URL + 规范化 sourceCode。
 */
type DetailRule = {
  sourceId: string;
  /** 从 anchor.href 中识别 detail page */
  matchHref: (href: string) => { sourceCode: string; detailUrl: string } | null;
  /** 从 raw JSON 对象的字段构造详情页 URL（已知 code 时） */
  buildDetailUrl: (code: string, raw?: Record<string, any>) => string;
  /** 可选：覆盖默认（移动端 iPhone）UA。某些站桌面端列表更稳/更快（如 gxhyapp）。 */
  userAgent?: string;
  /** 可选：覆盖默认移动视口。配合 desktop UA 用。 */
  viewport?: { width: number; height: number };
};

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const DETAIL_RULES: DetailRule[] = [
  {
    sourceId: 'gxhyapp',
    // gxhyapp 移动端 SPA 会弹「立即打开 APP」拦截 + 卡在「加载中」；桌面端直接渲染商品网格，
    // 与用户在浏览器里看到的一致。所以列表抓取走桌面 UA + 桌面视口。
    userAgent: DESKTOP_UA,
    viewport: { width: 1366, height: 900 },
    matchHref(href) {
      try {
        const abs = href.startsWith('http')
          ? new URL(href)
          : new URL(href, 'https://mall.gxhyapp.com');
        if (abs.pathname.includes('/market/web/detailIndex')) {
          const code = abs.searchParams.get('code');
          const marketCode = abs.searchParams.get('marketCode') ?? 'gz';
          if (code && /^\d{6,}$/.test(code)) {
            return {
              sourceCode: code,
              detailUrl: `https://mall.gxhyapp.com/market/web/detailIndex?marketCode=${encodeURIComponent(
                marketCode
              )}&code=${encodeURIComponent(code)}`
            };
          }
        }
        const hashMatch = abs.hash.match(/\/goods\/(\d{6,})/);
        if (hashMatch) {
          const code = hashMatch[1];
          return {
            sourceCode: code,
            detailUrl: `https://mall.gxhyapp.com/market/web/detailIndex?marketCode=gz&code=${code}`
          };
        }
      } catch {
        /* ignore */
      }
      return null;
    },
    buildDetailUrl(code, raw) {
      const marketCode =
        (raw && (raw.marketCode || raw.market_code || raw.areaCode)) || 'gz';
      return `https://mall.gxhyapp.com/market/web/detailIndex?marketCode=${encodeURIComponent(
        marketCode
      )}&code=${encodeURIComponent(code)}`;
    }
  },
  {
    sourceId: '90ii',
    matchHref(href) {
      try {
        const abs = href.startsWith('http') ? new URL(href) : new URL(href, 'https://www.90ii.net');
        if (abs.hostname !== 'www.90ii.net') return null;
        const m = abs.pathname.match(/^\/products\/(\d+)$/);
        if (m) {
          const code = m[1];
          return {
            sourceCode: code,
            detailUrl: `https://www.90ii.net/products/${code}`
          };
        }
      } catch {
        /* ignore */
      }
      return null;
    },
    buildDetailUrl(code) {
      return `https://www.90ii.net/products/${code}`;
    }
  }
];

function pickRule(sourceId: string): DetailRule | null {
  return DETAIL_RULES.find((r) => r.sourceId === sourceId) ?? null;
}

/**
 * 浏览器侧脚本：扫所有 <a> 拿到 href + 邻近图片/价格。仅用于 DOM 兜底。
 */
function pageEvalScript(): Array<{
  href: string;
  text: string;
  imgSrc: string;
  priceText: string;
}> {
  const result: Array<{ href: string; text: string; imgSrc: string; priceText: string }> = [];

  function imgOf(node: Element): string {
    const img = node.querySelector('img');
    if (img) {
      const lazy =
        img.getAttribute('data-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('data-lazy') ||
        '';
      const src = img.getAttribute('src') || '';
      const chosen = lazy && !lazy.startsWith('data:') ? lazy : src;
      if (chosen && !chosen.startsWith('data:')) return chosen;
    }
    const bg = window.getComputedStyle(node as HTMLElement).backgroundImage;
    const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
    if (m && m[1] && !m[1].startsWith('data:')) return m[1];
    return '';
  }

  function priceOf(node: Element): string {
    const txt = (node.textContent || '').trim();
    const m = txt.match(/[¥￥]\s*\d[\d.,]*/);
    return m ? m[0] : '';
  }

  const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (!href) continue;
    const text = (a.textContent || '').trim().slice(0, 120);
    let imgSrc = imgOf(a);
    let priceText = priceOf(a);
    if (!imgSrc || !priceText) {
      let p: Element | null = a.parentElement;
      let hop = 0;
      while (p && hop < 3) {
        if (!imgSrc) imgSrc = imgOf(p);
        if (!priceText) priceText = priceOf(p);
        if (imgSrc && priceText) break;
        p = p.parentElement;
        hop += 1;
      }
    }
    result.push({ href, text, imgSrc, priceText });
  }
  return result;
}

/**
 * 浏览器侧：找渲染好的"商品卡片"（含 img + ¥价格 的紧凑容器），并从 onclick / dataset
 * / Vue 实例 / 文本中抠出 6+ 位数字商品 code。专门给 onclick + router.push 型 SPA 用。
 */
function pageCardScript(): {
  cards: Array<{ code: string; imgSrc: string; title: string; priceText: string }>;
  samples: string[];
  sampleImgUrls: string[];
} {
  const out: Array<{ code: string; imgSrc: string; title: string; priceText: string }> = [];
  const seenCodes = new Set<string>();
  const samples: string[] = [];
  const sampleImgUrls: string[] = [];

  function imgSrcOf(img: HTMLImageElement): string {
    const lazy =
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy') ||
      '';
    const src = img.getAttribute('src') || '';
    const chosen = lazy && !lazy.startsWith('data:') ? lazy : src;
    return chosen && !chosen.startsWith('data:') ? chosen : '';
  }

  function imgOf(node: Element): string {
    const imgs = Array.from(node.querySelectorAll('img')) as HTMLImageElement[];
    const urls = imgs.map(imgSrcOf).filter(Boolean);
    // gxhyapp 商品主图在 aliyizhan /person/{shopUuid}/{productUuid}/N.jpg 下；商家头像在 upload-file/userIcon。
    return urls.find((u) => /\/person\/[0-9a-z]+\/[0-9a-z]{16,}\//i.test(u)) || urls[0] || '';
  }

  function productUuidFromImg(src: string): string | null {
    const m = src.match(/\/person\/[0-9a-z]+\/([0-9a-z]{16,})\//i);
    return m ? m[1] : null;
  }

  function extractCode(el: Element): string | null {
    const onclick = el.getAttribute('onclick') || '';
    let m = onclick.match(/(?:code|goodsId|productId|spuId|id)\s*[:=]\s*['"]?(\d{6,})/i);
    if (m) return m[1];
    m = onclick.match(/['"](\d{6,})['"]/);
    if (m) return m[1];

    const ds = (el as HTMLElement).dataset || {};
    for (const v of Object.values(ds)) {
      if (typeof v === 'string') {
        const mm = v.match(/^\d{6,}$/);
        if (mm) return mm[0];
      }
    }

    // 扫所有属性找 6+ 位数字
    for (const attr of Array.from(el.attributes)) {
      const mm = attr.value.match(/(?<!\d)(\d{6,})(?!\d)/);
      if (mm) return mm[1];
    }

    // Vue 2 实例
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vue = (el as any).__vue__ || (el as any).__vueParentComponent;
    if (vue) {
      try {
        const cand =
          vue.code ||
          vue.goodsCode ||
          vue.productCode ||
          (vue.item && (vue.item.code || vue.item.goodsCode || vue.item.id)) ||
          (vue.product && (vue.product.code || vue.product.id));
        if (cand && /^\d{6,}$/.test(String(cand))) return String(cand);
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  const candidates = Array.from(document.querySelectorAll('a, div, li, section, article')).sort(
    (a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length
  );
  for (const node of candidates) {
    const text = (node.textContent || '').trim();
    if (!/[¥￥]\s*\d/.test(text)) continue;
    const imgSrc = imgOf(node);
    if (!imgSrc) continue;
    const productUuid = productUuidFromImg(imgSrc);
    if (!productUuid && text.length > 400) continue;

    // 抽样：保留前 3 个卡片的 outerHTML 与 img URL 给诊断
    if (samples.length < 3) {
      samples.push((node as HTMLElement).outerHTML.slice(0, 1500));
    }
    if (sampleImgUrls.length < 6) sampleImgUrls.push(imgSrc);

    // 沿父链找真实 code（仅认 onclick/dataset/Vue 实例里的 code 字段）
    let cur: Element | null = node;
    let code: string | null = null;
    let hop = 0;
    while (cur && hop < 5) {
      const c = extractCode(cur);
      // 关键防呆：拒绝「其实是图片 URL/UUID 里的数字片段」的假 code。
      // gxhyapp 的 aliyizhan 主图 UUID（32 位 hex）里常含 6+ 位连续数字，
      // 早期实现会把它误当成商品 code → 构造出的详情页 URL 与实物对不上、
      // 进而导致 AI 提取商品信息失败。凡是出现在 imgSrc 里的数字串一律不认。
      if (c && !imgSrc.includes(c)) {
        code = c;
        break;
      }
      cur = cur.parentElement;
      hop += 1;
    }
    // 没拿到真实 code：退化用主图里稳定且唯一的 productUuid 作为标识
    // （aliyizhan 目录规则 /person/{shopUuid}/{productUuid}/N.jpg）。
    // 这样去重正确、且跨「源站每次访问重新排序」依然稳定；AI 提取靠主图组图，不依赖详情 code。
    if (!code) code = productUuid;
    if (!code) continue;
    if (seenCodes.has(code)) continue;
    seenCodes.add(code);

    const priceMatch = text.match(/[¥￥]\s*\d[\d.,]*/);
    const titleEl = node.querySelector('p, h1, h2, h3, h4, span');
    const title = (titleEl?.textContent || text).trim().replace(/\s+/g, ' ').slice(0, 80);
    out.push({
      code,
      imgSrc,
      title,
      priceText: priceMatch ? priceMatch[0] : ''
    });
  }
  return { cards: out, samples, sampleImgUrls };
}

async function autoScroll(page: import('playwright').Page) {
  for (let i = 0; i < MAX_SCROLLS; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await page.waitForTimeout(SCROLL_DELAY_MS);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * 慢站耐心等首屏商品。gxhyapp 这类站首屏要十几秒，期间可能弹「加载超时,点击刷新」对话框，
 * 或停在「加载中…」。本函数轮询直到：① 出现 >3 张图（商品渲染了）或已捕获到接口 JSON，
 * 或 ② 预算耗尽。遇到「加载超时/刷新/确定」按钮会自动点掉并 reload 重试，最多 MAX_RELOAD_RETRIES 次。
 */
async function waitForProductsPatiently(
  page: import('playwright').Page,
  hasJson: () => boolean,
  listingUrl: string
): Promise<void> {
  let reloads = 0;
  const start = Date.now();
  while (Date.now() - start < PRODUCT_WAIT_BUDGET_MS) {
    // 已经拿到接口数据，或页面真正渲染出商品信号 → 提前结束等待。
    // 不能只看 img 数量：gxhyapp 首屏的 logo / 下载二维码 / 占位图就能凑够 4-5 张，
    // 会导致商品还没出来就开始采集，最终表现为「图 5 / 卡片 0」。
    const pageSignals = await page
      .evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
        const urls = imgs
          .map(
            (img) =>
              img.getAttribute('data-src') ||
              img.getAttribute('data-original') ||
              img.getAttribute('data-lazy') ||
              img.getAttribute('src') ||
              ''
          )
          .filter((u) => u && !u.startsWith('data:'));
        return {
          imgCount: imgs.length,
          productImgCount: urls.filter((u) => /\/person\/[0-9a-z]+\/[0-9a-z]{16,}\//i.test(u)).length,
          hasPrice: /[¥￥]\s*\d/.test(document.body?.innerText || ''),
          stuckLoading: /Loading|加载中|加载超时|点击刷新|网络异常|请求超时/i.test(document.body?.innerText || '')
        };
      })
      .catch(() => ({ imgCount: 0, productImgCount: 0, hasPrice: false, stuckLoading: false }));
    if (hasJson() || pageSignals.productImgCount > 0 || (pageSignals.imgCount > 3 && pageSignals.hasPrice)) return;

    if (pageSignals.stuckLoading && reloads < MAX_RELOAD_RETRIES) {
      reloads += 1;
      await page
        .goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
        .catch(() => undefined);
      await page.waitForTimeout(2500);
      continue;
    }

    // 处理「加载超时,点击刷新」之类的拦截对话框/按钮
    if (reloads < MAX_RELOAD_RETRIES) {
      const clicked = await page
        .evaluate(() => {
          const btns = Array.from(
            document.querySelectorAll('button, a, div, span')
          ) as HTMLElement[];
          const hit = btns.find((el) => {
            const t = (el.textContent || '').trim();
            return (
              /^(确定|刷新|重新加载|重试|reload|retry|refresh)$/i.test(t) ||
              /点击刷新|加载超时|网络异常|请求超时/i.test(t)
            );
          });
          if (hit) {
            hit.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
      if (clicked) {
        reloads += 1;
        await page.waitForTimeout(1500);
        await page
          .goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
          .catch(() => undefined);
        await page.waitForTimeout(2500);
        continue;
      }
    }

    await page.waitForTimeout(PRODUCT_WAIT_POLL_MS);
  }

  // 预算内仍没内容：如果还有 reload 额度，硬 reload 再等一小段
  if (!hasJson() && reloads < MAX_RELOAD_RETRIES) {
    await page
      .goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      .catch(() => undefined);
    const reloadStart = Date.now();
    while (Date.now() - reloadStart < PRODUCT_WAIT_BUDGET_MS / 2) {
      const ready = await page
        .evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
          const productImgCount = imgs.filter((img) => {
            const src =
              img.getAttribute('data-src') ||
              img.getAttribute('data-original') ||
              img.getAttribute('data-lazy') ||
              img.getAttribute('src') ||
              '';
            return /\/person\/[0-9a-z]+\/[0-9a-z]{16,}\//i.test(src);
          }).length;
          return productImgCount > 0 || /[¥￥]\s*\d/.test(document.body?.innerText || '');
        })
        .catch(() => false);
      if (hasJson() || ready) break;
      await page.waitForTimeout(PRODUCT_WAIT_POLL_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// JSON 挖矿：递归遍历任意 JSON 树，找出"长得像商品"的对象
// ---------------------------------------------------------------------------

const CODE_KEYS = [
  'code',
  'goodsCode',
  'productCode',
  'itemCode',
  'sourceCode',
  'spuCode'
];
const IMG_KEYS = [
  'mainImage',
  'mainImg',
  'mainPic',
  'coverImg',
  'coverImage',
  'cover',
  'imageUrl',
  'imgUrl',
  'image',
  'img',
  'pic',
  'picUrl',
  'thumb',
  'thumbnail'
];
const TITLE_KEYS = ['title', 'name', 'goodsName', 'productName', 'itemTitle', 'spuName'];
const PRICE_KEYS = [
  'price',
  'priceStr',
  'salePrice',
  'shopPrice',
  'sellPrice',
  'minPrice',
  'showPrice'
];
const MERCHANT_KEYS = [
  'merchantName',
  'shopName',
  'storeName',
  'supplierName',
  'sellerName'
];

function pickStringField(obj: Record<string, any>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/** 把 // 或 / 开头的链接补全为绝对 URL */
function absolutizeUrl(u: string, base: string): string {
  if (!u) return u;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  if (u.startsWith('//')) return `https:${u}`;
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
}

function gxhyappProductUuidFromImage(src?: string): string | null {
  if (!src) return null;
  const m = src.match(/\/person\/[0-9a-z]+\/([0-9a-z]{16,})\//i);
  return m ? m[1] : null;
}

function canonicalSourceCode(sourceId: string, code: string, mainImage?: string): string {
  if (sourceId === 'gxhyapp') return gxhyappProductUuidFromImage(mainImage) ?? code;
  return code;
}

type RawProduct = {
  code: string;
  mainImage: string;
  title?: string;
  price?: string;
  merchant?: string;
  raw: Record<string, any>;
};

function walkForProducts(
  node: unknown,
  out: RawProduct[],
  seenCodes: Set<string>,
  baseUrl: string,
  depth = 0
): void {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForProducts(item, out, seenCodes, baseUrl, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, any>;

  const code = pickStringField(obj, CODE_KEYS);
  const img = pickStringField(obj, IMG_KEYS);
  if (code && /^\d{6,}$/.test(code) && img && !seenCodes.has(code)) {
    seenCodes.add(code);
    out.push({
      code,
      mainImage: absolutizeUrl(img, baseUrl),
      title: pickStringField(obj, TITLE_KEYS),
      price: pickStringField(obj, PRICE_KEYS),
      merchant: pickStringField(obj, MERCHANT_KEYS),
      raw: obj
    });
  }

  for (const v of Object.values(obj)) {
    if (v && (typeof v === 'object' || Array.isArray(v))) {
      walkForProducts(v, out, seenCodes, baseUrl, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function crawlSourceListing(
  sourceId: string,
  listingUrl: string
): Promise<CrawlResult> {
  const rule = pickRule(sourceId);
  const warnings: string[] = [];
  if (!rule) warnings.push(`未配置 ${sourceId} 的 DetailRule，仅返回 DOM 兜底结果`);

  const browser = await getBrowser();
  const storageState = await loadStorageState(sourceId);
  if (storageState) warnings.push(`已加载持久化登录 session: ${path.basename(storageState)}`);
  const context = await browser.newContext({
    viewport: rule?.viewport ?? VIEWPORT,
    userAgent: rule?.userAgent ?? MOBILE_UA,
    deviceScaleFactor: rule?.viewport ? 1 : 2,
    storageState,
    locale: 'zh-CN'
  });
  await installBrowserEvasions(context);

  // 网络挖矿：把所有 JSON 响应都收集起来，扫描结束后统一遍历
  const jsonPayloads: Array<{ url: string; data: unknown }> = [];

  try {
    const page = await context.newPage();

    // 调试用：记录所有 xhr/fetch 请求（method + postData）以便重取 body
    type XhrReq = { url: string; method: string; postData: string | null };
    const xhrReqs: XhrReq[] = [];
    const xhrKeySeen = new Set<string>();
    const xhrUrls: string[] = [];
    page.on('request', (req) => {
      const t = req.resourceType();
      if (t === 'xhr' || t === 'fetch') {
        const url = req.url();
        const method = req.method();
        const postData = req.postData();
        const key = `${method} ${url} ${postData ?? ''}`;
        if (!xhrKeySeen.has(key)) {
          xhrKeySeen.add(key);
          xhrReqs.push({ url, method, postData });
          xhrUrls.push(url);
        }
      }
    });

    // 直接捕获原始 in-page 响应体（关键）：SPA 的列表接口（如 api.gxhy1688.com）常用 header
    // 里的 token 鉴权；后面的「XHR 重放」用 fetch+credentials 会丢掉这个 header → 拿不到数据。
    // 这里直接读原始请求的响应体（已带正确 token），命中率远高于重放。
    const directBodySeen = new Set<string>();
    page.on('response', async (resp) => {
      try {
        const req = resp.request();
        const t = req.resourceType();
        if (t !== 'xhr' && t !== 'fetch') return;
        const url = resp.url();
        if (directBodySeen.has(url)) return;
        if (STATIC_EXT.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return;
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        // content-type 是 json，或没标 content-type 但 URL 像接口 —— 都尝试解析
        const looksApi = /json/.test(ct) || /\/(api|market|goods|product|list|search|screening)/i.test(url);
        if (!looksApi) return;
        const text = await resp.text().catch(() => '');
        if (!text) return;
        const trimmed = text.trimStart();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
        const data = JSON.parse(trimmed);
        directBodySeen.add(url);
        jsonPayloads.push({ url, data });
      } catch {
        /* 解析失败忽略，留给重放兜底 */
      }
    });

    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    await Promise.race([
      page
        .waitForFunction(() => document.querySelectorAll('img').length > 3, undefined, {
          timeout: 8000
        })
        .catch(() => undefined),
      page.waitForTimeout(HYDRATION_WAIT_MS)
    ]);
    // 慢站耐心等：轮询直到商品图出现或接口 JSON 到手；遇「加载超时,点击刷新」自动点掉重试。
    await waitForProductsPatiently(page, () => jsonPayloads.length > 0, listingUrl);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    await autoScroll(page);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);

    // DOM 兜底信号（跨分页累积）。网络 JSON 由 page.on('response') 自动累积进 jsonPayloads。
    type AnchorRec = ReturnType<typeof pageEvalScript>[number];
    type CardRec = ReturnType<typeof pageCardScript>['cards'][number];
    const rawAnchors: AnchorRec[] = [];
    const rawCards: CardRec[] = [];
    let cardSamples: string[] = [];
    let cardImgSamples: string[] = [];
    let pagesScanned = 0;
    const seenAnchorKeys = new Set<string>();
    const seenCardKeys = new Set<string>();

    const collectThisPage = async () => {
      pagesScanned += 1;
      const anchors = await page.evaluate(pageEvalScript);
      for (const a of anchors) {
        const key = a.href || a.imgSrc;
        if (key && !seenAnchorKeys.has(key)) {
          seenAnchorKeys.add(key);
          rawAnchors.push(a);
        }
      }
      const cr = await page.evaluate(pageCardScript);
      for (const c of cr.cards) {
        const key = c.code || c.imgSrc;
        if (key && !seenCardKeys.has(key)) {
          seenCardKeys.add(key);
          rawCards.push(c);
        }
      }
      if (cardSamples.length === 0) cardSamples = cr.samples;
      if (cardImgSamples.length === 0) cardImgSamples = cr.sampleImgUrls;
    };

    const firstImgSig = () =>
      page
        .evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
          for (const im of imgs) {
            const src =
              im.getAttribute('data-src') ||
              im.getAttribute('data-original') ||
              im.getAttribute('data-lazy') ||
              im.getAttribute('src') ||
              '';
            if (/\/person\/[0-9a-z]+\/[0-9a-z]{16,}\//i.test(src)) return src;
          }
          const im = imgs[0];
          return (im && (im.getAttribute('src') || im.getAttribute('data-src') || '')) || '';
        })
        .catch(() => '');

    await collectThisPage();

    // ---------- 翻页：gxhyapp 等站用「下一页」按钮显式翻页（非无限滚动）----------
    for (let pageNo = 2; pageNo <= MAX_PAGES; pageNo++) {
      const beforeSig = await firstImgSig();
      const clicked = await page
        .evaluate(() => {
          const els = Array.from(
            document.querySelectorAll('a, button, li, span, div')
          ) as HTMLElement[];
          const isDisabled = (el: HTMLElement) => {
            const cls = (el.getAttribute('class') || '').toLowerCase();
            const ariaDisabled = (el.getAttribute('aria-disabled') || '').toLowerCase();
            return (
              el.hasAttribute('disabled') ||
              ariaDisabled === 'true' ||
              (el as HTMLButtonElement).disabled === true ||
              /disabled|is-disabled|btn-disable|not-allowed|ban|gray|grey/.test(cls)
            );
          };
          const visible = els.filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          let btn = visible.find((el) => /^(下一页|下一頁|next)$/i.test((el.textContent || '').trim()));

          if (!btn) {
            const pageEls = visible
              .map((el) => ({ el, text: (el.textContent || '').trim(), cls: (el.getAttribute('class') || '').toLowerCase() }))
              .filter((x) => /^\d{1,3}$/.test(x.text));
            const active = pageEls.find((x) => /active|current|selected|on|act/.test(x.cls));
            const current = active ? Number(active.text) : 1;
            btn = pageEls.find((x) => Number(x.text) === current + 1)?.el;
          }

          if (!btn) return false;
          if (isDisabled(btn)) return false;
          btn.click();
          return true;
        })
        .catch(() => false);
      if (!clicked) break;

      // 等分页内容真正换页：旧商品图还在 DOM 时，普通 ready 检查会误判已完成。
      let turned = false;
      const turnStart = Date.now();
      while (Date.now() - turnStart < 20_000) {
        const sig = await firstImgSig();
        if (sig && sig !== beforeSig) {
          turned = true;
          break;
        }
        await page.waitForTimeout(PRODUCT_WAIT_POLL_MS);
      }
      if (!turned) break;

      // 等新页加载（同样耐心处理「加载超时,点击刷新」）。hasJson 传 ()=>false，靠图片出现提前结束。
      await waitForProductsPatiently(page, () => false, page.url());
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      await autoScroll(page);

      // 翻页后首图没变 → 多半已到最后一页或翻页失败，停止。
      const afterSig = await firstImgSig();
      if (afterSig && afterSig === beforeSig) break;

      await collectThisPage();
    }
    const imageCount = await page.evaluate(() => document.querySelectorAll('img').length);
    const finalUrl = page.url();
    // ---------- 重取所有 XHR 的 body（page.on('response') 在 chunked 响应上不可靠，作为兜底）----------
    // 用 page.evaluate 在浏览器内 fetch — 这样 cookies/Origin/Referer/X-Requested-With 全部和 SPA 一致。
    const candidateReqs = xhrReqs.filter(
      (r) => !STATIC_EXT.test(r.url) && !r.url.startsWith('data:') && !r.url.startsWith('blob:')
    );
    type ReplayResult = { url: string; ok: boolean; status: number; bodyHead: string };
    const replayResults: ReplayResult[] = await page.evaluate(async (reqs) => {
      const out: ReplayResult[] = [];
      for (const r of reqs) {
        try {
          const init: RequestInit = {
            method: r.method,
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
          };
          if (r.postData && r.method.toUpperCase() !== 'GET') {
            init.body = r.postData;
            (init.headers as Record<string, string>)['Content-Type'] =
              'application/x-www-form-urlencoded';
          }
          const resp = await fetch(r.url, init);
          const text = await resp.text();
          out.push({ url: r.url, ok: resp.ok, status: resp.status, bodyHead: text.slice(0, 2_000_000) });
        } catch (e) {
          out.push({ url: r.url, ok: false, status: -1, bodyHead: '' });
        }
      }
      return out;
    }, candidateReqs.slice(0, 60));

    const replayDiag: string[] = [];
    for (const res of replayResults) {
      if (!res.ok || !res.bodyHead) {
        replayDiag.push(`${res.status} ${res.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]}`);
        continue;
      }
      const trimmed = res.bodyHead.trimStart();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        replayDiag.push(`非JSON ${res.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]}: ${trimmed.slice(0, 60)}`);
        continue;
      }
      try {
        const data = JSON.parse(trimmed);
        jsonPayloads.push({ url: res.url, data });
      } catch {
        replayDiag.push(`解析失败 ${res.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]}`);
      }
    }
    // ---------- 通道 1: 网络 JSON 挖矿 ----------
    const networkRaw: RawProduct[] = [];
    const seenCodes = new Set<string>();
    for (const p of jsonPayloads) {
      walkForProducts(p.data, networkRaw, seenCodes, finalUrl);
    }

    const candidates: CrawlCandidate[] = [];
    const seenCodesAll = new Set<string>();

    if (rule) {
      for (const r of networkRaw) {
        const sourceCode = canonicalSourceCode(sourceId, r.code, r.mainImage);
        if (seenCodesAll.has(sourceCode)) continue;
        seenCodesAll.add(sourceCode);
        candidates.push({
          sourceCode,
          detailUrl: rule.buildDetailUrl(sourceCode, r.raw),
          mainImage: r.mainImage,
          title: r.title,
          priceHint: r.price ? (r.price.startsWith('¥') ? r.price : `¥${r.price}`) : undefined,
          merchantHint: r.merchant
        });
      }
    }

    const networkCount = candidates.length;

    // ---------- 通道 2: DOM <a href> 兜底 ----------
    if (rule) {
      for (const a of rawAnchors) {
        const m = rule.matchHref(a.href);
        if (!m) continue;
        if (!a.imgSrc) continue;
        const mainImage = a.imgSrc.startsWith('//') ? `https:${a.imgSrc}` : a.imgSrc;
        const sourceCode = canonicalSourceCode(sourceId, m.sourceCode, mainImage);
        if (seenCodesAll.has(sourceCode)) continue;
        seenCodesAll.add(sourceCode);
        candidates.push({
          sourceCode,
          detailUrl: rule.buildDetailUrl(sourceCode),
          mainImage,
          title: a.text || undefined,
          priceHint: a.priceText || undefined
        });
      }
    }
    const domCount = candidates.length - networkCount;

    // ---------- 通道 3: 渲染后商品卡片（针对 onclick + router.push SPA）----------
    if (rule) {
      for (const c of rawCards) {
        if (!c.imgSrc) continue;
        const mainImage = c.imgSrc.startsWith('//') ? `https:${c.imgSrc}` : c.imgSrc;
        const sourceCode = canonicalSourceCode(sourceId, c.code, mainImage);
        if (seenCodesAll.has(sourceCode)) continue;
        seenCodesAll.add(sourceCode);
        candidates.push({
          sourceCode,
          detailUrl: rule.buildDetailUrl(sourceCode),
          mainImage,
          title: c.title || undefined,
          priceHint: c.priceText || undefined
        });
      }
    }
    const cardCount = candidates.length - networkCount - domCount;

    const channels: string[] = [];
    if (networkCount > 0) channels.push('network');
    if (domCount > 0) channels.push('dom');
    if (cardCount > 0) channels.push('card');
    const via = (channels.join('+') || 'network') as CrawlResult['via'];

    if (pagesScanned > 1) {
      warnings.push(`已翻页扫描 ${pagesScanned} 页（点击「下一页」累积去重）。`);
    }
    if (pagesScanned >= MAX_PAGES) {
      warnings.push(`已达到本次扫描页数上限 ${MAX_PAGES} 页；如需更大池子，建议按分类/关键词分批扫描。`);
    }

    if (candidates.length === 0) {
      // 先判断是不是「未登录 / 列表本身为空」——这是 gxhyapp 这类站最常见的 0 命中原因：
      // 真正的商品数据走鉴权后端（如 api.gxhy1688.com），无有效登录态时页面只渲染空状态。
      try {
        const pageSignals = await page.evaluate(() => {
          const bodyText = (document.body?.innerText || '').slice(0, 4000);
          return {
            emptyMarker: /没有更多|暂无数据|暂无商品|空空如也|no\s*(data|result|more)/i.test(bodyText),
            loginMarker: /请先?登录|登录后查看|未登录|登录已过期|登录失效/i.test(bodyText),
            imgCount: document.querySelectorAll('img').length
          };
        });
        if (pageSignals.loginMarker || (pageSignals.emptyMarker && pageSignals.imgCount <= 3)) {
          warnings.push(
            '疑似未登录或列表为空：页面只渲染了空状态（如「登录」按钮 / 「没有更多」）。' +
              '请点右上角「登录会话」用浏览器登录该货源后再扫描；商品数据走鉴权后端，未登录时列表接口返回空。'
          );
        }
      } catch {
        /* 信号探测失败不影响主流程 */
      }
      // 零匹配：抽样报告各 JSON payload 的顶层 key，方便快速调整字段名
      const sampleKeys = jsonPayloads.slice(0, 6).map((p) => {
        const root = p.data as Record<string, unknown> | unknown[];
        let keys: string[] = [];
        if (Array.isArray(root) && root.length > 0 && typeof root[0] === 'object' && root[0]) {
          keys = Object.keys(root[0] as Record<string, unknown>);
        } else if (root && typeof root === 'object') {
          keys = Object.keys(root as Record<string, unknown>);
        }
        const short = p.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
        return `${short} → {${keys.slice(0, 8).join(', ')}}`;
      });
      warnings.push(
        `没有匹配到任何商品。XHR ${xhrUrls.length} 个，JSON 解析成功 ${jsonPayloads.length} 份，候选卡片 ${rawCards.length} 个。`
      );
      if (sampleKeys.length > 0) {
        warnings.push(`响应顶层字段抽样：${sampleKeys.join(' | ')}`);
      }
      if (replayDiag.length > 0) {
        warnings.push(`重取失败/非JSON：${replayDiag.slice(0, 8).join(' | ')}`);
      }

      // ---------- 零匹配时转储调试快照：截图 + DOM 摘要 ----------
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const dir = path.join(process.cwd(), 'data', 'debug-discover');
        await fs.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const stem = `${sourceId}-${stamp}`;
        const shotPath = path.join(dir, `${stem}.png`);
        const htmlPath = path.join(dir, `${stem}.html`);
        await page.screenshot({ path: shotPath, fullPage: true }).catch(() => undefined);
        const html = await page
          .evaluate(() => document.documentElement.outerHTML.slice(0, 400_000))
          .catch(() => '');
        if (html) await fs.writeFile(htmlPath, html, 'utf8');
        warnings.push(`调试快照已存：data/debug-discover/${stem}.png + .html`);
      } catch (e) {
        warnings.push(`转储调试快照失败：${(e as Error).message}`);
      }
    }

    return {
      startUrl: finalUrl,
      scannedAnchors: rawAnchors.length,
      scannedImages: imageCount,
      scannedJsonResponses: jsonPayloads.length,
      scannedXhrRequests: xhrUrls.length,
      scannedCards: rawCards.length,
      sampleXhrUrls: xhrUrls.slice(0, 20),
      candidates,
      via,
      warnings
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}
