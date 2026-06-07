import 'server-only';
import {
  getMessages,
  listConversations,
  setConversationDraft,
  appendOutgoing,
  patchConversationSalesState,
  recordSentProduct,
  countRecentAiAutoSends,
  markConversationNudged,
  type WaConversation,
  type WaMessage
} from '@/lib/wa/store';
import { resolveAlias } from '@/lib/wa/alias-map';
import { callAzureResponses, resolveAzure } from '@/lib/ai/azure';
import { buildCatalogContextForMessages, rankProductsForMessages } from '@/lib/catalog/ai-context';
import { searchCatalogByImage } from '@/lib/catalog/image-search';
import { getProduct, listProducts, type CatalogProduct } from '@/lib/catalog/repo';
import { loadStrategyBook, selectStrategy } from '@/lib/pricing/strategy-book';
import { listPaymentMethodLabelsForAi } from '@/lib/payments/store';
import {
  autopilotGate,
  detectRisks,
  getAutopilotState,
  isConversationPaused,
  logAiAction,
  pauseConversationAutopilot,
  type AutoMode
} from '@/lib/ai/autopilot';
import { classifyStage, extractSlots, STAGE_LABEL, type SalesStage, type Slots } from '@/lib/ai/sales-stage';
import { sendPersonalText, sendPersonalImage, isPersonalReady } from '@/lib/wa/personal-client';

/**
 * AI 主动响应：在收到客户新消息后被 inbound handler fire-and-forget 调用。
 *
 *   DRAFT_AUTO  → 起草一条建议，写入 conversation.aiDraft；前端轮询拿到后填进输入框
 *   AUTO_SAFE   → 自动发送，但任何风险词命中都被 autopilotGate 拦回人工（aiSource=auto-safe）
 *   AUTO_FULL   → 自动发送；风险词命中由 autopilotGate 降级到人工（aiSource=auto-full）
 *   OFF/SUGGEST → 不做事
 *
 * 兜底护栏：
 *   - 全局 killSwitch / 会话暂停 / 服务端 Azure 未配置：静默跳过
 *   - 每条客户消息都会触发一次；发送前随机等 1-5 秒，让节奏更像真人
 *   - personal client 没 ready 时也跳过（cloud API 还没接入服务端 token）
 *   - 任何异常都吃掉，不能让 WhatsApp message handler 崩
 */

