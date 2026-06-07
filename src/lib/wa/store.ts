import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveAlias, addAlias, warmAliases } from './alias-map';

export type WaMessage = {
  id: string;
  conversationId: string; // 对端 wa_id（E.164 无 +）
  direction: 'in' | 'out';
  type: 'text' | 'image' | 'video';
  text?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  productTitle?: string;
  productId?: string;
  quoteText?: string;
  /**
   * 引用消息若是图片/贴纸，这里存一份 data URL 缩略图，便于 UI 直接渲染。
   * 同时也让「以图搜图」可以在客户引用我方商品图后继续匹配同款。
   */
  quoteImageUrl?: string;
  /**
   * 被「引用」的原消息 id（与 WhatsApp 底层的 quoted reply 对齐）。
   * - 本地入库的入站消息 id 格式为 `wweb_<msg.id._serialized>`；
   *   发送时 personal-client 会去掉 `wweb_` 前缀再传给 whatsapp-web.js。
   * - UI 仅需存文本快照（quoteText）。该字段主要为了（a）让对方 WA 看到「引用〔某条消息〕」的原生样式，
   *   （b）后续有需要可以点引用跳转到源消息。
   */
  quotedMessageId?: string;
  /**
   * WhatsApp 实际上返回的消息 id（`_serialized`）。
   * 对 outbound 以及从 WA 同步进来的 inbound 都会填上，便于后续「点表情 / 转发」时
   * 能通过 client.getMessageById 拿到原 Message 发起 reaction。
   */
  waMessageId?: string;
  /** 表情 reaction：同一个 from 只保留最后一个 emoji（与 WA 一致）。 */
  reactions?: Array<{ emoji: string; from: 'me' | 'them'; ts: number; senderId?: string }>;
  timestamp: number;
  /** 发送状态：sending=重试中 / sent=已发 / delivered=达 / read=已读 / failed=失败 */
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
  /**
   * 该条消息是否由 AI 自动发出（或员工通过 AI 建议条「⚡」直发）。
   * 客户端看到的依然是普通 WhatsApp 消息；这里仅做内部审计与 UI 区分。
   */
  aiAuto?: boolean;
  /** AI 来源：human / suggest-click / auto-safe / auto-full（与 lib/ai/autopilot.ts 对齐） */
  aiSource?: 'human' | 'suggest-click' | 'auto-safe' | 'auto-full';
  /** AI 触发的策略 / 原因，便于员工事后复盘 */
  aiReason?: string;
};

export type WaConversation = {
  id: string; // == wa_id
  name?: string;
  lastMessage?: string;
  lastTimestamp?: number;
  unread: number;
  /** 置顶：销售端常用，置顶会话总是排在列表顶部 */
  pinned?: boolean;
  /**
   * 该会话的「发出语言锁」：一旦设定，后续发送的纯文本会被自动翻译成该语言
   * 再投递到 WhatsApp。空 / 未设 = 不强制语言。
   * 见 src/lib/i18n/languages.ts 的 LangCode（字符串保存，避免与前端耦合）。
   */
  outputLang?: string;
  /**
   * 该会话的 AI 自动化档位（与 lib/ai/autopilot.ts 的 AutoMode 对齐，字符串保存避免循环依赖）。
   * 不设 = 跟随全局 defaultMode。可选值：OFF / SUGGEST / DRAFT_AUTO / AUTO_SAFE / AUTO_FULL。
   */
  autoMode?: string;
  /**
   * 服务端生成的 AI 草稿（DRAFT_AUTO 模式专用）。
   * 由 inbound handler 触发 `triggerAutoRespond` 时写入；前端轮询拿到后填进输入框，
   * 然后调用 DELETE /api/wa/conversations/{id}/draft 清空，避免重复填充。
   */
  aiDraft?: {
    text: string;
    lang?: string;
    createdAt: number;
    /** 该草稿是基于哪条 inbound 消息生成的；前端用 messageId 判断是否已应用过 */
    basedOnMessageId?: string;
  };
  /**
   * 销售漏斗阶段（autopilot 状态机；与 lib/ai/sales-stage.ts 的 SalesStage 对齐）。
   *   S1 破冰 / S2 探询 / S3 推介 / S4 反馈 / S5 报价 / S6 物流 / S7 成交
   * 未设默认 S1。
   */
  salesStage?: 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7';
  /** 阶段最近一次变更时间戳（ms） */
  salesStageAt?: number;
  /**
   * 偏好槽位（slot filling）。AI 在 S2 阶段从客户消息里抽取，员工可手动改。
   * 这些字段会被注入到 S3 选品 / S4 切换 / S5 报价的 prompt 里。
   */
  slots?: {
    category?: string;
    occasion?: string;
    colorPref?: string;
    priceBand?: string;
    audience?: string;
  };
  /**
   * 客户温度（按是否问过价/物流/数量判定，由 sales-stage 在阶段切换时更新）。
   * cold = 仅闲聊；warm = 看过商品；hot = 问过价/物流/明确意向。
   */
  leadTemperature?: 'cold' | 'warm' | 'hot';
  /**
   * 最近 N 天内自动发过的商品 id + 时间戳，用于 24h 内同款去重，防止 AI 反复推同一款。
   * 超过 72h 的项可在写入时顺手清理。
   */
  lastSentProductIds?: Array<{ id: string; ts: number }>;
  /**
   * 「投石问路」追打去重：上一次因为"客户长时间没回复"而触发的 followup 是基于哪条出站消息的 id。
   * 同一条出站消息不会被反复 nudge。
   */
  lastNudgedOutboundId?: string;
  /**
   * 待人工介入标记：进入报价(S5)等关键环节时由 AI 置位，后台"亮灯"提醒销售接手出价/PI。
   * 销售手动回复（非 AI 自动）后自动清除。
   */
  needsHuman?: boolean;
  /** 待人工原因，如 "S5 报价：需人工核价/出 PI"。 */
  needsHumanReason?: string;
  /** 置位时间戳（ms），用于列表排序/超时提醒。 */
  needsHumanAt?: number;
};

