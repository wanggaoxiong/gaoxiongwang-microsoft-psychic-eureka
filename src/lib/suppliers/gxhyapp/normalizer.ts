import axios from 'axios';
import { httpsAgentWithCustomDns } from '@/lib/net/dns-agent';
import type { ScrapedDetail } from './scraper';

/**
 * 商品卡：对应 Suppliers 页"建议显示"的字段集。
 * 主图 / 商品标题 / 品牌 · 系列 · 型号 / 分类 / 价格 / 商家 /
 * 图片数 / 规格完整度 / 来源链接
 */
export type GxhyappProductCard = {
  mainImage: string;
  title: string;
  brand: string;
  series: string;
  model: string;
  /** 商家货号 / SKU code（与 brand model 不同，有时以中文/数字结合） */
  skuCode: string;
  categoryPath: string[];
  price: string;
  merchant: string;
  galleryImages: string[];
  galleryImageCount: number;
  /** 原 “规格” 混合数组（保留向后兼容） */
  extractedAttributes: string[];
  /** 面向性别：男 / 女 / 中性 / 童 / 未确认 */
  gender: string;
  /** 颜色列表，如 ["黑色","棕色"] */
  colors: string[];
  /** 尺寸 / 型号说明，如 ["22x15x9cm","中号 38"] */
  sizes: string[];
  /** 材质细分 */
  materials: string[];
  /** 适用场景，如 商务通勤 / 休闲日常 / 宴会 / 通勤 / 旅行 */
  targetAudience: string;
  /** 3-5 条营销卖点，用于 WhatsApp 推送话术 */
  descriptionBullets: string[];
  /** AI 提取的检索关键词（中英混合），用于话术 / 智能搜索匹配 */
  searchKeywords?: string[];
  /** 使用场景，如 ['通勤', '商务出差', '日常街拍'] */
  useCase?: string[];
  /** 适合的客户类型，如 ['白领女性', '25-35', '中端价位'] */
  bestForCustomerType?: string[];
  /** 库存状态：true=有货, false=缺货, undefined=未知 */
  inStock?: boolean;
  /** 原始库存文本，例如 "In Stock" / "Out of Stock" / 数量 */
  stockText?: string;
  /** 货币代码（CNY/USD/EUR …），从 price 推断 */
  currency?: string;
  sourceUrl: string;
  confidence: {
    overall: number;
    source: 'llm' | 'heuristic';
    notes?: string;
  };
};

/**
 * 把抓取到的原始数据归一化为商品卡。
 * - 若调用方（或环境变量）提供了 Azure AI Foundry / Azure OpenAI 配置
 *   （AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY），调用 Responses API（gpt-5.4 多模态）
 * - 否则走本地启发式，保证在无密钥环境下也能跑通 demo
 */
export async function normalizeToProductCard(
  raw: ScrapedDetail,
  override?: Partial<AzureRuntimeConfig>
): Promise<GxhyappProductCard> {
  const llmResult = await tryAzureNormalize(raw, override);
  if (llmResult.card) return llmResult.card;
  const heuristic = heuristicNormalize(raw);
  if (llmResult.error) {
    return {
      ...heuristic,
      confidence: {
        ...heuristic.confidence,
        notes: `LLM 调用失败，已回落启发式：${llmResult.error}`
      }
    };
  }
  return heuristic;
}

export type AzureRuntimeConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
};

// ---------------------------------------------------------------------------
// 启发式归一化（无需 LLM 也能工作）
// ---------------------------------------------------------------------------

const CATEGORY_DICTIONARY: Array<{ keywords: RegExp; path: string[] }> = [
  { keywords: /斜挎|crossbody|shoulder/i, path: ['箱包', '手袋', '斜挎包'] },
  { keywords: /托特|tote/i, path: ['箱包', '托特包', '大号托特'] },
  { keywords: /链条|chain/i, path: ['箱包', '手袋', '链条包'] },
  { keywords: /钱包|wallet|cardholder/i, path: ['箱包', '钱包'] },
  { keywords: /手袋|手提包|包/i, path: ['箱包', '手袋'] },
  { keywords: /鞋|sneaker|shoe/i, path: ['鞋靴', '运动休闲'] },
  { keywords: /手表|watch/i, path: ['配饰', '手表'] }
];

