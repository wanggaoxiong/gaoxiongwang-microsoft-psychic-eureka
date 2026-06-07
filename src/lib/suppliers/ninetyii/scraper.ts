/**
 * 90ii.net detail scraper — SSR HTML，axios + cheerio。
 * 输出与 gxhyapp 的 ScrapedDetail 结构兼容，复用同一个 normalizer.ts。
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import type { ScrapedDetail } from '../gxhyapp/scraper';

const BASE_URL = 'https://www.90ii.net';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_HTML_SNIPPET = 60_000;

export function parseNinetyIiDetailUrl(url: string): { code?: string } {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/products\/(\d+)/);
    if (m) return { code: m[1] };
  } catch {
    /* noop */
  }
  return {};
}

export async function scrapeNinetyIiDetail(input: {
  url?: string;
  code?: string;
  mainImageUrl?: string;
  extraText?: string;
}): Promise<ScrapedDetail> {
  const code = input.code ?? parseNinetyIiDetailUrl(input.url ?? '').code;
  if (!code) throw new Error('缺少 90ii 商品 code');
  const sourceUrl = `${BASE_URL}/products/${encodeURIComponent(code)}`;

  const { data: html } = await axios.get<string>(sourceUrl, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    timeout: 15000,
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400
  });
  const $ = cheerio.load(html);

  // 立即移除 "相关推荐 / Related" 区块，避免把其他商品的图和文字混入
  $('.relations-wrap, .relations-swiper, .relations-pagination, .relations-swiper-prev, .relations-swiper-next').remove();
  $('.share, .social, .plugin-share, [class*="share-"]').remove();
  $('header, footer, nav, .header, .footer, .navbar').remove();

  // ---------- title ----------
  const title =
    $('h1.product-name').first().text().trim() ||
    $('h1').first().text().trim() ||
    $('.product-name').first().text().trim() ||
    $('meta[property="og:title"]').attr('content')?.trim() ||
    '';
  const titleCandidates = uniq([
    title,
    $('meta[property="og:title"]').attr('content')?.trim() ?? '',
    $('title').text().trim()
  ]);

  // ---------- breadcrumb / brand / category ----------
  const breadcrumbs: string[] = [];
  $('nav.breadcrumb a, .breadcrumb a, ol.breadcrumb a, .page-product .breadcrumb a').each((_, el) => {
    const t = $(el).text().trim();
    if (t) breadcrumbs.push(t);
  });
  // Home / <Brand> / <ProductName>
  const brandCandidates = breadcrumbs
    .filter((b) => b && !/^home$/i.test(b) && b !== title)
    .slice(0, 2);

  // ---------- SKU / model ----------
  const skuMatch = $('body')
    .text()
    .match(/SKU\s*[:：]\s*([^\s\n]+)/i);
  const modelCandidates: string[] = [];
  if (skuMatch) modelCandidates.push(skuMatch[1]);

  // ---------- price ----------
  const priceCandidates: string[] = [];
  $('.product-price, .price, [class*="product-price"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t && /[\d¥$€]/.test(t)) priceCandidates.push(t);
  });

  // ---------- images：90ii 是 Vue SSR，真正的商品组图嵌在 <script> 里 ----------
  // 形如 this.images = [{"preview":"https:\/\/images2.90ii.cc\/imgHD\/...","popup":"...","thumb":"..."}, ...]
  // 用正则把所有 https://images*.90ii.cc/imgHD?/... 的 URL 全抠出来（先反转义 \/ 为 /）
  const unescaped = html.replace(/\\\//g, '/');
  const CDN_RE = /^https?:\/\/images\d*\.90ii\.cc\/img(HD)?\//i;
  const URL_IN_JS_RE = /https?:\/\/images\d*\.90ii\.cc\/img(?:HD)?\/[^"'\s\\<>()]+/gi;
  const fromJs: string[] = [];

  // 仅在 product-app 的 inline script 区域抠图，避免把 Related Products 的 data-src 也带进来
  // （Related 区块前面已经被 cheerio 移除，但 html 字符串仍然包含它们）
  // 用 product-app 的 Vue 数据片段定位：找包含 "this.images = [" 的脚本
  const scriptMatch = unescaped.match(/this\.images\s*=\s*\[([\s\S]*?)\];/);
  if (scriptMatch) {
    const seg = scriptMatch[1];
    let m: RegExpExecArray | null;
    while ((m = URL_IN_JS_RE.exec(seg)) !== null) {
      fromJs.push(m[0]);
    }
  }

  // SKU + 价格 + 库存：90ii 把这些信息嵌在 source.skus[0] 里
  // {"id":221596,"sku":"_djhqfs6...","price":100,"price_format":"$100","quantity":9999,"is_default":1}
  let stockText: string | undefined;
  let styleHint: string | undefined;
  const skusArrMatch = unescaped.match(/skus:\s*(\[\{[\s\S]*?\}\])\s*,/);
  if (skusArrMatch) {
    try {
      const skus = JSON.parse(skusArrMatch[1]) as Array<{
        sku?: string;
        price?: number;
        price_format?: string;
        origin_price_format?: string;
        quantity?: number;
        is_default?: number;
        model?: string;
      }>;
      const def = skus.find((s) => s.is_default) ?? skus[0];
      if (def?.sku && !modelCandidates.includes(def.sku)) modelCandidates.push(def.sku);
      if (def?.price_format) priceCandidates.push(def.price_format);
      else if (typeof def?.price === 'number') priceCandidates.push(`$${def.price}`);
      if (typeof def?.quantity === 'number') {
        stockText = def.quantity > 0 ? 'In Stock' : 'Out of Stock';
      }
      if (def?.model && !modelCandidates.includes(def.model)) modelCandidates.push(def.model);
    } catch {
      /* noop */
    }
  }
  // 兜底：单独抠 "sku":"..."
  const skuJsMatch = unescaped.match(/"sku"\s*:\s*"([^"]+)"/);
  if (skuJsMatch && !modelCandidates.includes(skuJsMatch[1])) {
    modelCandidates.push(skuJsMatch[1]);
  }

  // 兜底：取 og:image
  const ogImage = $('meta[property="og:image"]').attr('content')?.trim();

  // DOM 内残余的 CDN 图（一般 90ii 是空的，但保留兼容）
  const fromDom: string[] = [];
  $('.product-image img, .product-img img, img').each((_, el) => {
    pickImgSrc($, el, fromDom);
  });

  const productImages = uniq([
    ...fromJs,
    ...fromDom.filter((u) => CDN_RE.test(u)),
    ...(ogImage && CDN_RE.test(ogImage) ? [ogImage] : [])
  ]);
  const mainImageCandidate =
    input.mainImageUrl ||
    (ogImage && CDN_RE.test(ogImage) ? ogImage : undefined) ||
    productImages.find((u) => /\/imgHD\//i.test(u)) ||
    productImages[0];

  // ---------- description ----------
  // 90ii 的 "Product Details" 文本是静态 HTML 渲染的，在 #product-description 这个 tab-pane 里
  // 注意：不能用 .product-description（外层 wrapper 会带上 nav 标签的"Product Details Reviews(47)"噪声）
  const descriptionBlocks: string[] = [];
  const detailText = $('#product-description').text().replace(/\s+/g, ' ').trim();
  if (detailText) descriptionBlocks.push(detailText);
  // 兜底：其它常见容器
  $('.product-detail, .detail-content, .peoduct-info').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t && !descriptionBlocks.includes(t)) descriptionBlocks.push(t);
  });
  // 从描述里抽 Style number（如 "Style number #4005"）作为补充候选
  const styleMatch = (descriptionBlocks[0] ?? '').match(/Style\s*number\s*#?\s*([A-Za-z0-9_-]+)/i);
  if (styleMatch) {
    styleHint = styleMatch[1];
    if (!modelCandidates.includes(styleHint)) modelCandidates.push(styleHint);
  }
  // 把库存/style 明文加进 descriptionBlocks，方便 LLM 直接看到
  const facts: string[] = [];
  if (stockText) facts.push(`Quantity: ${stockText}`);
  if (styleHint) facts.push(`Style number: ${styleHint}`);
  if (facts.length) descriptionBlocks.unshift(facts.join(' · '));
  if (descriptionBlocks.length === 0) {
    const bodyText = $('body').text();
    const idx = bodyText.indexOf('Product Details');
    if (idx >= 0) descriptionBlocks.push(bodyText.slice(idx, idx + 1500).replace(/\s+/g, ' ').trim());
  }
  if (input.extraText) descriptionBlocks.push(input.extraText);
  // 过滤 Vue 模板占位符 {{ ... }}，避免泄漏到 title / description
  const stripVue = (s: string) => s.replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').trim();
  const cleanedDescriptions = descriptionBlocks.map(stripVue).filter(Boolean);
  const cleanedTitles = titleCandidates.map(stripVue).filter(Boolean);

  return {
    sourceUrl,
    code,
    marketCode: undefined,
    pageTitle: cleanedTitles[0],
    titleCandidates: cleanedTitles,
    priceCandidates: uniq(priceCandidates),
    merchantCandidates: ['90ii.net'],
    brandCandidates: uniq(brandCandidates),
    modelCandidates: uniq(modelCandidates),
    descriptionBlocks: uniq(cleanedDescriptions),
    images: productImages,
    mainImageCandidate,
    htmlSnippet: $.html().slice(0, MAX_HTML_SNIPPET),
    extraText: input.extraText
  };
}

function pickImgSrc($: cheerio.CheerioAPI, el: any, out: string[]) {
  const src =
    $(el).attr('data-src') ||
    $(el).attr('data-original') ||
    $(el).attr('src') ||
    '';
  if (!src || src.startsWith('data:')) return;
  const normalized = src.startsWith('//') ? `https:${src}` : src;
  out.push(normalized);
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr.filter((x): x is T => Boolean(x))));
}