/** 服务端 Azure 配置缺失时的提示，每 5 分钟最多打一次，避免日志刷屏。 */
let lastAzureMissingWarnAt = 0;
function warnAzureMissingOnce(): void {
  const now = Date.now();
  if (now - lastAzureMissingWarnAt < 5 * 60_000) return;
  lastAzureMissingWarnAt = now;
  // eslint-disable-next-line no-console
  console.warn(
    '[auto-respond] 服务端未配置 Azure，AUTO_*/DRAFT_AUTO 无法工作。' +
      '请在 .env.local 设置 AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT。'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelayMs(): number {
  return 1_000 + Math.floor(Math.random() * 4_000);
}

/** 中日韩（含韩文音节）字符，用于「脚本不一致」的快速判定。 */
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/** 语言码归一到基础语种（zh-CN -> zh、EN -> en）。 */
function baseLang(code: string | undefined): string {
  return (code || '').toLowerCase().trim().split(/[-_]/)[0];
}

/** 各书写系统的脚本探测。 */
const SCRIPT_RE = {
  hangul: /[\uac00-\ud7af]/,
  kana: /[\u3040-\u30ff]/,
  han: /[\u3400-\u9fff]/,
  cyrillic: /[\u0400-\u04ff]/,
  arabic: /[\u0600-\u06ff]/
};

/**
 * 西文（拉丁）语种判别信号：停用词 + 特征变音符号。只覆盖应用支持的 en/de/fr/it
 * （见 src/lib/i18n/languages.ts）。用于区分「锁 DE 却漂成 EN」这类同脚本漂移。
 */
const LATIN_SIGNALS: Array<{ lang: string; words: RegExp; chars?: RegExp }> = [
  { lang: 'de', words: /\b(und|der|die|das|ich|ein|eine|für|nicht|mit|ist|sie|wir|auch|sehr|bitte|danke|hallo|guten|kann|haben|wird|noch|oder)\b/i, chars: /[äöüß]/i },
  { lang: 'fr', words: /\b(le|la|les|je|vous|et|pour|avec|ne|pas|une|est|nous|très|bonjour|merci|votre|nos|peux|avez|ceci|voici)\b/i, chars: /[àâçéèêëîïôûù]/i },
  { lang: 'it', words: /\b(il|lo|gli|di|che|per|con|non|una|sono|noi|molto|ciao|grazie|buongiorno|vostro|posso|avete|questo|ecco)\b/i, chars: /[ìòù]/i },
  { lang: 'en', words: /\b(the|you|and|for|with|this|your|are|have|our|can|will|please|thanks|thank|hello|here|let|show|some|prefer|just|would|like)\b/i }
];

/**
 * 轻量语种猜测（仅用于发出前的语言锁校验，不追求语言学严谨）：
 * 先按脚本判 CJK/西里尔/阿拉伯；纯拉丁再用停用词 + 变音符号在 en/de/fr/it 里打分。
 * 信号不足时返回 null —— 让调用方走保守的「脚本族」判断，避免把已正确文本误翻。
 */
function guessTextLang(text: string): string | null {
  if (SCRIPT_RE.hangul.test(text)) return 'ko';
  if (SCRIPT_RE.kana.test(text)) return 'ja';
  if (SCRIPT_RE.cyrillic.test(text)) return 'ru';
  if (SCRIPT_RE.arabic.test(text)) return 'ar';
  if (SCRIPT_RE.han.test(text)) return 'zh'; // 纯汉字（无假名）按中文处理
  let best: string | null = null;
  let bestScore = 0;
  for (const sig of LATIN_SIGNALS) {
    const words = (text.match(new RegExp(sig.words.source, 'gi')) || []).length;
    const chars = sig.chars && sig.chars.test(text) ? 2 : 0;
    const score = words + chars;
    if (score > bestScore) {
      bestScore = score;
      best = sig.lang;
    }
  }
  return bestScore >= 1 ? best : null;
}

/** LLM 拒答/兜底式回复（中英），绝不能当作话术直接发给客户。 */
const REFUSAL_RE =
  /(i['’]?m sorry,? but i (can|cannot|can['’]?t)|i (can|cannot|can['’]?t)\s*(not)?\s*(assist|help)|as an ai|i am unable to|i['’]?m not able to|i cannot comply|抱歉[，,]?\s*我(无法|不能)|无法协助|无法处理该请求|作为(一个)?\s*ai)/i;

function looksLikeRefusal(text: string): boolean {
  return REFUSAL_RE.test(text);
}

/**
 * 生成话术失败（Azure 抖动）时的「过渡话术」兜底。按发出语言锁返回对应语言默认句，
 * 避免在锁了非中文的会话里漏出中文兜底。锁未设或为中日韩时给中文。
 * 刻意用「数量中性」措辞（不写"两款"），因为真正发几张图由系统按库存/去重决定，
 * 写死数字会再次造成「说两款发一款」的不一致。
 */
function defaultTransitionLine(outputLang: string | undefined): string {
  const base = baseLang(outputLang);
  const lines: Record<string, string> = {
    zh: '我发给你看看',
    ja: 'お見せしますね',
    ko: '보여드릴게요',
    de: 'Ich zeige es Ihnen',
    fr: 'Je vous montre ça',
    it: 'Glielo mostro',
    en: 'Let me show you'
  };
  if (!base || base === 'auto') return lines.zh;
  return lines[base] ?? lines.en;
}

/**
 * 「发出语言锁」服务端硬兜底。
 *
 * AUTO_* 与草稿路径只把 outputLang 当作 prompt 软提示，模型仍可能漂移（尤其阶段目标里
 * 内嵌了中文示例短语，会被原样吐出）。这里在发送前再做一次脚本一致性校验：若锁定语言与
 * 生成文本脚本明显不符（锁 EN 却含中日韩字符 / 锁中日韩却纯西文），就调用翻译把它纠正到
 * 锁定语言，行为与 inbox UI 的 maybeTranslateForSend 对齐，避免两条发送路径表现不一致。
 * 脚本一致（常见情况）直接放行，不额外消耗一次 AI 调用。
 */
async function enforceOutputLang(text: string, outputLang: string | undefined): Promise<string> {
  const lang = (outputLang || '').trim();
  if (!text || !lang || lang === 'auto') return text;
  const target = baseLang(lang);
  const guess = guessTextLang(text);
  let mismatch: boolean;
  if (guess) {
    // 中/日 汉字重叠：锁 zh 出 ja(纯汉字判成 zh) 或反之，不强制互翻，避免无谓调用
    if ((target === 'zh' && guess === 'ja') || (target === 'ja' && guess === 'zh')) mismatch = false;
    else mismatch = guess !== target;
  } else {
    // 信号不足（如纯品名/超短文本）→ 退回脚本族判断（CJK vs 非 CJK），保守不误翻
    const wantsCjk = /^(zh|ja|ko)/.test(target);
    mismatch = wantsCjk !== CJK_RE.test(text);
  }
  if (!mismatch) return text;
  const cfg = resolveAzure();
  if (!cfg) return text;
  const prompt = `You are a professional WhatsApp B2B sales translator.
Translate the following message to language code "${lang}" (use 简体中文 if zh).

Hard rules:
1. Preserve meaning, tone, emojis, line breaks, numbers, URLs and placeholders like {价格} VERBATIM.
2. If the source is already in the target language, return it unchanged.
3. Output ONLY the translated text. No quotes, no preamble, no explanation.

Source:
${text}`;
  try {
    const r = await callAzureResponses(cfg, prompt, { maxOutputTokens: 300, retries: 1 });
    if (!r.ok) return text;
    const out = r.text
      .replace(/^```[\w-]*\s*/m, '')
      .replace(/\s*```$/m, '')
      .replace(/^["「『]/, '')
      .replace(/["」』]$/, '')
      .trim();
    return out || text;
  } catch {
    return text;
  }
}

/**
 * AI 自动化节奏限速：每个会话每小时最多 N 条 AI 自动消息（文字 + 图片合计）。
 * 超过即跳过本次自动发送，避免被对方 WhatsApp 判风控。
 * 通过 AI_AUTO_HOURLY_LIMIT 环境变量覆盖；默认 60。
 */
const AI_AUTO_HOURLY_LIMIT = (() => {
  const v = Number(process.env.AI_AUTO_HOURLY_LIMIT);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 60;
})();

async function checkHourlyRateLimit(canonical: string): Promise<{ allow: boolean; sent: number; limit: number }> {
  const sent = await countRecentAiAutoSends(canonical, 3600_000);
  return { allow: sent < AI_AUTO_HOURLY_LIMIT, sent, limit: AI_AUTO_HOURLY_LIMIT };
}

/**
 * AI 自动答复中的「承诺发图」检测。客户没让，但 AI 主动说要发 → 立即就发，
 * 而不是只承诺、不动手。覆盖：「我给你发/挑/推荐/来款」「帮你找几款」等口语。
 */
function replyIsProductPromise(text: string): boolean {
  if (!text) return false;
  return /(给你|帮你).{0,4}(发|挑|推荐|找|来|看看).{0,8}(款|图|商品|看看|样|两|几|一|这|那)/.test(text)
    || /(我).{0,2}(发|挑|来).{0,6}(款|两款|几款|一款|图|你看)/.test(text)
    || /(send|show).{0,8}(you).{0,8}(some|a few|two|couple|pic|photo|model|style|design)/i.test(text);
}

/**
 * 客户是否在「明确要求再看/再要产品」。命中时即使 24h 去重把候选清空，
 * 也允许重发最相关的一款——客户主动再要，重发是自然的，不算骚扰，
 * 且能避免「AI 说要发却没发」。
 */
function isExplicitProductRequest(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  return (
    /(发|看看?|来|再|多|换|还有|另)\s*.{0,6}(款|图|包|鞋|货|商品|个|看)/.test(t) ||
    /\b(show|send|see|more|another|other|next|again)\b/i.test(t) ||
    /(perfect|love it|i\s+(want|like|need)|就这|要这|想要|可以发|发来)/i.test(t)
  );
}

/** 归一化文本用于判重：去掉空白/标点/符号/大小写差异，便于判断两条回复是否实质相同。 */
function normalizeForCompare(text: string): string {
  return (text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').trim();
}

/** 这条文字是不是在「问问题」。用于杜绝连续两条都在追问（客户最反感的体验）。 */
function looksLikeQuestion(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  return (
    /[?？]/.test(t) ||
    /(吗|呢|还是|要不要|想不想|哪[种款个样]|怎么样|如何)/.test(t) ||
    /\b(which|what|would you|do you|want me to|or)\b\s*\??$/i.test(t)
  );
}

/**
 * 从对话文本里粗探目的地国家（报价核价必需：运费按地区差异很大）。
 * 命中返回 ISO 国家码（与 pricing-strategy.json 的 regions 对齐），否则 undefined。
 * 仅用于判断「是否已知目的地」，真正算运费仍由人工/引擎按精确地区来。
 */
function detectRegionFromText(text: string): string | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  const map: Array<[RegExp, string]> = [
    [/(英国|伦敦|uk|united kingdom|\bgb\b|britain|england)/i, 'GB'],
    [/(德国|germany|\bde\b|deutschland)/i, 'DE'],
    [/(法国|france|\bfr\b|paris)/i, 'FR'],
    [/(荷兰|netherlands|holland|\bnl\b)/i, 'NL'],
    [/(比利时|belgium|\bbe\b)/i, 'BE'],
    [/(丹麦|denmark|\bdk\b)/i, 'DK'],
    [/(西班牙|spain|\bes\b)/i, 'ES'],
    [/(意大利|italy|\bit\b)/i, 'IT'],
    [/(瑞士|switzerland|\bch\b)/i, 'CH'],
    [/(挪威|norway|\bno\b)/i, 'NO'],
    [/(美国|america|\busa?\b|united states|纽约|new york|los angeles)/i, 'US'],
    [/(加拿大|canada|\bca\b)/i, 'CA'],
    [/(澳洲|澳大利亚|australia|\bau\b|sydney|melbourne)/i, 'AU'],
    [/(迪拜|阿联酋|中东|\buae\b|\bae\b|dubai|emirates)/i, 'AE']
  ];
  for (const [re, code] of map) if (re.test(t)) return code;
  return undefined;
}

/** 客户一条消息里塞了多个问题（如"有什么尺码，价格多少，退换货政策如何"）。 */
function isMultiQuestion(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  const qMarks = (t.match(/[?？]/g) || []).length;
  if (qMarks >= 2) return true;
  // 即便只有 0-1 个问号，命中多个不同话题维度也算多问题。
  const topics = [
    /(尺寸|尺码|码数|size|多大|几码)/i, // 尺码
    /(颜色|配色|color|什么色)/i, // 颜色
    /(价(钱|格)|多少钱|怎么卖|how much|price)/i, // 价格
    /(退|换|退货|换货|退款|return|refund|exchange|warranty|保修|售后)/i, // 退换/售后
    /(material|材质|皮质|真皮|面料)/i, // 材质
    /(发货|物流|运费|多久|shipping|delivery|交期)/i // 物流
  ];
  const hit = topics.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  return hit >= 2;
}

/**
 * 报价前置条件：金牌销售逻辑「先把下单必需的关键信息确认齐，再谈价格」。
 * - 鞋 / 服饰类：尺码是下单刚需，必须先确认；尺码确认前再软性确认一次颜色。
 * - 包 / 表等无尺码概念的：客户看中的就是图上那只，颜色=图片色，绝不反复追问颜色。
 * - 客户明确说「按图片同款 / 一样 / as shown / exact」时，颜色视为已确认。
 * 返回还缺的关键属性中文名数组（为空表示可以直接进入报价承接）。
 */
function missingQuotePrereqs(
  category: string | undefined,
  convText: string,
  slots: Slots
): string[] {
  const t = (convText || '').toLowerCase();
  const sizeMentioned =
    /(\b(3[5-9]|4[0-6])\b|us\s*\d|uk\s*\d|eu\s*\d|码|尺码|\bsize\b\s*\d|s\/m\/l|均码|大码|小码|\b[smlx]+\b\s*(码)?)/i.test(
      t
    );
  const wantsExactShown =
    /(图(片|上)|照片|原色|同款|一样|same as|as shown|in the (picture|photo)|like the (pic|photo|picture)|exact)/i.test(
      t
    );
  const colorKnown =
    !!slots.colorPref ||
    wantsExactShown ||
    /(黑|白|棕|米|裸|红|蓝|灰|粉|金|银|绿|紫|black|white|brown|beige|red|blue|grey|gray|pink|navy)/i.test(t);
  const missing: string[] = [];
  const needsSize = category === '鞋' || category === '上装' || category === '下装' || category === '裙';
  if (needsSize && !sizeMentioned) missing.push('尺码');
  // 颜色只对「有尺码概念」的服饰/鞋类做软校验；包/表等看的就是图上那只，颜色即图片色，不追问。
  if (needsSize && !colorKnown) missing.push('颜色');
  return missing;
}

function isAffirmativeShortReply(text: string | undefined): boolean {
  return /^(yes|yeah|yep|ok|okay|sure|confirm|confirmed|right|correct|对|是|嗯|好|可以|确认|没错|就这个|就这款)[.!。！\s]*$/i.test(
    (text || '').trim()
  );
}

function filterConfirmedQuotePrereqs(missing: string[], recent: WaMessage[]): string[] {
  if (!missing.length) return missing;
  const lastInbound = [...recent].reverse().find((m) => m.direction === 'in' && !!m.text);
  if (!lastInbound || !isAffirmativeShortReply(lastInbound.text)) return missing;
  const prevOutbound = [...recent]
    .reverse()
    .find((m) => m.direction === 'out' && !!m.text && (m.timestamp ?? 0) < (lastInbound.timestamp ?? 0));
  const prev = prevOutbound?.text || '';
  return missing.filter((item) => {
    if (item === '颜色' && /(颜色|配色|color|natural leather|black|white|brown|beige|red|blue|gray|grey|pink)/i.test(prev)) {
      return false;
    }
    if (item === '尺码' && /(尺码|码数|size|\bus\b|\buk\b|\beu\b)/i.test(prev)) {
      return false;
    }
    return true;
  });
}

/**
 * 共享的「按偏好选品」纯函数：套用 slot 偏好 + 24h 已发去重 + 必须有主图，
 * 返回排序后的前 limit 个商品。把「选品」与「发送」拆开，是为了让上游能先知道
 * 「这一轮到底有几款可发」，从而让承诺话术（一款/两款）与实际发送数量严格一致，
 * 并在「一款都没有」时干脆不要承诺发图（避免"说发却没发"）。
 */
async function selectProductsToSend(opts: {
  conv: WaConversation | undefined;
  recent: WaMessage[];
  slots: Slots;
  limit: number;
  /** 客户明确点名/要求再看（如"show me chanel bag"/"one more lv"）时为 true。 */
  explicitAsk?: boolean;
}): Promise<CatalogProduct[]> {
  const { conv, recent, slots, limit } = opts;
  const slotBias = Object.values(slots).filter(Boolean) as string[];
  const now = Date.now();
  const excludeIds = (conv?.lastSentProductIds ?? [])
    .filter((x) => now - x.ts < 24 * 3600_000)
    .map((x) => x.id);
  // 第 1 层（主动推荐）：24h 去重 + 品类过滤 + 必须有图 —— 优先发没发过的新款，避免刷屏。
  const fresh = await rankProductsForMessages(recent, Math.max(limit * 3, 6), {
    slotBias,
    excludeIds,
    requireImage: true
  });
  if (fresh.length > 0 || !opts.explicitAsk) return fresh.slice(0, limit);
  // 第 2 层（客户明确点名/再要）：去重后空了，则忽略 24h 去重重新排序 ——
  // 客户亲口要看（如 chanel），重发最相关的那款是自然的，不算骚扰，也远比"反复追问"好。
  const repeat = await rankProductsForMessages(recent, Math.max(limit * 3, 6), {
    slotBias,
    requireImage: true
  });
  return repeat.slice(0, limit);
}

/**
 * 收集「同品类在售可推荐」的替代款，用于「我再找找，先看看这几款」的引导。
 * 以最近发过的那款的顶级品类为准，挑出同品类、有图、未缺货且近期未发过的几款，返回 brand+title。
 */
async function gatherAlternatives(
  conv: WaConversation | undefined,
  refProduct: CatalogProduct | undefined,
  limit = 3
): Promise<string[]> {
  try {
    const now = Date.now();
    const recentlySent = new Set(
      (conv?.lastSentProductIds ?? [])
        .filter((x) => now - x.ts < 24 * 3600_000)
        .map((x) => x.id)
    );
    const topCat = refProduct?.categoryPath?.[0];
    const { items } = await listProducts({ sort: 'newest' });
    return items
      .filter((p) => !!p.mainImage && p.inStock !== false && !recentlySent.has(p.id))
      .filter((p) => (topCat ? p.categoryPath?.[0] === topCat : true))
      .slice(0, limit)
      .map((p) =>
        [p.brand && p.brand !== '品牌待确认' ? p.brand : '', p.series || p.title]
          .filter(Boolean)
          .join(' ')
          .trim()
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 共享的「按偏好选品 + 限速 + 发图」流程。给即时回复 + followup sweep 共用。
 * limit=2 时按 S3 推介一次发 2 款；limit=1 时 followup 只发 1 款投石问路。
 * 调用前请确认 mode === 'AUTO_FULL' && isPersonalReady()。
 * 可传 preselected 复用上游已选好的商品（避免重复排序，且保证承诺数量与实发一致）。
 */
async function autoSendProducts(opts: {
  canonical: string;
  mode: AutoMode;
  source: 'auto-safe' | 'auto-full';
  conv: WaConversation | undefined;
  recent: WaMessage[];
  slots: Slots;
  limit: number;
  reason: string;
  preselected?: CatalogProduct[];
}): Promise<{ sent: number }> {
  const { canonical, mode, source, conv, recent, slots, limit, reason } = opts;
  const picked =
    opts.preselected ?? (await selectProductsToSend({ conv, recent, slots, limit }));
  console.log('[auto-respond] autoSendProducts picked', {
    canonical, reason, pickedCount: picked.length, ids: picked.map((p) => p.id)
  });
  if (picked.length === 0) return { sent: 0 };
  let sentCount = 0;
  for (let i = 0; i < picked.length; i++) {
    const product = picked[i];
    const caption = await generateProductCaption(product, recent, conv?.outputLang);
    const productGate = await autopilotGate({
      conversationId: canonical, source, conversationMode: mode, text: caption
    });
    if (!productGate.allow) {
      await logAiAction({
        conversationId: canonical, source, mode,
        outcome: productGate.downgrade === 'NEEDS_HUMAN' ? 'downgraded' : 'blocked',
        reason: `自动发商品被拦：${productGate.reason}`,
        textPreview: `[${product.title}] ${caption}`
      });
      continue;
    }
    if (i > 0) await sleep(800 + Math.floor(Math.random() * 1200));
    const rlImg = await checkHourlyRateLimit(canonical);
    if (!rlImg.allow) {
      await logAiAction({
        conversationId: canonical, source, mode, outcome: 'blocked',
        reason: `节奏限速：过去 1 小时已自动发送 ${rlImg.sent}/${rlImg.limit} 条，剩余商品图跳过`,
        textPreview: `[${product.title}] ${caption}`
      });
      break;
    }
    const imgResult = await sendPersonalImage(canonical, product.mainImage, caption);
    const imgPersisted = await appendOutgoing({
      conversationId: canonical,
      imageUrls: [product.mainImage],
      productId: product.id,
      productTitle: product.title,
      text: caption,
      type: 'image',
      status: imgResult.ok ? 'sent' : 'failed',
      error: imgResult.ok ? undefined : imgResult.reason,
      aiAuto: true,
      aiSource: source,
      aiReason: `AI ${mode} ${reason}`
    });
    if (imgResult.ok) {
      sentCount += 1;
      await recordSentProduct(canonical, product.id);
    }
    await logAiAction({
      conversationId: canonical, source, mode,
      outcome: imgResult.ok ? 'sent' : 'blocked',
      reason: imgResult.ok ? `auto-sent product ${product.id} (${reason})` : imgResult.reason,
      messageId: imgPersisted.id,
      textPreview: `[${product.title}] ${caption}`
    });
    if (!imgResult.ok) break;
  }
  return { sent: sentCount };
}

/** 给一款商品生成≤40 字的 WhatsApp 推介短文案；Azure 不可用则回退到 brand+model+title。 */
async function generateProductCaption(
  product: CatalogProduct,
  recent: WaMessage[],
  outputLang: string | undefined
): Promise<string> {
  const bits = [
    product.brand && product.brand !== '品牌待确认' ? product.brand : '',
    product.model && product.model !== '型号待确认' ? product.model : '',
    product.title
  ].filter(Boolean);
  const fallback = Array.from(new Set(bits)).join(' / ').slice(0, 80);
  const cfg = resolveAzure();
  if (!cfg) return fallback;
  const transcript = buildTranscript(recent);
  const lang = outputLang || 'auto';
  const langInstruction =
    lang === 'auto'
      ? "Output language MUST match the customer's last message language."
      : `Output language MUST be ${lang} (use 简体中文 if lang=zh).`;
  const sellingBits = [
    product.brand && product.brand !== '品牌待确认' ? `Brand: ${product.brand}` : '',
    product.model && product.model !== '型号待确认' ? `Model: ${product.model}` : '',
    product.title ? `Title: ${product.title}` : '',
    product.colors?.length ? `Colors: ${product.colors.slice(0, 3).join('/')}` : '',
    product.descriptionBullets?.length
      ? `Selling: ${product.descriptionBullets.slice(0, 2).join('；')}`
      : ''
  ]
    .filter(Boolean)
    .join('\n');
  const prompt = `Write ONE short WhatsApp caption (≤ 40 chars, CJK=1) introducing this product to the customer. ${langInstruction}

Hard rules:
- No price, no stock, no shipping promise unless transcript already mentioned them.
- Natural, friendly; at most 1 emoji.
- One line, no quotes, no markdown.

Product:
${sellingBits}

Recent transcript:
${transcript}

Output ONLY the caption.`;
  try {
    const r = await callAzureResponses(cfg, prompt, { maxOutputTokens: 120, retries: 1 });
    if (!r.ok) return fallback;
    const text = r.text
      .split(/\r?\n/)
      .map((s) => s.replace(/^[-*•]\s*/, '').replace(/^["「『]|["」』]$/g, '').trim())
      .find((s) => s.length > 0);
    if (!text || looksLikeRefusal(text)) return fallback;
    return enforceOutputLang(text.slice(0, 80), outputLang);
  } catch {
    return fallback;
  }
}

const conversationQueues = new Map<string, Promise<void>>();

/** 突发合并计时器：canonical -> 待触发的 debounce timer。 */
const burstTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 突发合并窗口（毫秒）：客户在这么短时间内连发的多条消息，只在最后一条之后统一回应一次。
 * 设得太短起不到合并效果，太长则显得迟钝；默认 4s，可用 AI_AUTO_BURST_MS 覆盖（0=关闭合并）。
 */
const BURST_DEBOUNCE_MS = (() => {
  const v = Number(process.env.AI_AUTO_BURST_MS);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 4000;
})();

/**
 * 自动转人工冷却时长（毫秒）：自动识别到报价(S5)/物流发货(S6)/成交付款(S7)阶段后，
 * 自动暂停本会话 AI 自动发送的时长，等人工核价/出 PI/安排发货。
 * 注意：这是「自动识别」触发的冷却，与 Inbox 里「暂停本会话 60 分钟」手动按钮相互独立。
 * 默认 30 分钟，可用 AI_S5_HANDOFF_MIN 覆盖（分钟）。
 */
const S5_HANDOFF_PAUSE_MS = (() => {
  const v = Number(process.env.AI_S5_HANDOFF_MIN);
  return (Number.isFinite(v) && v > 0 ? Math.floor(v) : 30) * 60_000;
})();

function resolveEffectiveMode(conv: WaConversation | undefined, defaultMode: AutoMode): AutoMode {
  const m = (conv?.autoMode ?? defaultMode) as AutoMode;
  return m;
}

/**
 * 组装紧凑的 transcript 给 AI。
 * 只取最近 8 条；图片/视频压成占位符；单条截断 200 字。
 */
function buildTranscript(messages: WaMessage[]): string {
  return messages
    .slice(-8)
    .map((m) => {
      const who = m.direction === 'in' ? '客户' : '我(销售)';
      let body = '';
      if (m.text) body = m.text;
      else if (m.imageUrls?.length) body = '[图片]';
      else if (m.videoUrls?.length) body = '[视频]';
      else body = '[空]';
      if (body.length > 200) body = body.slice(0, 200) + '…';
      return `${who}: ${body}`;
    })
    .join('\n');
}

/**
 * 调 Azure 拿一条短回复。
 * 失败返回 null，由调用方静默跳过（不要打断 inbound 处理）。
 */
async function generateOneReply(
  conversationId: string,
  outputLang: string | undefined,
  context?: {
    stage?: SalesStage;
    slots?: Slots;
    aboutToSendProduct?: boolean;
    productCount?: number;
    guide?: { lastTitle?: string; lastBrand?: string; alternatives?: string[]; noQuestion?: boolean };
    quote?: {
      productTitle?: string;
      productBrand?: string;
      hasQty?: boolean;
      hasRegion?: boolean;
      /** 客户一条消息里问了多个问题（尺码+价格+退换货…），要按逻辑顺序接住、别漏也别越级。 */
      multiQuestion?: boolean;
      /** 报价前还缺的关键属性（如 ['尺码','颜色']）。非空时本轮先收齐这些，绝不越级报价。 */
      gatherFirst?: string[];
    };
    payment?: {
      /** 可向客户提及的收款方式名称（不含真实账号），如 ['PayPal','银行转账']。 */
      methodLabels?: string[];
      /** 客户是否已表示付款完成（触发发货前订单复核）。 */
      paid?: boolean;
    };
  }
): Promise<{ text: string; lang: string } | null> {
  const cfg = resolveAzure();
  if (!cfg) {
    warnAzureMissingOnce();
    return null;
  }
  const recent = await getMessages(conversationId, 12);
  if (recent.length === 0) return null;
  const transcript = buildTranscript(recent);
  const catalogContext = await buildCatalogContextForMessages(recent, 4);
  // 客户最近一条文本：用于「先正面接住客户真正问的」——避免答非所问（只顾走脚本、忽略客户的具体问题）。
  const lastInboundText =
    [...recent].reverse().find((m) => m.direction === 'in' && !!m.text)?.text?.slice(0, 280) ?? '';
  const lang = outputLang || 'auto';
  const langInstruction =
    lang === 'auto'
      ? "Output language MUST exactly match the customer's last message language."
      : `Output language MUST be ${lang} (use 简体中文 if lang=zh). The stage guidance below may contain Chinese sample phrases — treat them ONLY as intent, NEVER copy them verbatim; always write the reply in ${lang}.`;

  // 阶段化目标：让 prompt 知道这一轮该干什么，避免每条都"万能客服"。
  const stage = context?.stage ?? 'S1';
  const slots = context?.slots ?? {};
  const slotsLine = Object.entries(slots)
    .filter(([, v]) => !!v)
    .map(([k, v]) => `${k}=${v}`)
    .join(' / ') || '(none yet)';

  // 这一轮系统到底会不会真发图（已按库存/24h 去重定好）。
  // 关键：阶段目标必须随它变化——若本轮不发图，S3/S4 绝不能再叫模型说"我马上发给你看"，
  // 否则就会出现"说要发却没发"。
  const aboutToSend = !!context?.aboutToSendProduct;
  const count = context?.productCount;
  const countWord =
    count === 1 ? '一款' : count === 2 ? '两款' : count && count > 0 ? `${count}款` : '';

  // 成交/付款承接（S7）：收款账号/PI 永远走人工。AI 只接住 + 告知可用收款方式名称。
  const payment = stage === 'S7' ? context?.payment : undefined;
  const paidNow = !!payment?.paid;
  const payMethods = payment?.methodLabels?.length ? payment.methodLabels.join(' / ') : '';

  const STAGE_GOAL: Record<SalesStage, string> = {
    S1: '破冰：温暖问候 + 一句话点出主营品类；末尾留 1 个开放问题（不发产品/价格/链接）。',
    S2: '需求探询：只能问 1 个还没收齐的核心偏好（优先 category）；如果 category 已知，别再问问题了，直接说"马上发给你看看"。不发图。',
    S3: aboutToSend
      ? '产品推介：说一句"我马上发给你看看"之类的过渡话即可（具体发几款由系统按库存决定，绝不要自己写死"两款/几款"这类数字），绝不要再问任何问题（让图说话）；≤1 个 emoji；完全不要描述图里是什么。'
      : '产品推介（本轮不发图）：你想推的款近期都已经发过了，绝不要再说"我马上发/再发给你看"这类承诺（否则就是说了不做）。改为自然承接：问客户对刚发的款是否中意，或聚焦问 1 个偏好（颜色/尺寸/预算/数量）；≤1 个 emoji。',
    S4: aboutToSend
      ? '反馈承接：直接说"再发给你看看"并立刻退出（不要写死数量），不要问哪里哪里的细节。'
      : '反馈承接（本轮不发图）：可发的款近期都发过了，绝不要再承诺"再发给你看"。改为顺着客户上一条反馈走：若客户表达了喜欢/选定，就推进下一步（问数量/目的地）；若是负面反馈才聚焦问 1 个问题；≤1 个 emoji。',
    S5: '报价承接：禁止报出任何具体数字/区间！金牌销售节奏是：先双重确认是哪款（自然点出刚发的那只）→ 顺势问齐核价必需的 1-2 个信息（要几个/数量、发到哪个国家）→ 承诺快速给最优价（“我马上核个最好的价发你”）。只问还没收到的那个信息，别重复问。重要：如果款式/尺码/数量在前面对话里已经确认过了（哪怕客户没逐字复述、从语境能看出已定），就绝不要再重复确认，直接往前推进（核价/收货信息/付款），重复确认会显得很像机器人。不发图、不冷场、不说“稍后发你”这种空话。',
    S6: '物流话题：可以说大致区间（X-Y 天 / 按重量），但禁止承诺具体日期；最后让客户确认目的地国家与方式偏好。',
    S7: paidNow
      ? '发货前订单复核：客户已表示付款完成。你要发一条简短的订单复核，让客户最后确认无误后人工才安排发货——自然地复述这一单的关键信息：款式/型号、尺码、数量、收货国家/地址（这些都从前面对话里取，绝不要编造没出现过的信息；缺哪项就顺带问哪项），结尾一句"确认无误我这边马上给你安排发货"。不要重复报价或要求再次付款。≤1 个 emoji。'
      : '付款承接：客户在问怎么付款。收款账号和 PI 永远由人工核对后亲自发送，你绝不能自己写出任何账号/卡号/邮箱/金额。你要做的是：先接住客户，自然告知我们支持哪些收款方式（只说方式名称），并说"账号和 PI 我同事马上核对后发你"。款式/尺码这些前面早确认过了，绝不回头重复确认。≤1 个 emoji。'
  };

  // 如果调用方已决定本轮还会追商品主图，让 prompt 只生一句"发出去看"过渡文本，
  // 彻底避免一句话里又承诺发图又追问问题这种双重负担。
  // productCount 是「实际会发的张数」（已按库存/去重定好），用来让措辞里的数量与实发一致。
  const aboutToSendHint = aboutToSend
    ? `\nIMPORTANT: 系统在你这条文字发出后会立刻自动追加${count ? ` ${count} 张` : ''}商品主图。所以这条文字必须满足：\n  - 仅写一句过渡话（如"马上发你看" / "来你看这款" ≤ 15 字）\n  - 措辞要像真人朋友一样自然口语，绝不要用"重发/再发一次/resend/resending"这种生硬词\n  - ${countWord ? `如果提到数量，必须正好是「${countWord}」` : '不要提任何具体数量（如"两款""几款"）'}\n  - 绝不可以再追加任何问题、任何细节、任何商品描述\n  - 最多 1 个 emoji`
    : '';

  // 引导承接：客户还想再看产品，但库里能发的都发过了（本轮无新图可发）。
  // 金牌女销思路：不冷场、不空承诺、不连环追问。"我再找找" + 直接报出我们确实有的同类款，让客户有得选。
  const guide = !aboutToSend ? context?.guide : undefined;
  const guideRef = guide?.lastBrand
    ? `${guide.lastBrand}${guide.lastTitle ? ` ${guide.lastTitle}` : ''}`
    : guide?.lastTitle || '';
  const altList = guide?.alternatives?.length ? guide.alternatives.join('、') : '';
  const guideHint = guide
    ? `\nIMPORTANT 引导承接（本轮没有新图可发）：客户还在看货，你要像一位体贴的金牌女销那样接住，而不是冷场或连环追问：\n  - 先顺一句"我再帮你找找/再着一下"的话（别说"没有/发过了/库存没了"这类扫兴的话）${guideRef ? `，可以自然提一句之前那款（${guideRef}）` : ''}\n  - ${altList ? `然后主动推荐我们确实在售的同类款：${altList}（报出具体名字，别只说"别的款"），语气像推荐给闺蜜` : '顺势推荐一下我们其他热销款，给客户一个台阶'}\n  - ${guide.noQuestion ? '你上一条已经问过问题了，这一条绝对不要再问任何问题，改成直接报出选择让客户挑' : '最多问 1 个轻松的问题（风格/预算/品牌偏好），绝不连问两个'}\n  - 绝不要承诺"马上发/再发图"，也绝不要说"resend/重发"\n  - 像真人朋友，≤ 1 个 emoji`
    : '';

  // 报价承接（S5）：客户问价。不报数字，但要双重确认款、收齐核价信息（数量+目的地）、快速锁住客户。
  const quote = stage === 'S5' ? context?.quote : undefined;
  const quoteRef = quote?.productBrand
    ? `${quote.productBrand}${quote.productTitle ? ` ${quote.productTitle}` : ''}`
    : quote?.productTitle || '';
  const quoteNeed = quote
    ? [!quote.hasQty ? '数量（要几个/MOQ）' : '', !quote.hasRegion ? '发货目的地国家' : '']
        .filter(Boolean)
        .join(' 和 ')
    : '';
  const gatherFirst = quote?.gatherFirst?.length ? quote.gatherFirst.join('、') : '';
  const multiQ = !!quote?.multiQuestion;
  const quoteHint = quote
    ? gatherFirst
      ? `\nIMPORTANT 报价前置（金牌销售：先确定款式/尺码/颜色，再谈价格）：客户虽然在问价，但${gatherFirst}还没确认，这种关键属性不齐是没法准确核价的，所以本轮绝不能跳到报价或承诺核价，要先把前置信息收齐：\n  - ${quoteRef ? `先自然双重确认是这款（${quoteRef}）` : '先自然确认是看中哪一款'}${multiQ ? '，并让客户感到他问的几个问题你都记下了（"价格/退换我都会跟你说"），但顺序上先确认关键的' : ''}\n  - 然后聚焦问还缺的关键属性：${gatherFirst}（鞋/服饰必须先有尺码和颜色才好下单和算价，问得理所当然）\n  - 顺一句"确认好${gatherFirst}我马上给你核最优价"，让客户知道价格不会被忽略，但要先把这步走完\n  - 本轮绝不报任何数字/区间，也不要承诺"现在就去核价"；最多 1 个问题，别一次问太多；≤ 1 个 emoji`
      : `\nIMPORTANT 报价承接（客户在问价）：你是一位反应快、不拖泥带水的金牌销售。本轮绝不能报任何具体数字或区间（正式价同事会核后发），但要让客户感觉被接住了：\n  - 先正面接住客户这条真正问的：如果他问的是「多买/几双有没有优惠」就先就数量优惠表态（不报数字，可说"量大我帮你争取更好的价"），问退换货就一句话讲清政策，绝不能无视客户问的、自顾自只问"发哪个国家"\n  - ${quoteRef ? `只有在前面还没确认过是哪款时，才自然确认一下是这款（${quoteRef}）；如果款式/尺码前面已经确认过或语境已明确，就绝对不要再重复确认，直接往前推进` : '如果还没确认过是问哪一款才确认一下，已经清楚的就别再问'}\n  - ${quoteNeed ? `顺势补齐还缺的核价必需信息：${quoteNeed}（算价必需，问得理所当然）` : '数量和目的地都已知，直接承诺"我马上核个最好的价发您"并给个大致时间（几分钟内）'}${multiQ ? '\n  - 客户这条问了好几个问题，逐一接住别漏（如退换货可一句话带过），但按逻辑顺序来：先答关键的，价格放最后' : ''}\n  - 只问还没收到的那个信息，问过的、已经定了的绝不要再问；最多一个问题\n  - 绝不说"稍后发您/整理一下"这种冷场空话，语气要让客户愿意等；≤ 1 个 emoji`
    : '';

  // 成交/付款承接（S7）：收款账号/PI 永远走人工。AI 接住 + 告知方式名称（不发账号），或客户已付款→订单复核。
  const paymentHint = payment
    ? paidNow
      ? `\nIMPORTANT 发货前订单复核（客户已表示付款完成）：你要发一条简短自然的订单复核，让客户最后确认无误，人工才安排发货：\n  - 自然复述这一单的关键信息（从前面对话里取，绝不编造没出现过的）：款式/型号、尺码、数量、收货国家/地址\n  - 如果某项信息前面没出现过（比如收货地址还没给），就顺带问一句补上，别瞎填\n  - 结尾一句"确认无误我这边马上给你安排发货"\n  - 绝不要再要求付款、不要再报价、不要重复确认早就定好的；≤ 1 个 emoji`
      : `\nIMPORTANT 付款承接（客户在问怎么付款）：收款账号、PI 永远由人工核对后亲自发，你**绝对不能**自己写出任何账号/卡号/PayPal邮箱/SWIFT/金额：\n  - 先自然接住客户${payMethods ? `，告知我们支持这些收款方式：${payMethods}（只说方式名称，不要写账号）` : '，告知我们支持常见的几种收款方式（只说类别，不写账号）'}\n  - 再顺一句"账号和 PI 我同事这就帮你核对后发过来"，让客户安心等\n  - 款式/尺码这些前面早确认过了，绝不回头重复确认；≤ 1 个 emoji`
    : '';

  // 语气按客户语言分流：欧美客户吃"专业自信的销售强调"，东亚客户吃"亲切真人"。
  // 不要把中文的"闺蜜/老板娘"casual 套到欧美客户身上。
  const styleBase = (() => {
    const b = baseLang(outputLang);
    if (b && b !== 'auto') return b;
    const lastIn = [...recent].reverse().find((m) => m.direction === 'in' && !!m.text);
    return guessTextLang(lastIn?.text ?? '') ?? 'zh';
  })();
  const isWesternStyle = !/^(zh|ja|ko)/.test(styleBase);
  const personaLine = isWesternStyle
    ? 'You are a real, polished luxury personal shopper / reseller who runs her own sourcing business and is chatting on WhatsApp. You are confident, warm and professional — the kind of top salesperson who leads the conversation, emphasizes value and follows up assertively (Western clients expect this). You are NOT a bot and must NEVER come across as one.'
    : 'You are a real human reseller chatting on WhatsApp — a warm, sharp golden-medal saleswoman who runs her own buying business. You are NOT a bot and must NEVER come across as one.';
  const toneRule = isWesternStyle
    ? 'Sound like a real, polished salesperson — confident, professional, personable. Lead and emphasize value; it is fine to be a little assertive. NOT stiff corporate customer-service, but NOT over-casual buddy-talk either. At most one emoji (often zero).'
    : 'Sound like a real person texting a friend, NOT customer service. Casual, warm, a little personality. At most one emoji (often zero).';

  const prompt = `${personaLine} Generate ONE short, ready-to-send next reply.

${langInstruction}

Current funnel stage: ${stage} (${STAGE_LABEL[stage]})
Stage goal: ${STAGE_GOAL[stage]}
Known customer preferences: ${slotsLine}${aboutToSendHint}${guideHint}${quoteHint}${paymentHint}

Hard rules:
1. ONE single message, ≤ 80 chars (CJK = 1 char). No quotes, no numbering, no markdown.
2. ${toneRule}
3. NEVER invent prices, stock, ship dates or SKUs not in the transcript. Use questions or placeholders like {价格}.
4. Follow the Stage goal strictly. Especially: in S5 never output any price number; in S6 never promise a date.
5. NEVER use these bot-tells: "收到，我给您整理…稍后发您"、"很高兴为您服务"、"请问还有什么可以帮您"、"亲，"、"您好！"开场、机械的"好的呢/没问题哦"、robotic perfect-grammar customer-service tone, or repeating the customer's question back. Vary every opening; do NOT start two replies the same way.
6. Don't end every message with a question. Sometimes just react, confirm, or send a quick human aside. Mirror the customer's length & vibe — if they're short, you're short.
7. If the customer's last message is small-talk, reply warm and human; do NOT push product info.
8. If the customer asks "are you AI / 真人吗 / 机器人吗"-style, brush it off naturally like a busy human, never confirm or deny mechanically, never say "as an AI".
9. 最重要——别答非所问：你必须先正面接住客户「最新这条消息」真正问的点。客户问尺码就先回应尺码、问退换货就先一句话讲退换、问"多买几个有没有优惠"就先就这个数量优惠表态（不报具体数字，可说"量大我帮你争取更好的价"），问颜色就回应颜色。绝不能无视客户明确问的、自顾自跳到一个不相关的问题（比如客户问优惠你却只问"发哪个国家"）。一条消息里多个问题就按逻辑顺序逐一接住、别漏，但先答最关键的，价格放最后。Stage goal 是大方向，但回应客户的实际问题永远优先。
10. 别重复确认已经定下来的事：先读整段对话，凡是前面已经确认过或从语境能明显看出已经定了的信息（款式、尺码、颜色、数量、目的地…），哪怕客户没有逐字回复"对/是的"，也要当成已确认，绝不要再回头重复确认一遍——那样非常重复、非常像机器人。客户往前走了（比如已经在问"怎么付款"），你也要往前走（谈付款/收货信息/推进成交），不要把话题拽回到早就定好的尺码上。每一条新回复都要让对话向前推进，而不是原地打转。

=== Anti-"AI tell" texture (让这句像真人随手打的，而不是模板) ===
- 像真人快速打字那样：短句、可以用语气词/口语（"嗯""哦""那""对了""哈""～""啦"，按客户的语气密度来；客户正式就别用）。别工整对称、别像列清单。
- 绝不用 filler 开场白："当然可以！""没问题哦～""好的呢""Sure thing!""Absolutely!""Of course"——直接说事。
- 绝不用客服式套话："感谢您的咨询""为您服务""请问还有什么需要"。
- 每次开头都换花样，别两条都用同一个词起头；对话已经聊起来了就别再"你好/Hi"。
- 偶尔一个很轻的真人小细节是加分的（"刚发完一批货""仓库这边在盘点"），但绝不要编造具体生活事件。
- 句子可以不完美收尾，留白也行，不必每句都圆满。镜像客户的长度：他一句话你就一句话，别长篇。

Customer's latest message (你这条回复必须直接接住它真正问的): ${lastInboundText || '(无文本)'}

在心里先想 3 个不同的回法，挑出最像真人金牌销售、最自然、最贴合客户这条消息的那一个；只输出那一句，别输出其它候选、别解释。
Output ONLY the single reply line, nothing else.

Recent transcript:
${transcript}${catalogContext}`;

  try {
    const r = await callAzureResponses(cfg, prompt, { maxOutputTokens: 400, retries: 1 });
    if (!r.ok) return null;
    const text = r.text
      .split(/\r?\n/)
      .map((s) =>
        s.replace(/^\s*\d+[.、)]\s*/, '').replace(/^[-*•]\s*/, '').replace(/^["「『]|["」』]$/g, '').trim()
      )
      .find((s) => s.length > 0);
    if (!text || looksLikeRefusal(text)) return null;
    const enforced = await enforceOutputLang(text.slice(0, 200), outputLang);
    return { text: enforced, lang };
  } catch {
    return null;
  }
}

/**
 * inbound handler 调用入口。
 * 不抛异常；所有失败路径都静默吃掉。
 */
export function triggerAutoRespond(conversationId: string): void {
  const canonical = resolveAlias(conversationId);
  // 突发合并（debounce）：客户常在几秒内连发多条（"show me bags" + "lv is perfect"）。
  // 若每条都触发一次 runAutoRespond，就会逐条各回一句近乎一样的承诺，既重复又像机器人。
  // 这里每来一条就重置计时器，只有「最后一条之后静默 BURST_DEBOUNCE_MS」才真正回应一次，
  // 且 runAutoRespond 读取的是最新全部上下文，等于把整串消息当作一个回合统一作答。
  const existing = burstTimers.get(canonical);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    burstTimers.delete(canonical);
    enqueueAutoRespond(canonical);
  }, BURST_DEBOUNCE_MS);
  // 不要因为这个计时器而阻止进程退出（dev/test 友好）
  if (typeof timer.unref === 'function') timer.unref();
  burstTimers.set(canonical, timer);
}

/** 把一次真正的自动响应排进本会话的串行队列，保证同会话回复不并发交叉。 */
function enqueueAutoRespond(canonical: string): void {
  const previous = conversationQueues.get(canonical) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => runAutoRespond(canonical));
  conversationQueues.set(canonical, next);
  void next.finally(() => {
    if (conversationQueues.get(canonical) === next) conversationQueues.delete(canonical);
  });
}

async function runAutoRespond(conversationId: string): Promise<void> {
  try {
    const canonical = resolveAlias(conversationId);
    // eslint-disable-next-line no-console
    console.log('[auto-respond] inbound', { conversationId, canonical });

    // 1. 全局状态：killSwitch / 会话暂停 → 直接跳过
    const state = await getAutopilotState();
    if (state.killSwitch) {
      console.log('[auto-respond] skip: killSwitch on');
      return;
    }
    if (isConversationPaused(state, canonical)) {
      console.log('[auto-respond] skip: conversation paused', canonical);
      return;
    }

    // 2. 找会话拿档位
    const conversations = await listConversations();
    const conv = conversations.find((c) => c.id === canonical);
    const mode = resolveEffectiveMode(conv, state.defaultMode);
    console.log('[auto-respond] mode resolved', { canonical, mode, defaultMode: state.defaultMode, convAutoMode: conv?.autoMode });

    // 只对这三档做自动响应
    if (mode !== 'DRAFT_AUTO' && mode !== 'AUTO_SAFE' && mode !== 'AUTO_FULL') {
      console.log('[auto-respond] skip: mode not auto-tier', mode);
      return;
    }

    // 2.5 阶段状态机 + 槽位抽取：基于最后一条 inbound 消息推进 stage，并把抽到的偏好合并进 slots
    //     这部分对所有 auto-tier 档位都生效，DRAFT_AUTO 也希望 UI chip 能看到推进。
    const recentForStage = await getMessages(canonical, 12);
    const lastInbound = [...recentForStage].reverse().find((m) => m.direction === 'in');
    let nextStage: SalesStage = (conv?.salesStage as SalesStage | undefined) ?? 'S1';
    let mergedSlots: Slots = conv?.slots ?? {};
    if (lastInbound) {
      const prevOutbound = [...recentForStage]
        .reverse()
        .find((m) => m.direction === 'out' && m.timestamp < lastInbound.timestamp);
      const cls = classifyStage({
        lastInbound,
        prevOutbound,
        currentStage: (conv?.salesStage as SalesStage | undefined) ?? 'S1'
      });
      nextStage = cls.stage;
      mergedSlots = extractSlots(lastInbound.text ?? '', conv?.slots);
      console.log('[auto-respond] stage classified', {
        canonical,
        from: conv?.salesStage ?? 'S1',
        to: nextStage,
        reason: cls.reason,
        slots: mergedSlots
      });
      // 落盘：阶段变化 / 槽位变化都写回。失败不阻塞主流程。
      try {
        await patchConversationSalesState(canonical, {
          salesStage: nextStage,
          slots: mergedSlots,
          leadTemperature: cls.suggestedTemperature
        });
      } catch (e) {
        console.error('[auto-respond] patchConversationSalesState failed', e);
      }
    }

    // 2.6 客户发了一张图（type='image' 且带 imageUrls），或客户引用了我们/对方的图片
    //     （type='text' 但带 quoteImageUrl）→ AUTO_FULL 下立即跑「以图搜图」，
    //     找到 catalog 里的同款/相似款主图回过去。找不到则跳过本分支，继续走正常文字回复。
    const imgSrcRaw =
      (lastInbound?.type === 'image' && lastInbound.imageUrls?.[0]) ||
      lastInbound?.quoteImageUrl ||
      undefined;
    // 客户发/引用了图，但 catalog 里没搜到同款（或同款近期已发完）。置位后，
    // 下面的常规文字流程会走「我再找找 + 推荐在售同类款」，而不是冷场或干追问。
    let imageSearchMissed = false;
    if (mode === 'AUTO_FULL' && lastInbound && imgSrcRaw && isPersonalReady()) {
      try {
        const rl = await checkHourlyRateLimit(canonical);
        if (!rl.allow) {
          console.log('[auto-respond] image-search skipped: rate limited', rl);
        } else {
          const raw = imgSrcRaw;
          const searchInput = raw.startsWith('data:image/')
            ? { imageDataUrl: raw }
            : raw.startsWith('http')
              ? { imageUrl: raw }
              : null;
          if (!searchInput) {
            console.log('[auto-respond] image-search skipped: unsupported image src', raw.slice(0, 32));
          } else {
            const searchRes = await searchCatalogByImage({
              ...searchInput,
              hint: lastInbound.text || undefined,
              limit: 4
            });
            if (searchRes.ok && searchRes.result.ids.length > 0) {
              // 先按 24h 去重过滤，再取前 2 款 —— 让「过渡话术承诺的数量」与真正会发的一致，
              // 也避免把刚发过的同款又发一遍。
              const now = Date.now();
              const excludeIds = (conv?.lastSentProductIds ?? [])
                .filter((x) => now - x.ts < 24 * 3600_000)
                .map((x) => x.id);
              const productIds = searchRes.result.ids
                .filter((id) => !excludeIds.includes(id))
                .slice(0, 2);
              const products = (
                await Promise.all(productIds.map((id) => getProduct(id)))
              ).filter((p): p is CatalogProduct => !!p && !!p.mainImage);
              console.log('[auto-respond] image-search hit', {
                canonical,
                description: searchRes.result.description,
                keywords: searchRes.result.keywords,
                matched: searchRes.result.matched,
                excludedCount: excludeIds.length,
                returning: products.map((p) => p.id)
              });
              if (products.length > 0) {
                // 先发一句过渡话术（≤ 15 字，类似真人："看了你的图，给你找了同款"），
                // 数量由实际命中的 products.length 决定，保证"说几款发几款"。
                const intro = await generateOneReply(canonical, conv?.outputLang, {
                  stage: nextStage,
                  slots: mergedSlots,
                  aboutToSendProduct: true,
                  productCount: products.length
                });
                const introText = intro?.text || defaultTransitionLine(conv?.outputLang);
                const introGate = await autopilotGate({
                  conversationId: canonical, source: 'auto-full', conversationMode: mode, text: introText
                });
                if (introGate.allow) {
                  const introSend = await sendPersonalText(canonical, introText);
                  const introPersisted = await appendOutgoing({
                    conversationId: canonical, text: introText, type: 'text',
                    status: introSend.ok ? 'sent' : 'failed',
                    error: introSend.ok ? undefined : introSend.reason,
                    aiAuto: true, aiSource: 'auto-full',
                    aiReason: `AI ${mode} 以图搜图过渡`
                  });
                  await logAiAction({
                    conversationId: canonical, source: 'auto-full', mode,
                    outcome: introSend.ok ? 'sent' : 'blocked',
                    reason: introSend.ok ? '以图搜图过渡话术' : introSend.reason,
                    messageId: introPersisted.id, textPreview: introText
                  });
                }
                // 然后逐张发图（已按 24h 去重预过滤，这里直接发）
                for (let i = 0; i < products.length; i++) {
                  const product = products[i];
                  const captionRecent = await getMessages(canonical, 8);
                  const caption = await generateProductCaption(product, captionRecent, conv?.outputLang);
                  const gate2 = await autopilotGate({
                    conversationId: canonical, source: 'auto-full', conversationMode: mode, text: caption
                  });
                  if (!gate2.allow) continue;
                  if (i > 0) await sleep(800 + Math.floor(Math.random() * 1200));
                  const rlImg = await checkHourlyRateLimit(canonical);
                  if (!rlImg.allow) break;
                  const imgResult = await sendPersonalImage(canonical, product.mainImage, caption);
                  const imgPersisted = await appendOutgoing({
                    conversationId: canonical,
                    imageUrls: [product.mainImage],
                    productId: product.id, productTitle: product.title,
                    text: caption, type: 'image',
                    status: imgResult.ok ? 'sent' : 'failed',
                    error: imgResult.ok ? undefined : imgResult.reason,
                    aiAuto: true, aiSource: 'auto-full',
                    aiReason: `AI ${mode} 以图搜图回款`
                  });
                  if (imgResult.ok) await recordSentProduct(canonical, product.id);
                  await logAiAction({
                    conversationId: canonical, source: 'auto-full', mode,
                    outcome: imgResult.ok ? 'sent' : 'blocked',
                    reason: imgResult.ok ? `image-search ${product.id}` : imgResult.reason,
                    messageId: imgPersisted.id,
                    textPreview: `[${product.title}] ${caption}`
                  });
                  if (!imgResult.ok) break;
                }
                // 客户已经"看图找款"了，状态推到 S4 等反馈
                try {
                  await patchConversationSalesState(canonical, { salesStage: 'S4' });
                } catch {/* ignore */}
                return; // 走完图分支，跳过下面常规文字回复
              } else {
                // 搜到了但都被 24h 去重滤掉 → 没新图可发，走下面「我再找找+推荐同类」
                imageSearchMissed = true;
              }
            } else {
              imageSearchMissed = true;
              console.log('[auto-respond] image-search miss, fall through to text reply', {
                ok: searchRes.ok,
                error: searchRes.ok ? undefined : searchRes.error
              });
            }
          }
        }
      } catch (e) {
        console.error('[auto-respond] image-search error', e);
        // 不 return，让下面的常规文字流程兜底
      }
    }

    await sleep(humanDelayMs());

    // 3. 先决定本轮是否会"答完顺手发图"——决策提到生成 reply 之前。
    //    金牌销售原则：能发图就发图，少追问。客户每给一个偏好/明确再要，都应「拿货给他看」，
    //    而不是又问一个问题。只有真的没东西可发时，才给一句不啰嗦的引导（且不连续追问）。
    let willSendProduct = false;
    let productsToSend: CatalogProduct[] = [];
    let guideContext:
      | { lastTitle?: string; lastBrand?: string; alternatives?: string[]; noQuestion?: boolean }
      | undefined;
    let quoteContext:
      | {
          productTitle?: string;
          productBrand?: string;
          hasQty?: boolean;
          hasRegion?: boolean;
          multiQuestion?: boolean;
          gatherFirst?: string[];
        }
      | undefined;
    // 成交/付款承接（S7）：客户进入下单/付款环节。收款/PI 永远走人工，AI 只接住 + 告知可用收款方式名称。
    // paid=客户已表示付款完成 → 触发「发货前订单复核」；methodLabels=配置里可提及的方式名称（不含账号）。
    let paymentContext:
      | { methodLabels?: string[]; paid?: boolean }
      | undefined;
    if (mode === 'AUTO_FULL') {
      const recentForDecide = await getMessages(canonical, 12);
      const slotCount = Object.values(mergedSlots).filter(Boolean).length;
      const lastAiOuts = recentForDecide.filter((m) => m.direction === 'out' && m.aiAuto).slice(-4);
      const aiTextRoundsWithoutImg = lastAiOuts.filter((m) => m.type !== 'image').length;
      // 价格意图（S5）：客户问的是钱，绝不能再塞商品图（截图里"多少钱"被误判成要看货）。
      // 进入「双重确认 + 收数量/目的地 + 快速人工核价」的报价承接，而不是又发一个包。
      const priceIntent = nextStage === 'S5';
      // 报价/异议/成交阶段（S5/S6/S7）：客户已经在谈钱/付款/下单，绝不能再自动塞商品图刷屏。
      // 否则会出现「客户都付款了，AI 又自动发两款鞋」这种逻辑不通的情况。
      const lateFunnel = nextStage === 'S5' || nextStage === 'S6' || nextStage === 'S7';
      const explicitAsk = !lateFunnel && isExplicitProductRequest(lastInbound?.text ?? '');
      // 客户发图没搜到同款，也按「明确要看货」处理：优先送同类相似款，没有再引导。
      const wantsProduct = !lateFunnel && (explicitAsk || imageSearchMissed);
      // 上一条 AI 自动文字是不是已经在「问问题」了 —— 用来杜绝连续两条都在追问（客户最烦这个）。
      const lastAiText = [...recentForDecide]
        .reverse()
        .find((m) => m.direction === 'out' && m.aiAuto && !!m.text && m.type !== 'image');
      const lastAiWasQuestion = looksLikeQuestion(lastAiText?.text ?? '');

      willSendProduct =
        !lateFunnel &&
        (wantsProduct ||
          (nextStage === 'S3' || nextStage === 'S4') ||
          (nextStage === 'S2' && slotCount >= 1) ||
          (slotCount >= 1 && aiTextRoundsWithoutImg >= 2));

      // 关键：在生成「承诺话术」之前，先把这一轮真正要发的商品定下来，承诺数量与实发严格一致。
      // 客户点名再要某款（refine）时一次只发 1 款更像真人导购、也不刷屏；
      // 首次主动推介（S3）或图搜未中转推同类时，可一次发 2 款。
      if (willSendProduct && isPersonalReady()) {
        const refine = explicitAsk && !imageSearchMissed;
        const sendLimit = refine ? 1 : 2;
        productsToSend = await selectProductsToSend({
          conv, recent: recentForDecide, slots: mergedSlots, limit: sendLimit, explicitAsk: wantsProduct
        });
        if (productsToSend.length === 0) willSendProduct = false;
      } else {
        willSendProduct = false;
      }

      // 真的没货可发，但客户还在看货：给一句「我再找找 + 推荐在售的具体款」的引导，
      // 引用之前发过的那款，并列出我们确实有的同类款，而不是空承诺或连环追问。
      if (!willSendProduct && wantsProduct) {
        const lastSent = [...(conv?.lastSentProductIds ?? [])].sort((a, b) => b.ts - a.ts)[0];
        const refProduct = lastSent ? await getProduct(lastSent.id) : undefined;
        const alternatives = await gatherAlternatives(conv, refProduct ?? undefined, 3);
        guideContext = {
          lastTitle: refProduct?.title,
          lastBrand:
            refProduct?.brand && refProduct.brand !== '品牌待确认' ? refProduct.brand : undefined,
          alternatives: alternatives.length ? alternatives : undefined,
          // 上一条已经在追问 → 这一条绝不再问，改成直接给选择/推荐
          noQuestion: lastAiWasQuestion
        };
      }

      // 报价承接（S5）：双重确认是哪款 + 收齐核价必需信息（数量、目的地国家）。
      // 不自动报具体数字（catalog 多为成本价且缺重量，正式价走人工核），但要快、要锚定、不空承诺。
      if (priceIntent) {
        const lastSent = [...(conv?.lastSentProductIds ?? [])].sort((a, b) => b.ts - a.ts)[0];
        const refProduct = lastSent ? await getProduct(lastSent.id) : undefined;
        const convoText = recentForDecide
          .filter((m) => m.direction === 'in')
          .map((m) => m.text || '')
          .join(' ');
        const hasQty = /(\d+\s*(个|只|件|pcs?|pieces?|台|箱)|一个|一只|两个|几个|起订|moq|qty)/i.test(
          convoText
        );
        const hasRegion = !!detectRegionFromText(convoText);
        const lastInbound = [...recentForDecide].reverse().find((m) => m.direction === 'in' && !!m.text)?.text || '';
        const gatherFirst = filterConfirmedQuotePrereqs(
          missingQuotePrereqs(mergedSlots.category, convoText, mergedSlots),
          recentForDecide
        );
        quoteContext = {
          productTitle: refProduct?.title,
          productBrand:
            refProduct?.brand && refProduct.brand !== '品牌待确认' ? refProduct.brand : undefined,
          hasQty,
          hasRegion,
          multiQuestion: isMultiQuestion(lastInbound),
          gatherFirst: gatherFirst.length ? gatherFirst : undefined
        };
      }

      // 成交/付款承接（S7）：客户问怎么付款 / 已付款。收款账号与 PI 永远走人工。
      // AI 只做两件事之一：① 客户问付款 → 接住 + 告知可用收款方式名称（不发账号）；
      // ② 客户已付款 → 自动发一条订单复核（款式/尺码/数量/收货地址）让客户确认，再交人工安排发货。
      if (nextStage === 'S7') {
        const convoText = recentForDecide
          .filter((m) => m.direction === 'in')
          .map((m) => m.text || '')
          .join(' ');
        const paid =
          /已?(付款|付了|付清|付好|打款|打钱|转账|转好|汇款|汇好|下单了)|paid|payment\s*(done|sent|made|complete)|(have|just)\s*paid|transferred|sent\s*(you\s*)?(the\s*)?(money|payment)/i.test(
            convoText
          );
        let methodLabels: string[] = [];
        try {
          methodLabels = await listPaymentMethodLabelsForAi();
        } catch (e) {
          console.error('[auto-respond] load payment methods failed', e);
        }
        paymentContext = {
          methodLabels: methodLabels.length ? methodLabels : undefined,
          paid
        };
      }
      console.log('[auto-respond] willSendProduct decided', {
        canonical, nextStage, slotCount, aiTextRoundsWithoutImg, explicitAsk, imageSearchMissed,
        priceIntent, lastAiWasQuestion, willSendProduct, productCount: productsToSend.length,
        guide: !!guideContext, quote: !!quoteContext, payment: !!paymentContext
      });
    }

    // 4. 生成一条回复（注入 stage + slots + aboutToSendProduct + 实际发图数量让 prompt 收紧）
    const reply = await generateOneReply(canonical, conv?.outputLang, {
      stage: nextStage,
      slots: mergedSlots,
      aboutToSendProduct: willSendProduct,
      productCount: willSendProduct ? productsToSend.length : undefined,
      guide: guideContext,
      quote: quoteContext,
      payment: paymentContext
    });
    if (!reply) {
      console.log('[auto-respond] skip: no reply generated (Azure 未配置 / 返回空 / 报错)');
      return;
    }
    console.log('[auto-respond] generated reply', { canonical, mode, preview: reply.text.slice(0, 40) });

    // 5. 分档落地
    if (mode === 'DRAFT_AUTO') {
      await setConversationDraft(canonical, {
        text: reply.text,
        lang: reply.lang,
        createdAt: Date.now()
      });
      await logAiAction({
        conversationId: canonical,
        source: 'auto-safe', // 占位：DRAFT_AUTO 没单独 source，记 audit 时按"非人工触发"归类
        mode,
        outcome: 'drafted',
        textPreview: reply.text
      });
      return;
    }

    // 5.1 防重复承诺（突发合并兜底）：若本条与最近一条 AI 自动文字几乎相同，且本轮并不会
    //     真的发图，那它就是一句重复的空承诺——直接跳过，不刷屏。若本轮确实会发图，则照常
    //     （后面紧跟的商品图让这句过渡话不再冗余）。
    if (!willSendProduct) {
      const lastAiText = [...recentForStage]
        .reverse()
        .find((m) => m.direction === 'out' && m.aiAuto && !!m.text && m.type !== 'image');
      if (
        lastAiText &&
        normalizeForCompare(lastAiText.text ?? '') === normalizeForCompare(reply.text)
      ) {
        console.log('[auto-respond] skip: near-duplicate of last AI auto text');
        await logAiAction({
          conversationId: canonical,
          source: mode === 'AUTO_SAFE' ? 'auto-safe' : 'auto-full',
          mode,
          outcome: 'blocked',
          reason: '跳过重复文字（与上一条 AI 自动消息几乎相同，且本轮无新图可发）',
          textPreview: reply.text
        });
        return;
      }
    }

    // AUTO_SAFE / AUTO_FULL：走 gate → 实际发送
    const source = mode === 'AUTO_SAFE' ? 'auto-safe' : 'auto-full';
    const gate = await autopilotGate({
      conversationId: canonical,
      source,
      conversationMode: mode,
      text: reply.text
    });
    if (!gate.allow) {
      // 命中风险词 → 写一条草稿让员工接手，比起干掉静默更友好
      if (gate.downgrade === 'NEEDS_HUMAN') {
        await setConversationDraft(canonical, {
          text: reply.text,
          lang: reply.lang,
          createdAt: Date.now()
        });
      }
      await logAiAction({
        conversationId: canonical,
        source,
        mode,
        outcome: gate.downgrade === 'NEEDS_HUMAN' ? 'downgraded' : 'blocked',
        reason: gate.reason,
        risks: detectRisks(reply.text),
        textPreview: reply.text
      });
      return;
    }

    // 真发：当前只支持 personal mode（cloud 模式服务端没存 token）
    if (!isPersonalReady()) {
      await logAiAction({
        conversationId: canonical,
        source,
        mode,
        outcome: 'blocked',
        reason: 'personal client 未就绪，自动发送跳过',
        textPreview: reply.text
      });
      return;
    }
    // 节奏限速：本会话过去 1 小时已发 ≥ N 条，直接跳过（不写草稿，下条消息进来再判一次）
    {
      const rl = await checkHourlyRateLimit(canonical);
      if (!rl.allow) {
        await logAiAction({
          conversationId: canonical,
          source,
          mode,
          outcome: 'blocked',
          reason: `节奏限速：过去 1 小时已自动发送 ${rl.sent}/${rl.limit} 条，跳过本次`,
          textPreview: reply.text
        });
        return;
      }
    }
    const sendResult = await sendPersonalText(canonical, reply.text);
    const persisted = await appendOutgoing({
      conversationId: canonical,
      text: reply.text,
      type: 'text',
      status: sendResult.ok ? 'sent' : 'failed',
      error: sendResult.ok ? undefined : sendResult.reason,
      aiAuto: true,
      aiSource: source,
      aiReason: `AI ${mode} 自动回复`
    });
    await logAiAction({
      conversationId: canonical,
      source,
      mode,
      outcome: sendResult.ok ? 'sent' : 'blocked',
      reason: sendResult.ok ? undefined : sendResult.reason,
      messageId: persisted.id,
      textPreview: reply.text
    });

    // 报价承接（S5）落地后：自动暂停本会话 AI + 亮灯通知人工接手出价。
    // 决策依据：catalog 多为成本价且缺重量，AI 无法可靠自动报价；报价不可逆、且奢侈品 B2B
    // 客户在价格环节本就期待真人。AI 负责"秒接住 + 收齐数量/目的地 + 承诺很快给最优价"
    // 防止客户因等待流失；真实数字/PI 由人工核发。
    // 一旦客户进入报价环节就亮灯给人工：即便颜色/尺码还没齐，员工也应该看到这条潜在订单，
    // AI 本轮只负责接住和补问，正式价格/PI 仍由人工核发。
    if (mode === 'AUTO_FULL' && sendResult.ok && quoteContext) {
      try {
        // 自动匹配报价策略：按地区/品牌/数量挑最贴合的一套，告诉人工"建议用哪套策略报价"。
        let strategyHint = '';
        try {
          const inboundText = (await getMessages(canonical, 12))
            .filter((m) => m.direction === 'in')
            .map((m) => m.text || '')
            .join(' ');
          const qtyMatch = inboundText.match(/(\d{1,5})\s*(个|只|件|pcs?|pieces?|台|箱)/i);
          const book = await loadStrategyBook();
          const match = selectStrategy(book, {
            region: detectRegionFromText(inboundText) || undefined,
            brand: quoteContext.productBrand,
            qty: qtyMatch ? Number(qtyMatch[1]) : undefined
          });
          strategyHint = match.isFallback
            ? `（建议策略：${match.strategy.name}·默认）`
            : `（建议策略：${match.strategy.name}｜${match.matchedOn.join('·')}）`;
        } catch (e) {
          console.error('[auto-respond] selectStrategy failed', e);
        }
        await pauseConversationAutopilot(canonical, S5_HANDOFF_PAUSE_MS);
        await patchConversationSalesState(canonical, {
          leadTemperature: 'hot',
          needsHuman: true,
          needsHumanReason: quoteContext.gatherFirst?.length
            ? `S5 报价：客户已问价，待确认${quoteContext.gatherFirst.join('、')}后人工核价/出 PI ${strategyHint}`.trim()
            : `S5 报价：需人工核价/出 PI ${strategyHint}`.trim()
        });
        await logAiAction({
          conversationId: canonical,
          source,
          mode,
          outcome: 'downgraded',
          reason: `进入报价(S5)：AI 已接住并收集核价信息，已暂停自动发送 ${Math.round(
            S5_HANDOFF_PAUSE_MS / 60000
          )} 分钟，等待人工核价出 PI ${strategyHint}`.trim(),
          textPreview: reply.text
        });
        console.log('[auto-respond] S5 handoff: paused + needsHuman', { canonical, strategyHint });
      } catch (e) {
        console.error('[auto-respond] S5 handoff failed', e);
      }
    }

    // 物流/发货也必须亮灯：运费、交期、承运商、跟踪号都依赖真实订单/线路数据，AI 只能接住，不能承诺。
    if (mode === 'AUTO_FULL' && sendResult.ok && nextStage === 'S6') {
      try {
        await pauseConversationAutopilot(canonical, S5_HANDOFF_PAUSE_MS);
        await patchConversationSalesState(canonical, {
          leadTemperature: 'hot',
          needsHuman: true,
          needsHumanReason: 'S6 物流/发货：需人工核实运费、交期、承运商或跟踪号'
        });
        await logAiAction({
          conversationId: canonical,
          source,
          mode,
          outcome: 'downgraded',
          reason: `进入物流/发货(S6)：已暂停自动发送 ${Math.round(
            S5_HANDOFF_PAUSE_MS / 60000
          )} 分钟，等待人工核实物流信息`,
          textPreview: reply.text
        });
        console.log('[auto-respond] S6 handoff: paused + needsHuman', { canonical });
      } catch (e) {
        console.error('[auto-respond] S6 handoff failed', e);
      }
    }

    // 成交/付款承接（S7）落地后：和报价一样自动暂停 AI + 左侧亮灯通知人工。
    // 收款账号/PI/发货都不可逆且涉及钱，必须人工亲自处理：
    //   - 客户问付款 → AI 已告知方式名称，账号由人工核对后发；
    //   - 客户已付款 → AI 已发订单复核，人工核对后安排发货。
    if (mode === 'AUTO_FULL' && sendResult.ok && paymentContext) {
      try {
        const reason = paymentContext.paid
          ? '已付款待发货：请核对订单复核信息后安排发货'
          : `付款环节：需人工核对收款方式/发送账号、出 PI${
              paymentContext.methodLabels?.length ? `（可用方式：${paymentContext.methodLabels.join('/')}）` : ''
            }`;
        await pauseConversationAutopilot(canonical, S5_HANDOFF_PAUSE_MS);
        await patchConversationSalesState(canonical, {
          leadTemperature: 'hot',
          needsHuman: true,
          needsHumanReason: reason
        });
        await logAiAction({
          conversationId: canonical,
          source,
          mode,
          outcome: 'downgraded',
          reason: `进入成交(S7)：${
            paymentContext.paid ? 'AI 已发订单复核' : 'AI 已接住并告知收款方式'
          }，已暂停自动发送 ${Math.round(S5_HANDOFF_PAUSE_MS / 60000)} 分钟，等待人工处理收款/发货`,
          textPreview: reply.text
        });
        console.log('[auto-respond] S7 handoff: paused + needsHuman', {
          canonical,
          paid: paymentContext.paid
        });
      } catch (e) {
        console.error('[auto-respond] S7 handoff failed', e);
      }
    }

    // AUTO_FULL 额外能力：先前 willSendProduct=true 已经决定本轮要发图，且 productsToSend
    // 已在生成承诺话术前定好（数量与承诺一致）。文字成功落地后立即把这些主图发出。
    if (mode === 'AUTO_FULL' && sendResult.ok && willSendProduct && productsToSend.length > 0) {
      try {
        const recent = await getMessages(canonical, 12);
        const promise = replyIsProductPromise(reply.text);
        const triggerReason = promise
          ? '承诺即发'
          : nextStage === 'S3'
            ? 'S3 自动发商品'
            : nextStage === 'S4'
              ? 'S4 反馈再推'
              : '偏好已明确-提前发图';
        const { sent } = await autoSendProducts({
          canonical, mode, source, conv, recent, slots: mergedSlots,
          limit: 2, reason: triggerReason, preselected: productsToSend
        });
        if (sent > 0) {
          try {
            await patchConversationSalesState(canonical, { salesStage: 'S4' });
          } catch (e) {
            console.error('[auto-respond] advance to S4 failed', e);
          }
        }
      } catch (e) {
        console.error('[auto-respond] auto-send-product error', e);
      }
    }
  } catch (e) {
    // 绝不让这里的异常炸到 inbound handler
    // eslint-disable-next-line no-console
    console.error('[auto-respond] unexpected error', e);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 投石问路 followup sweep
// ────────────────────────────────────────────────────────────────────────────
// AI 已经主动提了问题或承诺要发图，但客户隔了很久没回。像真人销售一样：
// 不要干等，过一段时间主动甩一款相关商品图过去，激活会话。
// - 仅 AUTO_FULL；不发文字，只发 1 张商品主图（caption 由 LLM 写）
// - 同一条 outbound 只追打一次（lastNudgedOutboundId 去重）
// - 跟随节奏限速 + 24h 商品去重
// - 等待时长由 AI_FOLLOWUP_DELAY_MIN 控制，默认 15 分钟
// - 扫描间隔由 AI_FOLLOWUP_SWEEP_SEC 控制，默认 60 秒
const FOLLOWUP_DELAY_MS = (() => {
  const v = Number(process.env.AI_FOLLOWUP_DELAY_MIN);
  return (Number.isFinite(v) && v > 0 ? Math.floor(v) : 15) * 60_000;
})();
const FOLLOWUP_SWEEP_MS = (() => {
  const v = Number(process.env.AI_FOLLOWUP_SWEEP_SEC);
  return (Number.isFinite(v) && v > 0 ? Math.floor(v) : 60) * 1000;
})();

async function followupOneConversation(conv: WaConversation, state: Awaited<ReturnType<typeof getAutopilotState>>): Promise<void> {
  const canonical = conv.id;
  const mode = resolveEffectiveMode(conv, state.defaultMode);
  if (mode !== 'AUTO_FULL') return;
  if (isConversationPaused(state, canonical)) return;
  const recent = await getMessages(canonical, 8);
  if (recent.length === 0) return;
  const last = recent[recent.length - 1];
  // 最后一条必须是 AI 自动发出的（员工亲自发的不投石问路），且客户没回
  if (last.direction !== 'out' || !last.aiAuto) return;
  const elapsed = Date.now() - (last.timestamp ?? 0);
  if (elapsed < FOLLOWUP_DELAY_MS) return;
  if (conv.lastNudgedOutboundId === last.id) return;
  // 太老的会话别再追（超过 7 天没回基本是冷线）
  if (elapsed > 7 * 24 * 3600_000) return;
  // 阶段：只在 S2/S3/S4 nudge（破冰 S1 太早；S5/S6/S7 牵涉报价物流别瞎插图）
  const stage = (conv.salesStage as SalesStage | undefined) ?? 'S1';
  if (stage !== 'S2' && stage !== 'S3' && stage !== 'S4') return;
  if (!isPersonalReady()) return;
  const rl = await checkHourlyRateLimit(canonical);
  if (!rl.allow) return;
  const slots: Slots = conv.slots ?? {};
  console.log('[auto-respond] followup sweep trigger', { canonical, stage, elapsedMin: Math.round(elapsed / 60000), slots });
  const { sent } = await autoSendProducts({
    canonical, mode: 'AUTO_FULL', source: 'auto-full', conv, recent, slots,
    limit: 1, reason: `投石问路（${Math.round(elapsed / 60000)}m 无回复）`
  });
  // 不管 sent 是否 > 0 都标记，避免无图商品在每轮扫描里反复打 log
  await markConversationNudged(canonical, last.id);
  if (sent > 0) {
    try {
      // followup 后保持 S4，让客户的下条消息走"反馈"分支
      await patchConversationSalesState(canonical, { salesStage: 'S4' });
    } catch (e) {
      console.error('[auto-respond] followup advance S4 failed', e);
    }
  }
}

async function runFollowupSweep(): Promise<void> {
  try {
    const state = await getAutopilotState();
    if (state.killSwitch) return;
    const convs = await listConversations();
    for (const conv of convs) {
      try {
        await followupOneConversation(conv, state);
      } catch (e) {
        console.error('[auto-respond] followup error', conv.id, e);
      }
    }
  } catch (e) {
    console.error('[auto-respond] followup sweep error', e);
  }
}

// 模块级 setInterval；用 globalThis 兜底 HMR / 多次 import 防止重复
const __g = globalThis as unknown as { __aiFollowupTimer?: NodeJS.Timeout };
if (!__g.__aiFollowupTimer && process.env.NODE_ENV !== 'test') {
  __g.__aiFollowupTimer = setInterval(() => {
    void runFollowupSweep();
  }, FOLLOWUP_SWEEP_MS);
  // Node 进程退出时不要因为这个 timer 一直挂着
  __g.__aiFollowupTimer.unref?.();
  console.log('[auto-respond] followup sweep started', { delayMin: FOLLOWUP_DELAY_MS / 60000, sweepSec: FOLLOWUP_SWEEP_MS / 1000 });
}
