import axios from 'axios';
import { renderGxhyappDetail } from './renderer';

/**
 * 原始抓取结果：不做语义清洗，只把详情页中能拿到的信号尽量收集起来，
 * 后续交给 LLM 归一化（见 normalizer.ts）。
 */
export type ScrapedDetail = {
  /** 来源链接（即详情页 URL） */
  sourceUrl: string;
  /** 商品 code，例如 1190184416 */
  code: string;
  /** marketCode，例如 gz */
  marketCode?: string;
  /** 详情页的 <title> */
  pageTitle?: string;
  /** 抓到的所有候选标题（meta、og:title、h1 等） */
  titleCandidates: string[];
  /** 抓到的所有候选价格文本，例如 "¥690" */
  priceCandidates: string[];
  /** 抓到的所有候选商家名 */
  merchantCandidates: string[];
  /** 抓到的所有候选品牌名 */
  brandCandidates: string[];
  /** 抓到的所有候选型号字符串，例如 "M83566" */
  modelCandidates: string[];
  /** 商品描述、规格段落等长文本，按出现顺序排列 */
  descriptionBlocks: string[];
  /** 详情页内的全部图片链接（已去重，已过滤明显非商品图） */
  images: string[];
  /** 主图候选（og:image / 第一张大图） */
  mainImageCandidate?: string;
  /** 若详情页中嵌入了 JSON state（__NUXT__、__INITIAL_STATE__ 等），保留原始片段 */
  embeddedState?: unknown;
  /** 完整 HTML，供 LLM 兜底解析（最多截断到 60KB） */
  htmlSnippet: string;
  /** 用户手动补充的页面文字（价格、商家、描述等），与 HTML 信号并列送 LLM */
  extraText?: string;
  /** Playwright 渲染后的整页截图 data URL（image/png;base64,...），侜 LLM 多模态 */
  screenshotDataUrl?: string;
  /** Playwright 渲染后的 document.body.innerText，包含 SPA 注入后的价格/商家/型号 */
  renderedBodyText?: string;
};

const DETAIL_URL_PATTERN = /^https?:\/\/mall\.gxhyapp\.com\/market\/web\/detailIndex/i;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_HTML_SNIPPET = 60_000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

/**
 * 给定商品 code（或完整详情页 URL），返回详情页 URL。
 */
export function buildDetailUrl(input: { code?: string; url?: string; marketCode?: string }): string {
  if (input.url && DETAIL_URL_PATTERN.test(input.url)) {
    return input.url;
  }

  if (!input.code) {
    throw new Error('需要提供商品 code 或完整的详情页 URL');
  }

  const marketCode = input.marketCode ?? 'gz';
  return `https://mall.gxhyapp.com/market/web/detailIndex?marketCode=${encodeURIComponent(
    marketCode
  )}&code=${encodeURIComponent(input.code)}`;
}

/**
 * 解析详情页 URL，拿到 code / marketCode。
 */
export function parseDetailUrl(url: string): { code?: string; marketCode?: string } {
  try {
    const u = new URL(url);
    return {
      code: u.searchParams.get('code') ?? undefined,
      marketCode: u.searchParams.get('marketCode') ?? undefined
    };
  } catch {
    return {};
  }
}

/**
 * 抓取并粗提取详情页数据。注意 gxhyapp 详情页是 SPA，
 * 这里抓的是首屏 HTML，能拿到 <title>、og 标签、嵌入的初始状态 JSON、
 * 以及静态打包进 HTML 的商品图片链接。如果未来站点改为完全异步加载，
 * 应改为命中其后端 API（在浏览器 DevTools 中可观察到 `/market/api/...` 之类的 XHR）。
 *
 * 实测：detailIndex 页就是纯 Vue 壳，真正商品数据走 https://api.gxhy1688.com
 * 的鉴权接口（无 session 会返回"服务器繁忙"）。所以建议调用方额外提供 mainImageUrl
 * （例如从列表页/分享链接复制），scraper 会根据 aliyizhan 主图目录规则
 * `/person/{shopUuid}/{productUuid}/{n}.jpg` 自动枚举出全部组图。
 */
