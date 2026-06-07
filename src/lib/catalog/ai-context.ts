import 'server-only';
import { listProducts, type CatalogProduct } from '@/lib/catalog/repo';
import type { WaMessage } from '@/lib/wa/store';

function normalizeTokens(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(-20);
}

function productHaystack(p: CatalogProduct): string {
  return [
    p.title,
    p.brand,
    p.series,
    p.model,
    p.skuCode,
    p.categoryPath?.join(' '),
    p.attributes?.join(' '),
    p.colors?.join(' '),
    p.sizes?.join(' '),
    p.materials?.join(' '),
    p.targetAudience,
    p.descriptionBullets?.join(' '),
    p.searchKeywords?.join(' '),
    p.useCase?.join(' '),
    p.bestForCustomerType?.join(' '),
    p.stockText
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function scoreProduct(p: CatalogProduct, tokens: string[]): number {
  const haystack = productHaystack(p);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length >= 4 ? 3 : 1;
  }
  if (p.inStock === true) score += 2;
  if (p.mainImage) score += 1;
  if (p.priceNumber != null) score += 1;
  return score;
}

/**
 * 把「顶级品类字符串」（catalog 的 categoryPath[0]）归一到一个稳定的桶 key。
 *
 * 设计要点（关键：可扩展到未来任意新品类）：
 * - 已知跨写法的同义品类做合并（鞋履/鞋靴→鞋、箱包/手袋→包…）；
 * - 命不中合并表的就原样返回 categoryPath[0] —— 这样未来 catalog 新增「手表 / 饰品 /
 *   挂件 / 香水…」无需改代码就自动成为各自独立的桶。
 */
const TOP_CATEGORY_MERGE: Array<[RegExp, string]> = [
  [/^(鞋|靴)/, '鞋'],
  [/^(箱包|手袋|包)/, '包'],
  [/^(服饰|服装|男装|女装|童装)/, '服饰']
];

function canonicalTopCategory(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  for (const [re, key] of TOP_CATEGORY_MERGE) if (re.test(t)) return key;
  return t; // 未知顶级品类 → 自成一桶，未来新品类零改动可用
}

function productTopCategory(p: CatalogProduct): string | null {
  return canonicalTopCategory(p.categoryPath?.[0]);
}

/**
 * 从 catalog 自身派生「区分性词表」：token → 唯一归属的品类。
 *
 * 对每个商品，把它的 categoryPath / searchKeywords / attributes / useCase / 标题 拆词，
 * 归到该商品的顶级品类。最后只保留「只出现在单一品类」的 token（跨品类的通用词，如品牌名
 * chanel、通用词 mini 会被丢弃），避免误判。
 *
 * 这样判定「客户文本属于哪个品类」完全由数据驱动：未来 catalog 新增手表/饰品/挂件等，
 * 它们的关键词（watch/腕表/项链/吊坠…）会自动进词表，无需改代码。
 */
function buildCategoryVocab(items: CatalogProduct[]): Map<string, string> {
  const tokenToCats = new Map<string, Set<string>>();
  for (const p of items) {
    const cat = productTopCategory(p);
    if (!cat) continue;
    const raw = [
      ...(p.categoryPath ?? []),
      ...(p.searchKeywords ?? []),
      ...(p.attributes ?? []),
      ...(p.useCase ?? []),
      p.title
    ]
      .filter(Boolean)
      .join(' ');
    for (const tok of normalizeTokens(raw)) {
      let set = tokenToCats.get(tok);
      if (!set) {
        set = new Set();
        tokenToCats.set(tok, set);
      }
      set.add(cat);
    }
  }
  const vocab = new Map<string, string>();
  for (const [tok, cats] of tokenToCats) {
    if (cats.size === 1) vocab.set(tok, [...cats][0]);
  }
  return vocab;
}

/**
 * 已知主力品类的「快速正则」：覆盖当前主营 + 常见中英文同义词，能识别像「包 / 鞋 / 手表」
 * 这种单字/短词（normalizeTokens 会因长度<2 丢掉单个汉字，所以这里用正则兜住）。
 * 命不中再交给 catalog 派生词表（覆盖商品专有词 + 未来新品类）。
 */
const QUICK_CATEGORY_RE: Array<[RegExp, string]> = [
  [/(鞋|靴|乐福|板鞋|跑鞋|运动鞋|休闲鞋|高跟|凉鞋|sneaker|shoe|boot|loafer|kicks)/i, '鞋'],
  // 包：bag/手袋/链条… + 单字「包」但排除「包邮/包装/包括/包裹/包含」等非箱包语义
  [/(箱包|手袋|手提|链条|斜挎|单肩|背包|水桶包|托特|手拿|钱包|卡包|包包|包(?!邮|装|括|裹|含|月|年)|\bbags?\b|\bpurses?\b|handbag|tote|crossbody|backpack|hobo|clutch|wallet)/i, '包'],
  [/(外套|夹克|大衣|衬衫|卫衣|t恤|短裤|长裤|牛仔|连衣裙|半身裙|裙|裤|服饰|男装|女装|jacket|coat|shirt|hoodie|dress|skirt|pants|trousers|jeans|shorts)/i, '服饰'],
  [/(手表|腕表|watch)/i, '手表'],
  [/(项链|手链|手镯|戒指|耳环|耳钉|饰品|首饰|珠宝|necklace|bracelet|ring|earring|jewel(le)?ry)/i, '饰品'],
  [/(挂件|吊坠|挂饰|pendant|charm|keychain|钥匙扣)/i, '挂件']
];

/** 否定词（中英）：用于识别「不要鞋 / not shoes / instead of bags」这类排除语义。 */
const NEGATION_MARKERS =
  /(\bnot\b|\bno\b|n['’]?t\b|\bdon['’]?t\b|\bwithout\b|\bexcept\b|\binstead of\b|\brather than\b|不要|不想|不用|不是|不喜欢|不需要|别|无需|而不是)/i;

/**
 * 判断某个品类匹配是否被否定：只在「同一小句」内、匹配位置之前的小窗口里找否定词，
 * 用标点/换行切句避免跨句误判（例如「not red, show bags」里的 not 只否定 red，不否定 bag）。
 */
function isNegated(text: string, matchIndex: number): boolean {
  const before = text.slice(0, matchIndex);
  const clause = before.split(/[，,。.;；!！?？\n]/).pop() ?? before;
  return NEGATION_MARKERS.test(clause.slice(-16));
}

/**
 * 文本 → 品类信号：返回「想要的品类(positives)」与「明确不要的品类(negatives)」。
 * 先走主力品类快速正则（收集全部命中并各自判否定），命不中再走 catalog 派生词表兜底。
 * 关键：不再「首个正则命中即返回」，否则「i prefer bag, not shoes」会因先匹配到 shoes 误判成鞋。
 */
function categorizeText(
  text: string | undefined,
  vocab: Map<string, string>
): { positives: string[]; negatives: string[] } {
  const positives: string[] = [];
  const negatives: string[] = [];
  if (!text) return { positives, negatives };
  let matchedQuick = false;
  for (const [re, cat] of QUICK_CATEGORY_RE) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      matchedQuick = true;
      (isNegated(text, m.index) ? negatives : positives).push(cat);
      if (m.index === g.lastIndex) g.lastIndex++; // 防零宽匹配死循环
    }
  }
  if (!matchedQuick) {
    for (const tok of normalizeTokens(text)) {
      const cat = vocab.get(tok);
      if (cat) {
        positives.push(cat);
        break;
      }
    }
  }
  return { positives, negatives };
}