const BRAND_NORMALIZE: Record<string, { brand: string; series?: string }> = {
  lv: { brand: 'LV' },
  'louis vuitton': { brand: 'LV' },
  louisvuitton: { brand: 'LV' },
  chanel: { brand: 'Chanel' },
  dior: { brand: 'Dior' },
  gucci: { brand: 'Gucci' },
  hermes: { brand: 'Hermès' },
  hermès: { brand: 'Hermès' },
  prada: { brand: 'Prada' },
  ysl: { brand: 'YSL' },
  mcm: { brand: 'MCM' },
  burberry: { brand: 'Burberry' }
};

const SERIES_HINTS = [
  'Nano Diane',
  'Diane',
  'Saumur',
  'Capucines',
  'CarryAll',
  'Stark',
  'Visetos',
  'Niki',
  'Book Tote',
  'Classic Flap'
];

const ATTR_HINTS: Array<{ key: string; re: RegExp }> = [
  { key: '尺寸', re: /(尺寸|size|cm|厘米|\d+\s?[×x]\s?\d+)/i },
  { key: '材质', re: /(材质|皮|leather|帆布|canvas|牛皮|羊皮)/i },
  { key: '颜色', re: /(颜色|color|黑色|白色|棕色|粉色|蓝色|红色)/i }
];

export function heuristicNormalize(raw: ScrapedDetail): GxhyappProductCard {
  const corpus = [
    ...raw.titleCandidates,
    ...raw.descriptionBlocks,
    raw.pageTitle ?? '',
    raw.renderedBodyText ?? '',
    raw.extraText ?? ''
  ]
    .filter(Boolean)
    .join('\n');

  const brand = pickBrand(raw, corpus);
  const model = raw.modelCandidates[0] ?? '';
  const series = pickSeries(corpus) ?? brand.series ?? '';
  const categoryPath = pickCategory(corpus);
  const title = pickTitle(raw, brand.brand, series);
  const price = raw.priceCandidates[0] ?? '价格待确认';
  const merchant = pickMerchant(raw) ?? '商家待确认';
  const mainImage = raw.mainImageCandidate ?? raw.images[0] ?? '';
  const extractedAttributes = ATTR_HINTS.filter((a) => a.re.test(corpus)).map((a) => a.key);

  // 从 descriptionBlocks / corpus 里抽 “Quantity: ...” 词条
  const stockInfo = detectStock(corpus);

  const filled = [title, brand.brand, model, price, merchant, mainImage].filter(Boolean).length;
  const overall = Math.min(1, filled / 6);

  return {
    mainImage,
    title,
    brand: brand.brand || '品牌待确认',
    series: series || '系列待确认',
    model: model || '型号待确认',
    skuCode: raw.code || '',
    categoryPath,
    price,
    merchant,
    galleryImages: raw.images,
    galleryImageCount: raw.images.length,
    extractedAttributes,
    gender: '未确认',
    colors: [],
    sizes: [],
    materials: [],
    targetAudience: '',
    descriptionBullets: [],
    inStock: stockInfo.inStock,
    stockText: stockInfo.text,
    currency: detectCurrencyFromPrice(price),
    sourceUrl: raw.sourceUrl,
    confidence: {
      overall,
      source: 'heuristic',
      notes:
        overall < 0.6
          ? '部分关键字段未能从首屏 HTML 中识别，建议接入详情页后端 API 或启用 LLM 归一化'
          : undefined
    }
  };
}

function pickBrand(raw: ScrapedDetail, corpus: string): { brand: string; series?: string } {
  for (const candidate of raw.brandCandidates) {
    const key = candidate.toLowerCase().replace(/\s+/g, '');
    if (BRAND_NORMALIZE[key]) return BRAND_NORMALIZE[key];
  }
  for (const key of Object.keys(BRAND_NORMALIZE)) {
    if (corpus.toLowerCase().includes(key)) return BRAND_NORMALIZE[key];
  }
  // 通过 series 反推 brand（如 Nano Diane / Capucines 都是 LV）
  const lower = corpus.toLowerCase();
  if (/(nano diane|diane|saumur|capucines|carryall|petit sac plat|multi pochette|pochette m[ée]tis)/.test(lower)) {
    return { brand: 'LV' };
  }
  if (/(classic flap|gabrielle|chanel 19)/.test(lower)) return { brand: 'Chanel' };
  if (/(book tote|saddle|lady dior)/.test(lower)) return { brand: 'Dior' };
  return { brand: '' };
}