export async function scrapeGxhyappDetail(input: {
  code?: string;
  url?: string;
  marketCode?: string;
  mainImageUrl?: string;
  extraText?: string;
  /** 是否用 Playwright 渲染 SPA，拿 hydrated 文本 + 整页截图（默认 true） */
  useRenderer?: boolean;
}): Promise<ScrapedDetail> {
  const sourceUrl = buildDetailUrl(input);
  const parsed = parseDetailUrl(sourceUrl);
  const code = parsed.code ?? input.code ?? '';
  const marketCode = parsed.marketCode ?? input.marketCode;

  let html = '';
  try {
    const response = await axios.get<string>(sourceUrl, {
      timeout: DEFAULT_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: [(data) => data],
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: 'https://mall.gxhyapp.com/'
      },
      validateStatus: (status) => status >= 200 && status < 500
    });
    html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
  } catch (error) {
    // 网络失败时不要抛，让上层走 LLM/fallback 提示用户重试；
    // 但仍要尝试 mainImageUrl 路径（HTML 拿不到也不影响组图枚举）
    html = '';
    // eslint-disable-next-line no-console
    console.warn(
      '[gxhyapp scraper] detail HTML 抓取失败：',
      error instanceof Error ? error.message : error
    );
  }

  const base = html
    ? extractFromHtml(html, sourceUrl, code, marketCode)
    : {
        sourceUrl,
        code,
        marketCode,
        titleCandidates: [],
        priceCandidates: [],
        merchantCandidates: [],
        brandCandidates: [],
        modelCandidates: [],
        descriptionBlocks: [],
        images: [],
        htmlSnippet: ''
      };

  // 用调用方提供的主图 URL 推导出完整组图（aliyizhan 目录规则：N.jpg）
  if (input.mainImageUrl) {
    const gallery = await enumerateAliyizhanGallery(input.mainImageUrl);
    if (gallery.length > 0) {
      const merged = Array.from(new Set([...gallery, ...base.images]));
      base.images = merged;
      base.mainImageCandidate = input.mainImageUrl;
    }
  }

  // 用 Playwright 渲染 SPA：拿 hydrated innerText + 整页截图。
  // 默认开启；若调用方显式 useRenderer=false 则跳过。
  if (input.useRenderer !== false) {
    try {
      const rendered = await renderGxhyappDetail(sourceUrl);
      base.renderedBodyText = rendered.bodyText;
      base.screenshotDataUrl = rendered.screenshotDataUrl;
      mergeTextIntoSignals(base, rendered.bodyText);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        '[gxhyapp scraper] Playwright 渲染失败：',
        error instanceof Error ? error.message : error
      );
    }
  }

  // 将用户补充文本解析为候选信号（与 HTML/渲染信号并列），原始文本也保存给 LLM
  if (input.extraText) {
    const txt = input.extraText.trim().slice(0, 4000);
    base.extraText = txt;
    mergeTextIntoSignals(base, txt);
  }

  return base;
}

/** 把一段任意文本拆成 price/model 候选 + 追加到 descriptionBlocks，供 LLM 用。 */
function mergeTextIntoSignals(base: ScrapedDetail, text: string): void {
  if (!text) return;
  const priceMatches = text.match(/[¥￥]\s*\d[\d,.]+/g) ?? [];
  for (const p of priceMatches) {
    const normalized = p.replace(/\s+/g, '');
    if (!base.priceCandidates.includes(normalized)) base.priceCandidates.push(normalized);
  }
  const modelMatches = text.match(/[A-Z]{1,3}\d{4,6}[A-Z0-9]{0,6}/g) ?? [];
  for (const m of modelMatches) {
    if (!base.modelCandidates.includes(m)) base.modelCandidates.push(m);
  }
  if (!base.descriptionBlocks.includes(text)) base.descriptionBlocks.push(text);
}