type Store = {
  conversations: Record<string, WaConversation>;
  messages: WaMessage[];
};

/**
 * 同一条出站消息常被写两份：本地发送时的 `out_*`（appendOutgoing）和重连后历史回灌
 * 算出的 `wweb_*`（upsertHistoricalMessage）。当二者都带相同 waMessageId 时已有按
 * waMessageId 折叠的兜底；但「未连接 WhatsApp、仅本地保存」发出的消息两份都没有
 * waMessageId，按 id 无法配对，刷新后就会重复显示。
 *
 * 这里按「方向=out + 类型 + 文本/商品/首图」且时间相近做模糊配对，且仅当一份是本地
 * `out_*`、另一份是回灌 `wweb_*` 时才折叠（避免误伤用户真的连发两条相同短文本）。
 */
const FUZZY_DEDUPE_WINDOW_MS = 15_000;

function outgoingFuzzyKey(m: WaMessage): string | null {
  if (m.direction !== 'out') return null;
  const body = m.text ?? m.productId ?? m.imageUrls?.[0] ?? m.videoUrls?.[0];
  if (!body) return null;
  return `${m.type}|${body}`;
}

function isLocalOutId(id: string): boolean {
  return id.startsWith('out_');
}

/**
 * 判断 `candidate` 是否与 `existing` 是「同一条出站消息的另一份拷贝」：
 * 同会话、同模糊键、时间在窗口内，且二者一份本地 / 一份回灌。
 */
function isOutgoingEcho(existing: WaMessage, candidate: WaMessage): boolean {
  if (existing.conversationId !== candidate.conversationId) return false;
  const key = outgoingFuzzyKey(candidate);
  if (!key || key !== outgoingFuzzyKey(existing)) return false;
  if (Math.abs((candidate.timestamp ?? 0) - (existing.timestamp ?? 0)) > FUZZY_DEDUPE_WINDOW_MS) {
    return false;
  }
  // 仅在一份本地 out_*、另一份回灌 wweb_* 时折叠
  return isLocalOutId(existing.id) !== isLocalOutId(candidate.id);
}

/**
 * 折叠 out_* / wweb_* 出站重复，保留本地 `out_*` 那份（UI 已引用其 id，避免重试链 / key 抖动）。
 * 采用 1:1 贪心配对：每条 `out_*` 只吸收一条 `wweb_*` 回声，避免同一文本反复出现时
 * 误折叠多条真实消息。不改变其余消息相对顺序。
 */