function pickMerchant(raw: ScrapedDetail): string | undefined {
  if (raw.merchantCandidates[0]) return raw.merchantCandidates[0];
  // 从渲染后的正文里找商家名（常见位置：头像圈后一行，紧跟着“金牌接单”“微信号”等关键词）
  const text = (raw.renderedBodyText ?? '') + '\n' + (raw.extraText ?? '');
  if (!text.trim()) return undefined;
  // 模式 1：一行是商家名，下一行是“金牌接单: xxx” 或 “微信”
  const m1 = text.match(/([\u4e00-\u9fa5A-Za-z0-9·\s]{2,20})\s*\n\s*(?:🏅\s*)?(?:金牌接单|微信号|微信|添加微信|商家电话)/);
  if (m1?.[1]) return m1[1].trim();
  // 模式 2：“商家：/店铺：XXX”
  const m2 = text.match(/(?:商家|店铺|供应商|售卖方)[：:]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,20})/);
  if (m2?.[1]) return m2[1].trim();
  return undefined;
}

function pickSeries(corpus: string): string | undefined {
  for (const hint of SERIES_HINTS) {
    if (corpus.toLowerCase().includes(hint.toLowerCase())) return hint;
  }
  return undefined;
}

function pickCategory(corpus: string): string[] {
  for (const entry of CATEGORY_DICTIONARY) {
    if (entry.keywords.test(corpus)) return entry.path;
  }
  return ['未分类'];
}

function detectStock(corpus: string): { inStock?: boolean; text?: string } {
  // 1. "Quantity: In Stock" / "Quantity: Out of Stock"
  const m1 = corpus.match(/Quantity\s*[:：]\s*(In Stock|Out of Stock|\d+)/i);
  if (m1) {
    const v = m1[1].trim();
    if (/in stock/i.test(v)) return { inStock: true, text: 'In Stock' };
    if (/out of stock/i.test(v)) return { inStock: false, text: 'Out of Stock' };
    const n = Number(v);
    if (Number.isFinite(n)) return { inStock: n > 0, text: `${n} in stock` };
  }
  // 2. 中文 "现货 / 有货 / 备货中 / 缺货 / 售罄"
  if (/(现货|有货|in stock)/i.test(corpus)) return { inStock: true, text: '现货' };
  if (/(缺货|售罄|无货|sold out|out of stock)/i.test(corpus)) return { inStock: false, text: '缺货' };
  return {};
}

function detectCurrencyFromPrice(price: string | undefined): string | undefined {
  if (!price) return undefined;
  const s = price.trim();
  if (/^(CNY|USD|EUR|JPY|GBP|KRW|HKD|TWD|SGD|AUD|CAD)\b/i.test(s)) {
    return s.slice(0, 3).toUpperCase();
  }
  if (s.startsWith('￥') || s.startsWith('¥')) return 'CNY';
  if (s.startsWith('$')) return 'USD';
  if (s.startsWith('€')) return 'EUR';
  if (s.startsWith('£')) return 'GBP';
  if (s.startsWith('₩')) return 'KRW';
  return undefined;
}

function pickTitle(raw: ScrapedDetail, brand: string, series: string): string {
  // 1. 优先从渲染/补充文本里找“本款XXX”这种商品描述句
  const text = (raw.renderedBodyText ?? '') + '\n' + (raw.extraText ?? '');
  const benkuan = text.match(/(本款[^\n。，,。]{4,40})/);
  if (benkuan?.[1]) {
    const t = benkuan[1].replace(/^本款/, '').trim();
    if (t) return `${brand ? brand + ' ' : ''}${t}`.trim();
  }
  // 2. 避开站点公共标题
  const sitewide = /共享货源|没有中间商|一件代发|微商分身版|gxhyapp/i;
  for (const cand of [raw.pageTitle, ...raw.titleCandidates]) {
    if (cand && !sitewide.test(cand)) {
      return cand
        .replace(/[-_|·]\s*gxhyapp.*$/i, '')
        .replace(/\s*-\s*共享货源.*$/i, '')
        .trim();
    }
  }
  // 3. 兑底
  if (series) return `${brand ? brand + ' ' : ''}${series} 手袋`.trim();
  if (brand) return `${brand} 商品`;
  return '未命名商品';
}