/**
 * 从最近消息里推断「当前语境品类」。按时间倒序（最新优先）扫描，并累积「被否定的品类」：
 *   1. 消息文本里识别到的品类信号 —— 否定的（如 not shoes / 不要鞋）记入排除集，
 *      正向且未被排除的品类直接返回（尊重客户主动切品类，如"看看手表"）；
 *   2. 引用了具体商品（productId 命中 catalog）的消息 → 取该商品顶级品类（若未被排除）
 *      —— 通常就是我们刚发过去那几款，代表当前正在聊的东西；
 *   3. productTitle 文本兜底（历史回灌的商品消息可能只剩标题）。
 * 都没有则返回 null（不加品类约束，退回纯关键词打分）。
 *
 * 否定累积保证：客户最新说 not shoes 时，即使更早历史里发过鞋，也不会把鞋顶上来。
 */
function detectActiveCategory(
  messages: WaMessage[],
  byId: Map<string, CatalogProduct>,
  vocab: Map<string, string>
): string | null {
  const excluded = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const fromText = categorizeText(m.text, vocab);
    for (const n of fromText.negatives) excluded.add(n);
    const posText = fromText.positives.find((c) => !excluded.has(c));
    if (posText) return posText;
    if (m.productId) {
      const p = byId.get(m.productId);
      const c = p && productTopCategory(p);
      if (c && !excluded.has(c)) return c;
    }
    const fromTitle = categorizeText(m.productTitle, vocab);
    for (const n of fromTitle.negatives) excluded.add(n);
    const posTitle = fromTitle.positives.find((c) => !excluded.has(c));
    if (posTitle) return posTitle;
  }
  return null;
}