/** 暴露给单测：从已知 HTML 字符串提取信号。 */
export function extractFromHtml(
  html: string,
  sourceUrl: string,
  code: string,
  marketCode?: string
): ScrapedDetail {
  const titleCandidates = uniq([
    pick(html, /<title>([\s\S]*?)<\/title>/i),
    pickAttr(html, 'meta', 'property', 'og:title', 'content'),
    pickAttr(html, 'meta', 'name', 'title', 'content'),
    pick(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)
  ]);

  const priceCandidates = uniq(
    Array.from(html.matchAll(/[¥￥]\s?(\d{1,6}(?:\.\d{1,2})?)/g)).map((m) => `¥${m[1]}`)
  ).slice(0, 8);

  const merchantCandidates = uniq(
    Array.from(html.matchAll(/商家[:：]\s*([^<\n\r"]{2,40})/g)).map((m) => m[1].trim())
  );

  const brandCandidates = uniq(
    Array.from(
      html.matchAll(/(LV|Louis\s?Vuitton|Chanel|Dior|Gucci|Hermès|Hermes|Prada|YSL|MCM|Burberry)/gi)
    ).map((m) => m[1])
  );

  const modelCandidates = uniq(
    Array.from(html.matchAll(/\b([Mm]\d{4,6}[A-Za-z]?)\b/g)).map((m) => m[1].toUpperCase())
  );

  const descriptionBlocks = uniq(
    Array.from(html.matchAll(/<(?:p|div|li)[^>]*>([\s\S]{20,500}?)<\/(?:p|div|li)>/g))
      .map((m) => stripHtml(m[1]).trim())
      .filter((text) => text.length >= 10 && /[\u4e00-\u9fa5]/.test(text))
  ).slice(0, 20);

  const images = uniq(
    Array.from(html.matchAll(/https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp)/gi)).map((m) => m[0])
  )
    .filter((url) => !/logo|icon|placeholder|avatar|favicon/i.test(url))
    .slice(0, 30);

  const mainImageCandidate = pickAttr(html, 'meta', 'property', 'og:image', 'content') ?? images[0];

  const embeddedState =
    tryParseJson(pick(html, /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/)) ??
    tryParseJson(pick(html, /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/)) ??
    tryParseJson(pick(html, /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/));

  return {
    sourceUrl,
    code,
    marketCode,
    pageTitle: titleCandidates[0],
    titleCandidates,
    priceCandidates,
    merchantCandidates,
    brandCandidates,
    modelCandidates,
    descriptionBlocks,
    images,
    mainImageCandidate,
    embeddedState,
    htmlSnippet: html.slice(0, MAX_HTML_SNIPPET)
  };
}

function pick(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  return m?.[1]?.trim();
}

function pickAttr(
  html: string,
  tag: string,
  keyAttr: string,
  keyValue: string,
  valueAttr: string
): string | undefined {
  const re = new RegExp(
    `<${tag}[^>]*${keyAttr}=["']${keyValue}["'][^>]*${valueAttr}=["']([^"']+)["']`,
    'i'
  );
  const alt = new RegExp(
    `<${tag}[^>]*${valueAttr}=["']([^"']+)["'][^>]*${keyAttr}=["']${keyValue}["']`,
    'i'
  );
  return html.match(re)?.[1] ?? html.match(alt)?.[1];
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function uniq<T>(arr: Array<T | undefined | null>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    if (item === undefined || item === null) continue;
    const key = typeof item === 'string' ? item : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function tryParseJson(text?: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 给定一张 aliyizhan 主图 URL（形如
 * `https://product.aliyizhan.com/person/{shopUuid}/{productUuid}/0.jpg`），
 * 通过 HEAD 探测枚举出全部组图：从 0 开始递增，遇到连续 N 个 404 就停。
 *
 * 这是绕开 gxhyapp 详情页 SPA 限制最稳的路径：商品组图在 CDN 上以
 * 数字命名顺序排列，命中规则即可拿到完整图集。
 */
export async function enumerateAliyizhanGallery(
  mainImageUrl: string,
  options: { maxImages?: number; consecutiveMissThreshold?: number } = {}
): Promise<string[]> {
  const maxImages = options.maxImages ?? 30;
  const missThreshold = options.consecutiveMissThreshold ?? 2;

  // 解析出 base + ext
  const match = mainImageUrl.match(/^(.*\/)(\d+)\.(jpg|jpeg|png|webp)(\?.*)?$/i);
  if (!match) return [];
  const base = match[1];
  const ext = match[3];

  const results: string[] = [];
  let consecutiveMisses = 0;

  for (let i = 0; i < maxImages; i++) {
    const url = `${base}${i}.${ext}`;
    try {
      const res = await axios.head(url, {
        timeout: 5_000,
        headers: { 'User-Agent': USER_AGENT, Referer: 'https://mall.gxhyapp.com/' },
        validateStatus: () => true
      });
      if (res.status >= 200 && res.status < 300) {
        results.push(url);
        consecutiveMisses = 0;
      } else {
        consecutiveMisses += 1;
        if (consecutiveMisses >= missThreshold) break;
      }
    } catch {
      consecutiveMisses += 1;
      if (consecutiveMisses >= missThreshold) break;
    }
  }

  return results;
}