// ---------------------------------------------------------------------------
// Azure AI Foundry / Azure OpenAI 归一化（Responses API + 多模态，gpt-5.4）
// 调用形状与 receipt-tracker 项目一致：
//   POST {endpoint}/openai/v1/responses
//   headers: { "api-key": ... }
//   body: { model, max_output_tokens, input: [{ role, content: [{type:"input_text"|"input_image", ...}] }] }
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是跨境电商奢侈品商品信息归一化助手。输入是从供应商详情页（gxhyapp / 90ii 等）抓取的原始信号 + 该商品的全部组图（最多 9 张）+ 可能附带的**整页截图**（Playwright 渲染后整页 PNG，包含 SPA 注入的价格、商家、型号、尺寸等文字）。

【取值优先级】（**严格按顺序，前者覆盖后者**）：
1. **descriptionBlocks**（详情页 "Product Details" 区段静态正文，包含官方原始描述如 "Upper: Frosted calfskin"）—— 这是商家自己写的产品规格，**关于材质 / 尺寸 / 颜色 / 系列名等事实，必须以此为准**，禁止用视觉推断推翻它（例如描述写 "Frosted calfskin / 磨砂小牛皮"，就不能写成 "麂皮 / suede"）。
2. extraText / renderedBodyText（用户/Playwright 补充正文）
3. 整页截图里 OCR 出的文字
4. priceCandidates / brandCandidates / modelCandidates 等正则候选
5. 商品组图视觉（仅在文字未给出时填补：例如型号烫印、五金颜色、内胆颜色）

descriptionBlocks 中常见的 inline 事实标签（必须吸收）：
  - "Quantity: In Stock" / "Quantity: Out of Stock" → 影响 title/卖点措辞
  - "Style number: 4005" / "Style number #4005" → 写进 model（若 modelCandidates 里有商家 SKU 哈希，两者并存：model=Style number，skuCode=商家 SKU 哈希）
  - "SKU: _xxx" → skuCode
  - "-Upper: ..." / "-Lining: ..." / "-Outsole: ..." → 拆进 materials / extractedAttributes
  - "-Size: 39-44 (...)" → sizes

【必须仔细看图的项目】
1. **型号 (model)**：奢侈品包袋的型号编码通常以"字母+数字"形式出现在：
   - 包内皮签 / 烫金标 / 黄色或棕色革牌上的烫印（如 LV 的 "M83566"、Chanel 的 "AS3219"、Dior 的 "M0446"）
   - 产品图角标 / 水印
   - 吊牌、包装盒上的贴纸
   如果有图片是「皮签特写 / 标签特写」，请重点放大识别其中的字母数字组合
   如果图片不清但你能根据 series 在品牌官方目录里**唯一对应**出 model 编码（如 LV Nano Diane 黑色 = M82896），可直接给出并在 series 后注明
   若仍无法确定才填 "型号待确认"

2. **品牌 (brand)**：从老花/格纹/双C/双G/双F 等标志性印花判断；皮革烫印 logo 也是强证据

3. **系列 (series)**：LV 包款常见系列名 Nano Diane / Diane / SAUMUR / Capucines / CarryAll / Petit Sac Plat / Multi Pochette / Pochette Métis 等；Chanel CF / 19 / Gabrielle 等

4. **品类 (categoryPath)**：观察包型决定是斜挎包 / 单肩包 / 手提包 / 钱包 / 卡包 等，至少 ["大类","中类","小类"] 三级

5. **属性 (extractedAttributes)**：图里能看出的尺寸（如皮签上印 22x15x9cm）、材质（涂层帆布/牛皮/羊皮）、颜色（黑/棕/橙/老花）、五金色（金/银）、内胆颜色等