function formatProductLine(p: CatalogProduct): string {
  const bits = [
    p.brand && p.brand !== '品牌待确认' ? p.brand : '',
    p.model && p.model !== '型号待确认' ? p.model : '',
    p.title
  ].filter(Boolean);
  const name = Array.from(new Set(bits)).join(' / ');
  const attrs = [
    p.categoryPath?.slice(-2).join('>'),
    p.colors?.slice(0, 3).join('/'),
    p.sizes?.slice(0, 3).join('/'),
    p.price || '',
    p.inStock === true ? '有货' : p.inStock === false ? '缺货' : p.stockText || ''
  ].filter(Boolean);
  const selling = p.descriptionBullets?.slice(0, 2).join('；') || p.searchKeywords?.slice(0, 5).join('/');
  return `- ${name}${attrs.length ? ` | ${attrs.join(' | ')}` : ''}${selling ? ` | 卖点: ${selling}` : ''}`.slice(0, 360);
}

export async function buildCatalogContextForMessages(messages: WaMessage[], limit = 4): Promise<string> {
  const ranked = await rankProductsForMessages(messages, limit);
  if (ranked.length === 0) return '';
  return `\n\nCatalog matches the seller may recommend if relevant (do not invent unavailable details; if uncertain, ask a question first):\n${ranked
    .map(formatProductLine)
    .join('\n')}\n`;
}

/**
 * 对最近若干条消息提取关键词并匹配 catalog，按相关性 + 是否有图 + 库存排序后返回前 N 个商品。
 * 用于「AUTO_FULL 自动发送商品」等需要拿到原始 product 对象的场景。
 *
 * 可选 opts：
 *   - slotBias  : 额外的偏好词（如 slots.category / colorPref），算入 token 增加权重
 *   - excludeIds: 24h 内已发过的商品 id，直接跳过
 *   - requireImage: 仅返回 mainImage 非空的商品
 */
export async function rankProductsForMessages(
  messages: WaMessage[],
  limit = 3,
  opts?: { slotBias?: string[]; excludeIds?: string[]; requireImage?: boolean }
): Promise<CatalogProduct[]> {
  const recentText = messages
    .slice(-8)
    .map((m) => m.text || m.productTitle || '')
    .filter(Boolean)
    .join(' ');
  const baseTokens = normalizeTokens(recentText);
  const slotTokens = (opts?.slotBias ?? [])
    .filter(Boolean)
    .flatMap((s) => normalizeTokens(s));
  // 槽位 token 复制一次以加权
  const tokens = [...baseTokens, ...slotTokens, ...slotTokens];
  if (tokens.length === 0) return [];

  const exclude = new Set(opts?.excludeIds ?? []);
  const { items } = await listProducts({ sort: 'newest' });

  // 当前语境品类：用最近消息推断，避免历史里聊过的别的品类把推荐带偏
  // （例如先聊鞋、现在聊包，stale 的 slots.category 仍是"鞋"会把鞋顶上来）。
  // 词表由 catalog 自身派生，未来新增手表/饰品/挂件等品类零改动自动生效。
  const byId = new Map(items.map((p) => [p.id, p]));
  const vocab = buildCategoryVocab(items);
  const activeCategory = detectActiveCategory(messages, byId, vocab);

  const candidates = items
    .filter((p) => !exclude.has(p.id))
    .filter((p) => (opts?.requireImage ? !!p.mainImage : true));

  // 命中当前品类的子集打分排序。
  const ranked = (pool: CatalogProduct[]) =>
    pool
      .map((product) => ({ product, score: scoreProduct(product, tokens) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.product.updatedAt.localeCompare(a.product.updatedAt))
      .map((x) => x.product);

  let result = ranked(candidates);
  if (activeCategory) {
    // 关键：只要 catalog 里「确实存在」该品类的商品，就严格只发该品类 ——
    // 哪怕该品类的可选项都被 24h 已发去重排除而最终发不出（返回空、本轮不发），
    // 也绝不跨品类去发鞋/裤子。只有当 catalog 根本没有这个品类（可能是误判/未上架）
    // 时，才退回全量兜底，避免完全发不出东西。
    const catalogHasCategory = items.some((p) => productTopCategory(p) === activeCategory);
    if (catalogHasCategory) {
      result = ranked(candidates.filter((p) => productTopCategory(p) === activeCategory));
    }
  }
  return result.slice(0, limit);
}