function collapseOutgoingEchoes(messages: WaMessage[]): WaMessage[] {
  const result: WaMessage[] = [];
  // 复合键（会话 + 模糊键）-> result 中同键消息的 { 下标, 是否已被配对消费 }
  const buckets = new Map<string, Array<{ idx: number; consumed: boolean }>>();
  for (const m of messages) {
    const key = outgoingFuzzyKey(m);
    if (!key) {
      result.push(m);
      continue;
    }
    const compositeKey = `${m.conversationId}\u0000${key}`;
    let bucket = buckets.get(compositeKey);
    if (!bucket) {
      bucket = [];
      buckets.set(compositeKey, bucket);
    }
    let matched = false;
    for (const slot of bucket) {
      if (slot.consumed) continue;
      const kept = result[slot.idx]!;
      if (isOutgoingEcho(kept, m)) {
        slot.consumed = true;
        // 命中回声：保留本地 out_* 那份；若已保留的是 wweb_*，用当前本地份替换它。
        if (isLocalOutId(m.id) && !isLocalOutId(kept.id)) {
          result[slot.idx] = m;
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;
    result.push(m);
    bucket.push({ idx: result.length - 1, consumed: false });
  }
  return result;
}

function normalizeByAliases(store: Store): Store {
  const conversations: Record<string, WaConversation> = {};
  const messages = collapseOutgoingEchoes(
    store.messages.map((m) => ({
      ...m,
      conversationId: resolveAlias(m.conversationId)
    }))
  );

  for (const [id, c] of Object.entries(store.conversations)) {
    const canonicalId = resolveAlias(id);
    const prev = conversations[canonicalId];
    if (!prev) {
      conversations[canonicalId] = { ...c, id: canonicalId };
      continue;
    }
    prev.unread = (prev.unread ?? 0) + (c.unread ?? 0);
    if ((c.lastTimestamp ?? 0) > (prev.lastTimestamp ?? 0)) {
      prev.lastTimestamp = c.lastTimestamp;
      prev.lastMessage = c.lastMessage;
    }
    if (!prev.name && c.name) prev.name = c.name;
  }

  // 防止没有 conversations 条目的历史消息被“隐藏”。
  for (const m of messages) {
    if (!conversations[m.conversationId]) {
      conversations[m.conversationId] = {
        id: m.conversationId,
        unread: 0,
        lastTimestamp: m.timestamp,
        lastMessage: m.text ?? (m.imageUrls?.length ? '[图片]' : '')
      };
      continue;
    }
    const c = conversations[m.conversationId]!;
    if ((m.timestamp ?? 0) > (c.lastTimestamp ?? 0)) {
      c.lastTimestamp = m.timestamp;
      c.lastMessage = m.text ?? (m.imageUrls?.length ? '[图片]' : '');
    }
  }

  return { conversations, messages };
}

const FILE_BASENAME = 'wa-messages.json';
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;

/**
 * 文件路径走「当前激活 profile」：default profile 仍是 data/wa-messages.json（零迁移），
 * 其他 profile 落在 data/profiles/<id>/wa-messages.json。详见 src/lib/wa/profiles.ts。
 */
import { getProfileDataDir } from './profiles';
function filePath(): string {
  return path.join(getProfileDataDir(), FILE_BASENAME);
}
function lockPath(): string {
  return `${filePath()}.lock`;
}

let writeQueue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(): Promise<() => Promise<void>> {
  const dir = getProfileDataDir();
  await fs.mkdir(dir, { recursive: true });
  const LOCK_DIR = lockPath();
  for (;;) {
    try {
      await fs.mkdir(LOCK_DIR);
      return async () => {
        await fs.rm(LOCK_DIR, { recursive: true, force: true });
      };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      try {
        const stat = await fs.stat(LOCK_DIR);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch (statError: unknown) {
        if ((statError as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw statError;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function backupCorruptRaw(raw: string): Promise<string> {
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 12);
  const bak = `${filePath()}.corrupt-${hash}.bak`;
  try {
    await fs.writeFile(bak, raw, { encoding: 'utf8', flag: 'wx' });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
  }
  return bak;
}

async function ensureFile(): Promise<Store> {
  await warmAliases();
  const FILE = filePath();
  let raw: string;
  try {
    raw = await fs.readFile(FILE, 'utf8');
  } catch (e: unknown) {
    // 仅当真的"没有这个文件"时，才把空 store 当真相返回。
    // 其它 IO 错误（权限 / 暂时性 EBUSY 等）必须抛出，否则随后的 writeStore 会
    // 把空对象写回，瞬间把所有联系人/消息清空。
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { conversations: {}, messages: [] };
    }
    throw e;
  }
  try {
    return normalizeByAliases(JSON.parse(raw) as Store);
  } catch (e) {
    // 文件存在但解析失败：极端情况（半截写入、人工编辑出错）。
    // 备份一份带时间戳的副本，再抛出 —— 绝不允许把空覆盖回去。
    let bak = `${FILE}.corrupt-unknown.bak`;
    try {
      bak = await backupCorruptRaw(raw);
    } catch {
      /* ignore backup failure */
    }
    throw new Error(
      `wa-messages.json parse failed, backed up to ${bak}. Refusing to overwrite with empty store. Original: ${(e as Error).message}`
    );
  }
}

async function writeStore(store: Store): Promise<void> {
  const dir = getProfileDataDir();
  await fs.mkdir(dir, { recursive: true });
  const FILE = filePath();
  // 每次使用唯一 tmp 文件，避免多进程共享同一路径时互相覆盖 / 拼接。
  const tmp = `${FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tmp, FILE);
}

function enqueue<T>(fn: (store: Store) => Promise<T> | T): Promise<T> {
  const next = writeQueue.then(async () => {
    const release = await acquireFileLock();
    try {
      const store = await ensureFile();
      const result = await fn(store);
      await writeStore(store);
      return result;
    } finally {
      await release();
    }
  });
  writeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function ensureConv(store: Store, id: string, name?: string): WaConversation {
  let c = store.conversations[id];
  if (!c) {
    c = { id, name, unread: 0 };
    store.conversations[id] = c;
  } else if (name && !c.name) {
    c.name = name;
  }
  return c;
}

export async function listConversations(): Promise<WaConversation[]> {
  const store = await ensureFile();
  // 待人工（如 S5 报价）置顶最高优先，其次手动置顶；同类内部按 lastTimestamp 倒序。
  return Object.values(store.conversations)
    .filter((c) => !isSystemAccountId(c.id))
    .sort((a, b) => {
      const ha = a.needsHuman ? 1 : 0;
      const hb = b.needsHuman ? 1 : 0;
      if (ha !== hb) return hb - ha;
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0);
    });
}

/**
 * WhatsApp 官方 / Meta AI 这类系统账号在销售场景毫无价值，统一在读时过滤。
 * 注意：personal-client 端也已经在 import / message 入口拦截，这里只是
 * 兜底之前历史数据里已经写入的几条。
 */
const SYSTEM_WA_IDS = new Set<string>(['0', '13135550002']);
function isSystemAccountId(id: string): boolean {
  if (!id) return false;
  if (id.endsWith('@newsletter')) return true;
  const phone = id.replace(/@.*/, '').replace(/\D/g, '');
  return SYSTEM_WA_IDS.has(phone);
}

export async function getMessages(conversationId: string, limit = 1000): Promise<WaMessage[]> {
  const store = await ensureFile();
  const rows = store.messages
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => a.timestamp - b.timestamp);
  // 兜底去重：历史上若同一条消息被 appendOutgoing + 回灌各写了一份
  // （waMessageId 相同但 id 不同），读取时按 waMessageId 折叠成一条，优先保留
  // 较早写入（通常是 out_* 本地 id，UI 已经引用过它）的那条。
  const seen = new Set<string>();
  const deduped: WaMessage[] = [];
  for (const m of rows) {
    if (m.waMessageId) {
      if (seen.has(m.waMessageId)) continue;
      seen.add(m.waMessageId);
    }
    deduped.push(m);
  }
  return deduped.slice(-limit);
}

export async function markRead(conversationId: string): Promise<void> {
  await enqueue((store) => {
    const c = store.conversations[conversationId];
    if (c) c.unread = 0;
  });
}

export async function appendIncoming(input: {
  conversationId: string;
  name?: string;
  text?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  type?: 'text' | 'image' | 'video';
  timestamp?: number;
  id?: string;
  /** WA 返回的 `_serialized`；appendIncoming 调用时传纯 id（不加 wweb_ 前缀）。 */
  waMessageId?: string;
  /** 如果该条 inbound 是「引用回复」，带上源消息的本地 id 和文本快照。 */
  quotedMessageId?: string;
  quoteText?: string;
  /** 引用的源消息如果是图片，下载后的 data URL，供 UI 缩略图 + 以图搜图复用。 */
  quoteImageUrl?: string;
}): Promise<WaMessage> {
  return enqueue((store) => {
    const ts = input.timestamp ?? Date.now();
    // 关键：把原始 id 通过别名表 resolve 到 canonical id，
    // 这样用户「合并一次」就永久生效，对方下次再发来同 id 的消息会自动落到合并后的会话。
    const convId = resolveAlias(input.conversationId);
    const msg: WaMessage = {
      id: input.id ?? `in_${ts}_${Math.random().toString(36).slice(2, 7)}`,
      conversationId: convId,
      direction: 'in',
      type:
        input.type ??
        (input.videoUrls?.length ? 'video' : input.imageUrls?.length ? 'image' : 'text'),
      text: input.text,
      imageUrls: input.imageUrls,
      videoUrls: input.videoUrls,
      waMessageId: input.waMessageId,
      quotedMessageId: input.quotedMessageId,
      quoteText: input.quoteText,
      quoteImageUrl: input.quoteImageUrl,
      timestamp: ts
    };
    store.messages.push(msg);
    const c = ensureConv(store, convId, input.name);
    c.lastMessage =
      input.text ?? (input.videoUrls?.length ? '[视频]' : input.imageUrls?.length ? '[图片]' : '');
    c.lastTimestamp = ts;
    c.unread += 1;
    return msg;
  });
}

export async function appendOutgoing(input: {
  conversationId: string;
  name?: string;
  text?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  productTitle?: string;
  productId?: string;
  quoteText?: string;
  quotedMessageId?: string;
  /** WhatsApp 返回的消息 id（`_serialized`），仅 personal 发送成功时有值 */
  waMessageId?: string;
  type?: 'text' | 'image' | 'video';
  status?: WaMessage['status'];
  error?: string;
  aiAuto?: boolean;
  aiSource?: WaMessage['aiSource'];
  aiReason?: string;
}): Promise<WaMessage> {
  return enqueue((store) => {
    const ts = Date.now();
    const convId = resolveAlias(input.conversationId);
    const msg: WaMessage = {
      id: `out_${ts}_${Math.random().toString(36).slice(2, 7)}`,
      conversationId: convId,
      direction: 'out',
      type:
        input.type ??
        (input.videoUrls?.length ? 'video' : input.imageUrls?.length ? 'image' : 'text'),
      text: input.text,
      imageUrls: input.imageUrls,
      videoUrls: input.videoUrls,
      productTitle: input.productTitle,
      productId: input.productId,
      quoteText: input.quoteText,
      quotedMessageId: input.quotedMessageId,
      waMessageId: input.waMessageId,
      status: input.status ?? 'sent',
      error: input.error,
      aiAuto: input.aiAuto || undefined,
      aiSource: input.aiSource,
      aiReason: input.aiReason,
      timestamp: ts
    };
    store.messages.push(msg);
    const c = ensureConv(store, convId, input.name);
    c.lastMessage =
      input.text ?? input.productTitle ?? (input.videoUrls?.length ? '[视频]' : '[图片]');
    c.lastTimestamp = ts;
    // 销售亲自回复（非 AI 自动）视为已接手 → 清除「待人工」亮灯。
    if (!input.aiAuto && c.needsHuman) {
      c.needsHuman = undefined;
      c.needsHumanReason = undefined;
      c.needsHumanAt = undefined;
    }
    return msg;
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await enqueue((store) => {
    delete store.conversations[id];
    store.messages = store.messages.filter((m) => m.conversationId !== id);
  });
}

/** 按 id 读一条消息（重试接口需要拿原始有效负载） */
export async function getMessageById(id: string): Promise<WaMessage | null> {
  const store = await ensureFile();
  return store.messages.find((m) => m.id === id) ?? null;
}

/** 通过 WhatsApp 原生 `_serialized` id 反查本地消息（用于 reaction / 转发等场景）。 */
export async function getMessageByWaId(waId: string): Promise<WaMessage | null> {
  if (!waId) return null;
  const store = await ensureFile();
  return store.messages.find((m) => m.waMessageId === waId) ?? null;
}

/**
 * 设置 / 取消一条消息上的某个 reaction。
 * - 同一个 from 只保留最后一个 emoji（与 WA 服务端语义一致）
 * - emoji='' 或 null 表示「取消我之前的 reaction」
 * 返回更新后的消息（如果存在）。
 */
export async function setReaction(
  localMsgId: string,
  reaction: { emoji: string; from: 'me' | 'them'; ts?: number; senderId?: string }
): Promise<WaMessage | null> {
  return enqueue((store) => {
    const idx = store.messages.findIndex((m) => m.id === localMsgId);
    if (idx < 0) return null;
    const cur = store.messages[idx]!;
    const others = (cur.reactions ?? []).filter((r) => {
      if (reaction.from === 'me') return r.from !== 'me';
      // them：按 senderId 区分，避免同一会话多个发送方互相覆盖
      return !(r.from === 'them' && (r.senderId ?? '') === (reaction.senderId ?? ''));
    });
    const next = reaction.emoji
      ? [...others, { ...reaction, ts: reaction.ts ?? Date.now() }]
      : others;
    store.messages[idx] = { ...cur, reactions: next.length ? next : undefined };
    return store.messages[idx]!;
  });
}


/**
 * 部分更新一条消息。主要用于：重试中置 sending、重试后置 sent/failed、
 * webhook 回调更新 delivered/read 等。会同步刷新所在会话的 lastMessage/lastTimestamp。
 */
export async function updateMessage(
  id: string,
  patch: Partial<Pick<WaMessage, 'status' | 'error' | 'text' | 'timestamp' | 'aiAuto' | 'aiSource' | 'aiReason' | 'waMessageId'>>
): Promise<WaMessage | null> {
  return enqueue((store) => {
    const idx = store.messages.findIndex((m) => m.id === id);
    if (idx < 0) return null;
    const updated = { ...store.messages[idx]!, ...patch };
    store.messages[idx] = updated;
    // 同步会话顶部列（不需要精准，差不多就行）
    const c = store.conversations[updated.conversationId];
    if (c && (patch.timestamp ?? 0) > (c.lastTimestamp ?? 0)) {
      c.lastTimestamp = patch.timestamp;
      c.lastMessage = updated.text ?? updated.productTitle ?? c.lastMessage;
    }
    return updated;
  });
}

/** 删除一条消息（用户在气泡上按"删除失败条目"时） */
export async function deleteMessage(id: string): Promise<{ deleted: boolean }> {
  return enqueue((store) => {
    const before = store.messages.length;
    store.messages = store.messages.filter((m) => m.id !== id);
    return { deleted: store.messages.length !== before };
  });
}

/**
 * 切换会话置顶状态。返回切换后的状态。
 * 如果会话不存在（理论上不会）返回 null。
 */
export async function toggleConversationPinned(id: string): Promise<{ pinned: boolean } | null> {
  return enqueue((store) => {
    const c = store.conversations[id];
    if (!c) return null;
    c.pinned = !c.pinned;
    return { pinned: !!c.pinned };
  });
}

/**
 * 从 messages[] 反推所有会话条目，补齐 `conversations` 字典里缺失的项。
 * 用途：当某些会话被误删（或前端只看到极少联系人）时，从历史消息恢复出来。
 * 已存在的会话保留原 name/unread/lastMessage/lastTimestamp，只对缺失项新建。
 * 返回新增的会话数量。
 */
export async function rebuildConversationIndex(): Promise<{ added: number; total: number }> {
  return enqueue((store) => {
    let added = 0;
    for (const m of store.messages) {
      const cid = resolveAlias(m.conversationId);
      if (!store.conversations[cid]) {
        store.conversations[cid] = {
          id: cid,
          unread: 0,
          lastTimestamp: m.timestamp,
          lastMessage:
            m.text ?? (m.videoUrls?.length ? '[视频]' : m.imageUrls?.length ? '[图片]' : '')
        };
        added += 1;
      } else {
        const c = store.conversations[cid];
        if ((m.timestamp ?? 0) > (c.lastTimestamp ?? 0)) {
          c.lastTimestamp = m.timestamp;
          c.lastMessage =
            m.text ?? (m.videoUrls?.length ? '[视频]' : m.imageUrls?.length ? '[图片]' : '');
        }
      }
    }
    return { added, total: Object.keys(store.conversations).length };
  });
}

/**
 * 批量插入「空会话」条目（仅有 id + name），用于把所有 WhatsApp 通讯录联系人
 * 都展示到侧栏，方便接手工 case 的同事一眼看全。
 * - 已存在的会话只补 name（如果原来没有）
 * - 不修改 lastMessage / lastTimestamp / unread
 */
export async function ensureEmptyConversations(
  entries: { id: string; name?: string }[]
): Promise<{ added: number }> {
  return enqueue((store) => {
    let added = 0;
    for (const e of entries) {
      if (!e.id) continue;
      const cid = resolveAlias(e.id);
      if (!store.conversations[cid]) {
        store.conversations[cid] = { id: cid, name: e.name, unread: 0 };
        added += 1;
      } else if (e.name && !store.conversations[cid].name) {
        store.conversations[cid].name = e.name;
      }
    }
    return { added };
  });
}

/**
 * 历史回灌专用 upsert：
 * - 按 msg.id 去重（whatsapp-web.js 的 msg.id._serialized 是稳定的）
 * - 不增 unread（历史不该让客户列表变红）
 * - 仅当该会话首次见到此 id 时写入，并刷新 lastMessage/lastTimestamp 为时间最大者
 * 用于 personal-client 在 ready 后批量回灌，多次执行幂等。
 */
export async function upsertHistoricalMessage(input: WaMessage & { name?: string }): Promise<{ inserted: boolean }> {
  return enqueue((store) => {
    const convId = resolveAlias(input.conversationId);
    // 已存在同 id 直接跳过
    if (store.messages.some((m) => m.id === input.id)) {
      // 仍补一下 name（联系人通讯录名优先于 push name）
      if (input.name) ensureConv(store, convId, input.name);
      return { inserted: false };
    }
    // 已存在同 waMessageId（不同本地 id）也跳过——避免 appendOutgoing 写入的 `out_*`
    // 和回灌时算出的 `wweb_*` 把同一条消息变成两条。顺便把 waMessageId 回填到
    // 旧记录上（保留 out_* 本地 id 以兼容已有 UI 引用 / 重试链）。
    if (input.waMessageId) {
      const existing = store.messages.find((m) => m.waMessageId === input.waMessageId);
      if (existing) {
        if (input.name) ensureConv(store, convId, input.name);
        return { inserted: false };
      }
    }
    // 回灌的 `wweb_*` 出站消息往往没有 waMessageId（断网仅本地发出时），无法按 id 配对。
    // 这里按模糊键 + 时间窗再兜一层，避免它和本地 `out_*` 形成刷新后重复。
    const candidate: WaMessage = { ...input, conversationId: convId };
    if (outgoingFuzzyKey(candidate)) {
      const echo = store.messages.find((m) => isOutgoingEcho(m, candidate));
      if (echo) {
        if (input.name) ensureConv(store, convId, input.name);
        return { inserted: false };
      }
    }
    const msg: WaMessage = candidate;
    store.messages.push(msg);
    const c = ensureConv(store, convId, input.name);
    // 仅当历史消息更新才覆盖 last 字段；历史回灌不应该把"现在的预览"刷成旧消息
    if ((input.timestamp ?? 0) > (c.lastTimestamp ?? 0)) {
      c.lastTimestamp = input.timestamp;
      c.lastMessage = input.text ?? (input.imageUrls?.length ? '[图片]' : '');
    }
    return { inserted: true };
  });
}

/** 给会话改名（用户自定义显示名，永久生效，覆盖 push name 兜底） */
export async function renameConversation(id: string, name: string): Promise<void> {
  await enqueue((store) => {
    const c = store.conversations[id];
    if (c) c.name = name.trim() || undefined;
  });
}

/**
 * 设定 / 清空会话的「发出语言锁」。
 * - 传空字符串或 null = 取消锁定，回到不强制翻译
 * - 否则强制后续 sendText 在发送前译为该语言
 */
export async function setConversationOutputLang(
  id: string,
  lang: string | null
): Promise<void> {
  await enqueue((store) => {
    const c = store.conversations[id];
    if (!c) return;
    if (!lang) delete c.outputLang;
    else c.outputLang = lang;
  });
}

/**
 * 设置该会话的 AI 自动化档位。传 null 清除（回退到全局 defaultMode）。
 * 合法值：OFF / SUGGEST / DRAFT_AUTO / AUTO_SAFE / AUTO_FULL；其它值会被忽略。
 */
export async function setConversationAutoMode(
  id: string,
  mode: string | null
): Promise<void> {
  const allowed = new Set(['OFF', 'SUGGEST', 'DRAFT_AUTO', 'AUTO_SAFE', 'AUTO_FULL']);
  if (mode && !allowed.has(mode)) return;
  await enqueue((store) => {
    const canonical = resolveAlias(id);
    let c = store.conversations[canonical];
    if (!c) {
      c = ensureConv(store, canonical);
    }
    if (!mode) delete c.autoMode;
    else c.autoMode = mode;
  });
}

/**
 * 销售阶段 / 偏好槽位 / 客户温度的 patch 写入。任何 undefined 字段保留旧值，
 * 传入 null 字符串显式清除某槽位。slots 浅合并。
 * 一次写盘合并多个字段，便于 stage 切换时同时更新多个状态。
 */
export async function patchConversationSalesState(
  id: string,
  patch: {
    salesStage?: WaConversation['salesStage'];
    slots?: Partial<NonNullable<WaConversation['slots']>>;
    leadTemperature?: WaConversation['leadTemperature'];
    needsHuman?: boolean;
    needsHumanReason?: string;
  }
): Promise<void> {
  await enqueue((store) => {
    const canonical = resolveAlias(id);
    let c = store.conversations[canonical];
    if (!c) c = ensureConv(store, canonical);
    if (patch.salesStage && patch.salesStage !== c.salesStage) {
      c.salesStage = patch.salesStage;
      c.salesStageAt = Date.now();
    }
    if (patch.leadTemperature) c.leadTemperature = patch.leadTemperature;
    if (patch.needsHuman !== undefined) {
      if (patch.needsHuman) {
        c.needsHuman = true;
        c.needsHumanReason = patch.needsHumanReason;
        c.needsHumanAt = Date.now();
      } else {
        c.needsHuman = undefined;
        c.needsHumanReason = undefined;
        c.needsHumanAt = undefined;
      }
    }
    if (patch.slots) {
      const next = { ...(c.slots ?? {}) };
      for (const [k, v] of Object.entries(patch.slots) as Array<[
        keyof NonNullable<WaConversation['slots']>,
        string | undefined | null
      ]>) {
        if (v === null) delete next[k];
        else if (typeof v === 'string' && v.trim()) next[k] = v.trim();
      }
      c.slots = next;
    }
  });
}

/**
 * 记录本次自动发出的商品 id。仅保留最近 72h 的项，超过则裁掉。
 * 用于 AUTO_FULL 在 24h 内对同款去重。
 */
export async function recordSentProduct(
  id: string,
  productId: string
): Promise<void> {
  await enqueue((store) => {
    const canonical = resolveAlias(id);
    let c = store.conversations[canonical];
    if (!c) c = ensureConv(store, canonical);
    const now = Date.now();
    const list = (c.lastSentProductIds ?? []).filter((x) => now - x.ts < 72 * 3600_000);
    list.push({ id: productId, ts: now });
    c.lastSentProductIds = list.slice(-50);
  });
}

/**
 * 统计该会话在 windowMs（默认 1 小时）内由 AI 自动发出的消息条数。
 * 用于 AUTO_FULL 自动化节奏限速：超过阈值（如 60 条/小时）后跳过本次自动发送，
 * 防止对方 WhatsApp 把账号判风控。
 * 直接从 messages[] 派生，不引入额外状态。
 */
export async function countRecentAiAutoSends(
  conversationId: string,
  windowMs = 3600_000
): Promise<number> {
  const store = await ensureFile();
  const canonical = resolveAlias(conversationId);
  const cutoff = Date.now() - windowMs;
  let n = 0;
  for (const m of store.messages) {
    if (
      m.direction === 'out' &&
      m.aiAuto &&
      m.conversationId === canonical &&
      (m.timestamp ?? 0) >= cutoff &&
      m.status !== 'failed'
    ) {
      n += 1;
    }
  }
  return n;
}

/**
 * 记录某条出站消息已被「投石问路」追打过，避免同一条消息被反复 nudge。
 */
export async function markConversationNudged(
  id: string,
  outboundMessageId: string
): Promise<void> {
  await enqueue((store) => {
    const canonical = resolveAlias(id);
    let c = store.conversations[canonical];
    if (!c) c = ensureConv(store, canonical);
    c.lastNudgedOutboundId = outboundMessageId;
  });
}

/**
 * 写入 / 清除会话的 AI 草稿（DRAFT_AUTO 用）。
 * 传 null 即清除（前端拿到后调用 DELETE 会走到这里）。
 */
export async function setConversationDraft(
  id: string,
  draft: WaConversation['aiDraft'] | null
): Promise<void> {
  await enqueue((store) => {
    const canonical = resolveAlias(id);
    let c = store.conversations[canonical];
    if (!c) {
      c = ensureConv(store, canonical);
    }
    if (!draft) delete c.aiDraft;
    else c.aiDraft = draft;
  });
}

/**
 * 合并两个会话（用于 LID/电话双线串号场景）。
 * - 把 fromId 的所有消息 conversationId 改为 toId
 * - 删除 fromId 会话
 * - toId 的 name/lastMessage/lastTimestamp 取较新者；unread 累加
 * 注意：合并不可撤销。
 */
export async function mergeConversations(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  // 持久化别名：fromId -> toId（永久），下次同一对端再来消息会自动落到 toId
  await addAlias(fromId, toId);
  await enqueue((store) => {
    const from = store.conversations[fromId];
    const to = store.conversations[toId];
    if (!from) return;
    // 迁移消息
    for (const m of store.messages) {
      if (m.conversationId === fromId) m.conversationId = toId;
    }
    if (!to) {
      // 目标不存在：把 from 改名为 toId
      store.conversations[toId] = { ...from, id: toId };
    } else {
      to.unread = (to.unread ?? 0) + (from.unread ?? 0);
      if ((from.lastTimestamp ?? 0) > (to.lastTimestamp ?? 0)) {
        to.lastTimestamp = from.lastTimestamp;
        to.lastMessage = from.lastMessage;
      }
      if (!to.name && from.name) to.name = from.name;
    }
    delete store.conversations[fromId];
  });
}