6. **货号 (skuCode)**：商家内部 SKU / 货号，与 brand model **不一样**。可能出现在：
   - 页面 / 截图中"货号·XXX"或"编号 XXX"标签
   - URL 中的 code 参数（如 ?code=1190184416，这就是货号）
   - candidates 中的 modelCandidates 部分
   能提取到就填，否则留空字符串

7. **性别 (gender)**："男"/"女"/"中性"/"童"/"未确认" 五选一。女包型默认 "女"；邮差包/Backpack 多为 "中性"

8. **颜色 (colors)**：主色 + 配色数组，如 ["黑色","金色五金"] 或 ["棕色 Monogram"]

9. **尺寸 (sizes)**：始终以能看到的指标为准（如 ["22x15x9cm"]）；服装/鞋子可能是 ["M","L"] 或 ["38","39"]

10. **材质 (materials)**：数组，如 ["涂层帆布","牛皮边"]

11. **合适场景 (targetAudience)**：三个词内描述。例如 "通勤·赴约" / "身夫购物 EDC" / "商务出差"

12. **卖点 (descriptionBullets)**：用于 WhatsApp 推送的 3-5 条营销点，每条 ≤ 30 字，能让顾客快速理解购买理由。例如："实拍黑色老花拼伍厚重红到货" / "足量 4 层项目能装 iPad mini"

13. **检索关键词 (searchKeywords)**：8-15 个用于话术匹配的短词数组，中英混合（销售常需要多语动别）。例如：["monogram","老花","crossbody","斜挨","通勤包","mini bag","蒙古同款"]

14. **使用场景 (useCase)**：2-4 个场景词，汉语。例如 ["通勤","商务出差","日常街拍"]

15. **适合客户 (bestForCustomerType)**：2-4 个客户画像标签，汉语。例如 ["白领女性","25-35","中高端"]

【明确不要瞎编】
- 价格 (price)：图片里**几乎不会出现价格**。如果候选信号也没有人民币价格，请填 "价格待确认"，不要凭空生成
- 商家 (merchant)：图片里**不会有商家名**。如果候选信号缺失，请填 "商家待确认"

只返回严格 JSON（不要 \`\`\` 包裹、不要解释），结构如下：
{
  "title": "10-25 字商品标题，含品牌+系列+品类+卖点关键词",
  "brand": "LV / Chanel / Dior / Gucci / Hermes / Prada / YSL / MCM / Burberry 等常用名",
  "series": "系列名，如 Nano Diane / SAUMUR BB / Classic Flap",
  "model": "型号编码，如 M83566 / AS3219；不确定填 '型号待确认'",
  "skuCode": "商家货号，如 1190184416；未知填 ''",
  "categoryPath": ["箱包","手袋","斜挎包"],
  "gender": "女 / 男 / 中性 / 童 / 未确认",
  "colors": ["黑色","金色五金"],
  "sizes": ["22x15x9cm"],
  "materials": ["Monogram 老花涂层帆布","牛皮边"],
  "targetAudience": "通勤 · 日常赴约",
  "descriptionBullets": [
    "代表性 Monogram 老花，上身足够有警示性",
    "22cm 迷你包体积，能装 iPhone Pro Max · 口红 · 卡帖",
    "可调肩带·可斜挎可手拿两种背法"
  ],  "searchKeywords": ["monogram","老花","crossbody","斜挨包","nano diane","mini bag"],
  "useCase": ["通勤","日常赴约","街拍"],
  "bestForCustomerType": ["年轻白领","25-35","中端价位"],  "price": "¥950 或 '价格待确认'",
  "merchant": "商家名 或 '商家待确认'",
  "extractedAttributes": ["22x15x9cm 尺寸","Monogram 老花涂层帆布","棕色","金色五金"]
}`;

type LlmJson = {
  title?: string;
  brand?: string;
  series?: string;
  model?: string;
  skuCode?: string;
  categoryPath?: string[];
  gender?: string;
  colors?: string[];
  sizes?: string[];
  materials?: string[];
  targetAudience?: string;
  descriptionBullets?: string[];
  searchKeywords?: string[];
  useCase?: string[];
  bestForCustomerType?: string[];
  price?: string;
  merchant?: string;
  extractedAttributes?: string[];
};

function normalizeAzureEndpoint(raw: string): string {
  let normalized = String(raw || '').trim();
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    normalized = `${url.origin}${url.pathname}`;
  } catch {
    // 保留原值，让后续校验暴露问题
  }
  return normalized
    .replace(/\/+$/, '')
    .replace(/\/openai\/responses$/i, '')
    .replace(/\/openai\/v1\/responses$/i, '')
    .replace(/\/openai\/deployments\/[^/]+\/responses$/i, '')
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '');
}

function resolveAzureConfig(override?: Partial<AzureRuntimeConfig>): AzureRuntimeConfig | undefined {
  const endpoint = normalizeAzureEndpoint(
    override?.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT ?? ''
  );
  const apiKey = (override?.apiKey ?? process.env.AZURE_OPENAI_API_KEY ?? '').trim();
  const model = (
    override?.model ??
    process.env.AZURE_OPENAI_DEPLOYMENT ??
    process.env.AZURE_OPENAI_MODEL ??
    'gpt-5.4'
  ).trim();
  if (!endpoint || !apiKey || !model) return undefined;
  return { endpoint, apiKey, model };
}

function extractResponseText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const obj = data as Record<string, unknown>;

  if (typeof obj.output_text === 'string' && obj.output_text.trim()) {
    return obj.output_text;
  }

  const parts: string[] = [];
  const output = Array.isArray(obj.output) ? obj.output : [];
  for (const item of output) {
    const content = (item as { content?: unknown })?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown })?.text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  return parts.join('\n').trim();
}

async function tryAzureNormalize(
  raw: ScrapedDetail,
  override?: Partial<AzureRuntimeConfig>
): Promise<{ card?: GxhyappProductCard; error?: string }> {
  const cfg = resolveAzureConfig(override);
  if (!cfg) return {};

  const userPayload = {
    sourceUrl: raw.sourceUrl,
    code: raw.code,
    pageTitle: raw.pageTitle,
    titleCandidates: raw.titleCandidates,
    priceCandidates: raw.priceCandidates,
    merchantCandidates: raw.merchantCandidates,
    brandCandidates: raw.brandCandidates,
    modelCandidates: raw.modelCandidates,
    descriptionBlocks: raw.descriptionBlocks.slice(0, 12),
    imageCount: raw.images.length,
    sampleImages: raw.images.slice(0, 6),
    // 用户从真实页面复制的补充文本（含价格/商家/型号等 SPA 动态内容）
    ...(raw.extraText ? { extraText: raw.extraText } : {}),
    // Playwright 渲染后的 hydrated 正文（优于空 HTML）
    ...(raw.renderedBodyText ? { renderedBodyText: raw.renderedBodyText } : {})
  };

  // 多模态：先文字信号，再附主图 + 最多 8 张组图（足够覆盖一个商品的全部展示图）
  const visualImages = [raw.mainImageCandidate, ...raw.images]
    .filter((url): url is string => typeof url === 'string' && url.length > 0)
    .filter((url, i, arr) => arr.indexOf(url) === i)
    .slice(0, 9);

  const content: Array<
    { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }
  > = [
    { type: 'input_text', text: SYSTEM_PROMPT },
    { type: 'input_text', text: JSON.stringify(userPayload) }
  ];
  // 先送整页截图（最高优先级的视觉证据，含价格/商家/描述等文本）
  if (raw.screenshotDataUrl) {
    content.push({ type: 'input_image', image_url: raw.screenshotDataUrl });
  }
  for (const url of visualImages) {
    content.push({ type: 'input_image', image_url: url });
  }

  const url = `${cfg.endpoint}/openai/v1/responses`;

  try {
    const response = await axios.post(
      url,
      {
        model: cfg.model,
        max_output_tokens: 1200,
        input: [{ role: 'user', content }]
      },
      {
        timeout: 45_000,
        headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
        validateStatus: (status) => status >= 200 && status < 500,
        // 绕开 macOS mDNSResponder 卡住的 getaddrinfo；详见 src/lib/net/dns-agent.ts
        httpsAgent: httpsAgentWithCustomDns
      }
    );

    if (response.status >= 400 || response.data?.error) {
      const detail =
        response.data?.error?.message ?? JSON.stringify(response.data).slice(0, 300);
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }

    const text = extractResponseText(response.data);
    if (!text) return { error: 'Azure 返回为空（max_output_tokens 可能耗尽或输出被滤）' };
    const cleaned = text.replace(/```json|```/g, '').trim();
    let parsed: LlmJson;
    try {
      parsed = JSON.parse(cleaned) as LlmJson;
    } catch {
      return { error: `LLM 返回不是合法 JSON：${cleaned.slice(0, 200)}` };
    }

    // 审计日志：落盘到 data/llm-audit，便于后续调优 prompt / 证据还原
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const auditDir = path.join(process.cwd(), 'data', 'llm-audit');
      await fs.mkdir(auditDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(auditDir, `gxhyapp_${raw.code || 'unknown'}_${ts}.json`);
      await fs.writeFile(
        file,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            sourceUrl: raw.sourceUrl,
            sourceCode: raw.code,
            model: cfg.model,
            userPayload,
            rawResponseText: text,
            parsed
          },
          null,
          2
        ),
        'utf-8'
      );
    } catch (auditErr) {
      // 不阻断主流程
      // eslint-disable-next-line no-console
      console.warn('[gxhyapp normalizer] 审计日志写入失败：', auditErr);
    }

    return { card: mergeLlmIntoHeuristic(raw, parsed) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.warn('[gxhyapp normalizer] Azure 调用失败：', msg);
    return { error: msg };
  }
}

function mergeLlmIntoHeuristic(raw: ScrapedDetail, llm: LlmJson): GxhyappProductCard {
  const base = heuristicNormalize(raw);
  // 置信度考虑更多字段：名称、品牌、型号、价格、商家、性别、颜色、材质、卖点
  const flagsLlm = [
    llm.title,
    llm.brand,
    llm.model,
    llm.price,
    llm.merchant,
    llm.gender && llm.gender !== '未确认' ? '1' : '',
    Array.isArray(llm.colors) && llm.colors.length > 0 ? '1' : '',
    Array.isArray(llm.materials) && llm.materials.length > 0 ? '1' : '',
    Array.isArray(llm.descriptionBullets) && llm.descriptionBullets.length > 0 ? '1' : ''
  ];
  const overall = Math.min(1, flagsLlm.filter(Boolean).length / flagsLlm.length);

  return {
    ...base,
    title: llm.title || base.title,
    brand: llm.brand || base.brand,
    series: llm.series || base.series,
    model: llm.model || base.model,
    skuCode: (llm.skuCode || '').trim() || raw.code || base.skuCode || '',
    categoryPath:
      Array.isArray(llm.categoryPath) && llm.categoryPath.length > 0
        ? llm.categoryPath
        : base.categoryPath,
    price: llm.price || base.price,
    merchant: llm.merchant || base.merchant,
    extractedAttributes:
      Array.isArray(llm.extractedAttributes) && llm.extractedAttributes.length > 0
        ? llm.extractedAttributes
        : base.extractedAttributes,
    gender: (llm.gender || base.gender || '未确认').trim(),
    colors: Array.isArray(llm.colors) ? llm.colors.filter(Boolean) : base.colors,
    sizes: Array.isArray(llm.sizes) ? llm.sizes.filter(Boolean) : base.sizes,
    materials: Array.isArray(llm.materials) ? llm.materials.filter(Boolean) : base.materials,
    targetAudience: (llm.targetAudience || base.targetAudience || '').trim(),
    descriptionBullets: Array.isArray(llm.descriptionBullets)
      ? llm.descriptionBullets.filter(Boolean).slice(0, 5)
      : base.descriptionBullets,
    searchKeywords: Array.isArray(llm.searchKeywords)
      ? llm.searchKeywords.map((s) => String(s).trim()).filter(Boolean).slice(0, 20)
      : undefined,
    useCase: Array.isArray(llm.useCase)
      ? llm.useCase.map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
      : undefined,
    bestForCustomerType: Array.isArray(llm.bestForCustomerType)
      ? llm.bestForCustomerType.map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
      : undefined,
    // 库存 / 货币 从 base 启发（LLM 不负责这些硬事实），但如果 LLM 重写了 price，重推货币
    inStock: base.inStock,
    stockText: base.stockText,
    currency: detectCurrencyFromPrice(llm.price || base.price) ?? base.currency,
    confidence: { overall, source: 'llm' }
  };
}
