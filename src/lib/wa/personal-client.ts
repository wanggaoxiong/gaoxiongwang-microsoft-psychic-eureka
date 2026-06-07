/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import QRCode from 'qrcode';
import { appendIncoming, upsertHistoricalMessage, ensureEmptyConversations, getMessageByWaId, setReaction, getMessageById, updateMessage } from './store';
import { addAlias, resolveAlias, warmAliases } from './alias-map';
import {
  getActiveProfileId,
  getActiveProfileIdSync,
  getProfileClientId,
  getProfileSessionDir,
  wipeProfileSession
} from './profiles';

// whatsapp-web.js is CJS with side effects; require lazily inside init
type WwebClient = any;

export type PersonalState =
  | 'idle'
  | 'initializing'
  | 'qr'
  | 'authenticated'
  | 'ready'
  | 'auth_failure'
  | 'disconnected';

export type BackfillStatus = {
  state: 'idle' | 'running' | 'done' | 'error';
  chatsTotal: number;
  chatsDone: number;
  messagesInserted: number;
  startedAt: number | null;
  finishedAt: number | null;
  error?: string;
};

type Holder = {
  client: WwebClient | null;
  state: PersonalState;
  qrDataUrl: string | null;
  qrText: string | null;
  me: { id: string; name?: string } | null;
  lastError: string | null;
  startedAt: number | null;
  backfill: BackfillStatus;
  /** 自动重连试推：用于退避与防止叠加多条重连链 */
  reconnect: {
    attempts: number;
    nextAttemptAt: number | null;
    timer: ReturnType<typeof setTimeout> | null;
    /** 如果是用户主动 logout「不要」重连，设 true */
    disabled: boolean;
  };
  /** 本次（最近一次）启动时实际生效的代理设置 */
  proxy?: {
    configured: boolean;
    inUse: string | null;
    explicitlyDisabled: boolean;
  };
};

const g = globalThis as unknown as { __waPersonal?: Holder };
let softRefreshInFlight = false;
let lastSoftRefreshAt = 0;

function holder(): Holder {
  if (!g.__waPersonal) {
    g.__waPersonal = {
      client: null,
      state: 'idle',
      qrDataUrl: null,
      qrText: null,
      me: null,
      lastError: null,
      startedAt: null,
      backfill: {
        state: 'idle',
        chatsTotal: 0,
        chatsDone: 0,
        messagesInserted: 0,
        startedAt: null,
        finishedAt: null
      },
      reconnect: { attempts: 0, nextAttemptAt: null, timer: null, disabled: false }
    };
  }
  return g.__waPersonal!;
}

/**
 * 进程退出（Ctrl+C / kill）时优雅关闭 Chromium。
 *
 * 不优雅关闭会怎样：whatsapp-web.js 用 puppeteer 拉起一个 headless Chromium 子进程，
 * 登录态存在 data/.wwebjs_auth/session-<id> 这个 userDataDir 的 IndexedDB/LevelDB 里。
 * 直接 SIGINT 杀掉 Node 进程时，Chromium 可能：(a) 变成孤儿进程继续锁着 userDataDir；
 * (b) LevelDB 写到一半被打断，profile 处于「脏」状态。下次 npm run dev 再启动时，
 * 新的 Chromium 在这个脏/被锁的 profile 上恢复会话，WA Web 检测到状态不一致会刷新页面，
 * 正在注入脚本的 execution context 随之被销毁 → 报 "Execution context was destroyed"
 * → init 失败 → auth_failure → 退回扫码。
 *
 * 这里在 SIGINT/SIGTERM 时先给 client.destroy() 最多 2s 做干净关闭（正常 flush LevelDB），
 * 超时或失败再 SIGKILL 兜底，避免孤儿进程；之后才真正退出。第二次 Ctrl+C 立即强退。
 */
function registerShutdownHooks(): void {
  const gg = globalThis as unknown as { __waShutdownHooked?: boolean };
  if (gg.__waShutdownHooked) return;
  gg.__waShutdownHooked = true;

  let closing = false;
  const closeBrowser = async (): Promise<void> => {
    const h = holder();
    const c = h.client;
    h.reconnect.disabled = true;
    if (h.reconnect.timer) {
      clearTimeout(h.reconnect.timer);
      h.reconnect.timer = null;
    }
    if (!c) return;
    try {
      await Promise.race([c.destroy(), new Promise((r) => setTimeout(r, 2000))]);
    } catch {
      /* ignore */
    }
    // 兜底：destroy 没在 2s 内关掉浏览器时，直接 kill 子进程，杜绝孤儿 Chromium 锁住 profile
    try {
      c.pupBrowser?.process?.()?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    h.client = null;
  };

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (closing) {
        // 第二次信号：用户急着退，立即强制退出
        process.exit(130);
        return;
      }
      closing = true;
      void closeBrowser().finally(() => process.exit(0));
    });
  }
}

function resolveChromiumPath(): string | undefined {
  if (process.env.WA_CHROMIUM_PATH) return process.env.WA_CHROMIUM_PATH;
  try {
    // Reuse playwright's bundled chromium (already installed)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('playwright');
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

function resolveProxyServer(opts?: { useProxy?: boolean }): string | undefined {
  if (opts && opts.useProxy === false) return undefined;
  return process.env.WA_PROXY_SERVER || undefined;
}

/** 仅读取环境变量中配置的代理地址，不管本次启动是否启用。 */
function configuredProxyServer(): string | undefined {
  return process.env.WA_PROXY_SERVER || undefined;
}

function hasGenericProxyEnv(): boolean {
  return Boolean(
    process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy
  );
}

function normalizeStartupError(message: string): string {
  const msg = message || 'unknown error';
  const m = msg.toLowerCase();

  if (m.includes('max qrcode retries reached')) {
    return '本地 WhatsApp 登录 session 存在，但 WhatsApp Web 已判定登录态失效，二维码刷新次数已达上限。通常是手机端删除了该已连接设备、账号被 WhatsApp 重新验证、或本地浏览器 profile 曾异常退出导致 session 损坏；需要重新扫码一次。';
  }

  // 1) 明确的网络/导航错误：通常是代理或出口网络不通
  const isNavError =
    m.includes('err_connection_reset') ||
    m.includes('err_connection_closed') ||
    m.includes('err_tunnel_connection_failed') ||
    m.includes('err_proxy_connection_failed') ||
    m.includes('err_socks_connection_failed') ||
    m.includes('err_timed_out') ||
    m.includes('err_name_not_resolved') ||
    m.includes('ssl_error_syscall') ||
    m.includes('page.navigate timed out') ||
    m.includes('navigation timeout');

  // 2) Puppeteer/CDP 层超时：WA Web 页面长时间没回执行结果，多数情况下也是上游网络/代理不通
  const isCdpTimeout =
    m.includes('runtime.callfunctionon timed out') ||
    m.includes('protocoltimeout') ||
    m.includes('protocol timeout') ||
    (m.includes('target closed') && m.includes('timeout'));

  if (isNavError || isCdpTimeout) {
    const proxy = resolveProxyServer();
    if (proxy) {
      const kind = isCdpTimeout && !isNavError ? '代理疑似不可达 / 无响应' : '代理不可达';
      return `${kind}：WA_PROXY_SERVER=${proxy} 无法打开 web.whatsapp.com。请检查该代理是否在运行、是否能科学上网，或清空 .env.local 里的 WA_PROXY_SERVER 后重试。原始错误: ${msg}`;
    }
    const envHint = hasGenericProxyEnv()
      ? '检测到终端存在 HTTPS_PROXY/ALL_PROXY 等通用代理环境变量，但 WhatsApp Web 不会自动继承它们；如确实需要让 Chromium 走代理，请显式设置 WA_PROXY_SERVER。'
      : '如当前网络必须走代理，请在 .env.local 显式设置 WA_PROXY_SERVER。';
    return `当前 Chromium 无法访问 WhatsApp Web。${envHint} 原始错误: ${msg}`;
  }
  return msg;
}

function isSavedSessionInvalid(state: PersonalState, lastError: string | null, hasSession: boolean): boolean {
  if (!hasSession) return false;
  if (state !== 'qr' && state !== 'auth_failure' && state !== 'disconnected') return false;
  const msg = (lastError || '').toLowerCase();
  return (
    state === 'qr' ||
    msg.includes('登录态失效') ||
    msg.includes('max qrcode retries reached') ||
    msg.includes('session') ||
    msg.includes('auth')
  );
}

/**
 * 启动前对 WA_PROXY_SERVER 做一次轻量 TCP 探测：
 * - 仅检查代理服务端口能否 3 秒内连上；不验证能否真正 CONNECT 到 web.whatsapp.com
 * - 用于在启动 Chromium 之前快速失败，避免等 180s 才看到一句笼统的 Runtime.callFunctionOn timed out
 */
async function probeProxyReachable(
  proxyServer: string,
  timeoutMs = 3000
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let host: string;
  let port: number;
  try {
    const url = proxyServer.includes('://')
      ? new URL(proxyServer)
      : new URL('http://' + proxyServer);
    host = url.hostname;
    const defaultPort = url.protocol === 'https:' ? 443 : url.protocol.startsWith('socks') ? 1080 : 8080;
    port = Number(url.port) || defaultPort;
    if (!host) return { ok: false, reason: 'invalid proxy host' };
  } catch (e: any) {
    return { ok: false, reason: `invalid WA_PROXY_SERVER: ${e?.message ?? String(e)}` };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const net = require('node:net') as typeof import('node:net');
  return await new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (r: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => done({ ok: false, reason: `connect timeout >${timeoutMs}ms` }));
    socket.once('error', (e: Error) => done({ ok: false, reason: e.message }));
    socket.connect(port, host, () => done({ ok: true }));
  });
}

function chatIdToWaId(chatId: string): string {
  // e.g. "8613912345678@c.us" -> "8613912345678"
  return chatId.replace(/@.*/, '').replace(/\D/g, '');
}

/**
 * WhatsApp 平台账号 / 系统账号，对销售场景毫无价值，统一过滤掉。
 * - `0@c.us`            → WhatsApp 官方通知账号
 * - `13135550002@c.us`  → Meta AI（美国号段）
 * - `status@broadcast`  → 状态广播（已在消息事件中过滤）
 * - 任何 `*@newsletter` → Channel
 * 命中即跳过：不入库、不导入空会话、不展示。
 */
const SYSTEM_WA_IDS = new Set<string>(['0', '13135550002']);
function isSystemAccount(idOrPhone: string): boolean {
  if (!idOrPhone) return false;
  if (idOrPhone.endsWith('@newsletter')) return true;
  const phone = idOrPhone.replace(/@.*/, '').replace(/\D/g, '');
  return SYSTEM_WA_IDS.has(phone);
}

/**
 * 指数退避排期一次重连。最多 6 次：30s → 60s → 120s → 240s → 300s → 300s
 * - 仅在 disconnected / auth_failure / 初始化报错时调用
 * - 跳过已有重连计时器或 disabled（用户 logout）场景
 * - 重连本质上是 scheduled startPersonalClient()；后者已有销毁旧 client 逻辑
 *
 * ⚠️ 默认禁用：销毁并重建 wweb client 在某些场景下会得到一个"看似 ready
 * 但发送不出去 / 收不到消息"的僵尸客户端，并清空联系人 cache，触发
 * importAllContacts 写入空列表覆盖本地数据。要启用，请 export WA_AUTO_RECONNECT=1。
 */
function scheduleReconnect(reason: string): void {
  if (process.env.WA_AUTO_RECONNECT !== '1') {
    // eslint-disable-next-line no-console
    console.warn(`[wa-personal] auto-reconnect disabled (reason=${reason}); set WA_AUTO_RECONNECT=1 to enable`);
    return;
  }
  const h = holder();
  if (h.reconnect.disabled) return;
  if (h.reconnect.timer) return;
  if (h.reconnect.attempts >= 6) {
    // eslint-disable-next-line no-console
    console.warn('[wa-personal] giving up auto-reconnect after 6 attempts');
    return;
  }
  const delays = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000];
  const delay = delays[h.reconnect.attempts] ?? 300_000;
  h.reconnect.attempts += 1;
  h.reconnect.nextAttemptAt = Date.now() + delay;
  // eslint-disable-next-line no-console
  console.warn(
    `[wa-personal] schedule reconnect #${h.reconnect.attempts} in ${Math.round(delay / 1000)}s (reason=${reason})`
  );
  h.reconnect.timer = setTimeout(async () => {
    h.reconnect.timer = null;
    h.reconnect.nextAttemptAt = null;
    try {
      // 清掉旧 client、重新 init。startPersonalClient 自己会跳过 ready。
      // 但我们现在是 disconnected/auth_failure，会走 destroy + 重建分支。
      await startPersonalClient();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[wa-personal] reconnect attempt failed', e);
      // 失败后再排一次
      scheduleReconnect('retry-after-failure');
    }
  }, delay);
}

function cancelReconnect(disabled: boolean): void {
  const h = holder();
  if (h.reconnect.timer) {
    clearTimeout(h.reconnect.timer);
    h.reconnect.timer = null;
  }
  h.reconnect.nextAttemptAt = null;
  h.reconnect.attempts = 0;
  h.reconnect.disabled = disabled;
}

/**
 * 把外部传入的「目标」规范化为 whatsapp-web.js sendMessage 能识别的 chatId。
 * - 若已含 `@`（如 `<lid>@lid` / `<phone>@c.us` / `<id>@g.us`），原样返回 —— 关键：
 *   LID 必须用 `<lid>@lid` 寻址，不能转成 `<lid>@c.us` 否则报 "No LID for user"。
 * - 否则当作 E.164 电话号，补 `@c.us`。
 */
function waIdToChatId(to: string): string {
  if (to.includes('@')) return to;
  return `${to.replace(/\D/g, '')}@c.us`;
}

/** 判断 sendMessage 报错是否属于「应该换 @lid/@c.us 后缀重试」一类 */
function isAddressingError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('no lid for user') ||
    m.includes('no phone for user') ||
    m.includes('wid error') ||
    m.includes('not a valid user') ||
    m.includes('invalid wid') ||
    m.includes('not-authorized')
  );
}

/**
 * Puppeteer / WA Web 常见瞬时错误：页面刷新、frame 重建、execution context 丢失。
 * 这类错误通常短暂，重试一次大概率恢复。
 */
function isTransientSendError(msg: string): boolean {
  const m = (msg || '').toLowerCase();
  return (
    m.includes('attempted to use detached frame') ||
    m.includes('execution context was destroyed') ||
    m.includes('target closed') ||
    m.includes('session closed') ||
    m.includes('cannot find context with specified id') ||
    m.includes('protocol error') ||
    // WA Web Store hook 失效：内部 Model.getChat() 调用前 chat 是 undefined。
    // 多半是页面被刷新或 WA Web 升级，需要软重建。
    m.includes("reading 'getchat'") ||
    m.includes("reading 'getmodel'") ||
    m.includes("reading 'sendmessage'")
  );
}

function toFriendlySendError(msg: string): string {
  if (isTransientSendError(msg)) {
    return 'WhatsApp Web 会话正在刷新，请重试（已自动重试一次）';
  }
  return msg;
}

async function sendMessageWithRetry(
  client: WwebClient,
  chatId: string,
  payload: string | any,
  opts?: any
): Promise<any> {
  // 注意：text 也要把 opts 透传给 whatsapp-web.js，否则 quotedMessageId 等会被丢弃，
  // 表现就是「网页端有引用条但对方手机上是普通消息」。
  try {
    return await client.sendMessage(chatId, payload, opts);
  } catch (e: any) {
    const reason = e?.message ?? String(e);
    if (!isTransientSendError(reason)) throw e;
    // 给 WA Web 一点时间恢复 frame/context
    await new Promise((res) => setTimeout(res, 900));
    try {
      return await client.sendMessage(chatId, payload, opts);
    } catch (e2: any) {
      // 两次都被 detached frame / context destroyed 命中时，触发一次后台软重建。
      // 注意：发送请求本身仍返回失败，避免“看似成功实际没发出”。
      void triggerSoftSessionRefresh('transient-send-failure:' + (e2?.message ?? String(e2)));
      throw e2;
    }
  }
}

/**
 * 软重建：当 client 状态看起来 ready，但 sendMessage 持续 detached frame 时调用。
 * - 冷却 45s，避免疯狂重建
 * - 后台异步执行，不阻塞当前请求
 */
async function triggerSoftSessionRefresh(reason: string): Promise<void> {
  const now = Date.now();
  if (softRefreshInFlight) return;
  if (now - lastSoftRefreshAt < 45_000) return;
  softRefreshInFlight = true;
  lastSoftRefreshAt = now;
  const h = holder();
  h.lastError = `soft-refresh: ${reason}`;
  const current = h.client;
  h.client = null;
  h.state = 'initializing';
  try {
    if (current) {
      try {
        await current.destroy();
      } catch {
        /* ignore */
      }
    }
    await startPersonalClient();
  } catch (e) {
    h.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    softRefreshInFlight = false;
  }
}

/**
 * 给 store 用的统一 conversationId：
 * - `<phone>@c.us` → 保持纯数字 phone（向后兼容旧本地数据）
 * - `<lid>@lid` / 其它 → 保留完整 serialized id，避免被截成数字后与 phone 串号
 */
function normalizeConversationId(serialized: string): string {
  if (serialized.endsWith('@c.us')) return serialized.split('@')[0]!.replace(/\D/g, '');
  return serialized;
}

async function attachEvents(client: WwebClient): Promise<void> {
  const h = holder();
  await warmAliases();

  client.on('qr', async (qr: string) => {
    h.state = 'qr';
    h.qrText = qr;
    try {
      h.qrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 });
    } catch {
      h.qrDataUrl = null;
    }
  });

  client.on('authenticated', () => {
    h.state = 'authenticated';
    h.qrDataUrl = null;
    h.qrText = null;
  });

  client.on('auth_failure', (msg: string) => {
    h.state = 'auth_failure';
    h.lastError = normalizeStartupError(msg);
    // 一般是 session 过期 / 手机端被踢下线，同样调重连让他重新出 QR
    if (!h.reconnect.disabled) scheduleReconnect('auth_failure:' + msg);
  });

  client.on('ready', () => {
    h.state = 'ready';
    // 成功上线就重置退避计数
    cancelReconnect(false);
    const info = client.info;
    if (info?.wid) {
      h.me = {
        id: chatIdToWaId(info.wid._serialized ?? `${info.wid.user}@c.us`),
        name: info.pushname
      };
    }
    // 历史回灌：异步跑，不阻塞 ready。whatsapp-web.js 默认不重放手机已有历史，
    // 需我们主动拉，营造「装上就有全部上下文」的私域体验。
    backfillRecentChats(client).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[wa-personal] backfill failed', e);
      h.backfill.state = 'error';
      h.backfill.error = e instanceof Error ? e.message : String(e);
      h.backfill.finishedAt = Date.now();
    });
  });

  client.on('disconnected', (reason: string) => {
    h.state = 'disconnected';
    h.lastError = normalizeStartupError(reason);
    // 不是用户主动 logout 的话就排一次退避重连。
    // logout 会同步清除文件并把 disabled 置 true，这里就跳过。
    if (!h.reconnect.disabled) {
      scheduleReconnect('disconnected:' + (reason || ''));
    }
  });

  client.on('message', async (msg: any) => {
    try {
      if (msg.fromMe) return;
      const serialized: string = msg.from || '';
      // Skip group / status broadcasts / channels / 广播
      if (
        !serialized ||
        serialized.includes('@g.us') ||
        serialized.includes('status@') ||
        serialized.endsWith('@newsletter') ||
        serialized.endsWith('@broadcast')
      )
        return;
      // 过滤 WhatsApp / Meta AI 等系统账号
      if (isSystemAccount(serialized)) return;
      const from = normalizeConversationId(serialized);
      if (!from) return;

      let imageUrls: string[] | undefined;
      let videoUrls: string[] | undefined;
      let text: string | undefined = msg.body || undefined;
      let type: 'text' | 'image' | 'video' = 'text';

      if (msg.hasMedia && (msg.type === 'image' || msg.type === 'sticker')) {
        try {
          const media = await msg.downloadMedia();
          if (media?.data) {
            imageUrls = [`data:${media.mimetype};base64,${media.data}`];
            type = 'image';
            if (!text) text = msg.body || undefined;
          }
        } catch {
          /* ignore media failures */
        }
      } else if (msg.hasMedia && (msg.type === 'video' || msg.type === 'ptv')) {
        // 视频 / 圈视频：以 data URL 写入 store，前端用 <video> 播放
        try {
          const media = await msg.downloadMedia();
          if (media?.data) {
            videoUrls = [`data:${media.mimetype};base64,${media.data}`];
            type = 'video';
            if (!text) text = msg.body || undefined;
          }
        } catch {
          /* ignore */
        }
      }

      let name: string | undefined;
      let canonical = resolveAlias(from);
      try {
        const contact = await msg.getContact();
        name = contact?.pushname || contact?.name || contact?.shortName;
        // 自动合并策略（不会覆盖用户手动合并意图）：
        // 仅在 from 与 phoneId 都尚未被 alias 到其它 canonical 时，才写 from->phoneId。
        // 否则优先沿用现有 canonical，避免出现“手动合并后又被自动拆开”。
        const phone: string | undefined =
          (typeof contact?.number === 'string' && contact.number) ||
          (contact?.id?.server === 'c.us' && typeof contact?.id?.user === 'string'
            ? contact.id.user
            : undefined);
        if (phone) {
          const phoneId = phone.replace(/\D/g, '');
          if (phoneId && phoneId !== from) {
            const fromCanonical = resolveAlias(from);
            const phoneCanonical = resolveAlias(phoneId);
            if (fromCanonical === from && phoneCanonical === phoneId) {
              await addAlias(from, phoneId);
              canonical = phoneId;
            } else {
              canonical = fromCanonical === from ? phoneCanonical : fromCanonical;
            }
          }
        }
      } catch {
        /* ignore */
      }

      // 引用回复：拿到被引用消息的本地 id + 文本快照，让 inbox 能像 WA 一样显示引用条。
      let quotedMessageId: string | undefined;
      let quoteText: string | undefined;
      let quoteImageUrl: string | undefined;
      try {
        if (msg.hasQuotedMsg) {
          const q = await msg.getQuotedMessage();
          const qSer: string | undefined = q?.id?._serialized ?? q?.id?.id;
          if (qSer) quotedMessageId = `wweb_${qSer}`;
          const raw: string | undefined =
            typeof q?.body === 'string' && q.body ? q.body : undefined;
          quoteText = raw
            ? raw.length > 140 ? `${raw.slice(0, 140)}…` : raw
            : q?.hasMedia
            ? q?.type === 'video' || q?.type === 'ptv'
              ? '[视频]'
              : '[图片]'
            : undefined;
          // 引用的是图片 / 贴纸：下载过来存为 data URL，供 inbox 缩略图 + 后续「以图搜图」复用。
          if (q?.hasMedia && (q?.type === 'image' || q?.type === 'sticker')) {
            try {
              const media = await q.downloadMedia();
              if (media?.data && media?.mimetype) {
                quoteImageUrl = `data:${media.mimetype};base64,${media.data}`;
              }
            } catch (e) {
              console.warn('[wa-personal] downloadMedia(quoted) failed', e);
            }
          }
        }
      } catch {
        /* 引用拿不到不影响主流程 */
      }

      await appendIncoming({
        conversationId: canonical,
        name,
        text,
        imageUrls,
        videoUrls,
        type,
        timestamp: (msg.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
        id: `wweb_${msg.id?._serialized ?? msg.id?.id ?? Date.now()}`,
        waMessageId: msg.id?._serialized ?? msg.id?.id,
        quotedMessageId,
        quoteText,
        quoteImageUrl
      });

      // AI 自动响应（DRAFT_AUTO / AUTO_SAFE / AUTO_FULL）：fire-and-forget。
      // 内部有冷却、kill switch、未配置 Azure 等所有兜底，并且永不抛异常。
      // 用 dynamic import 避免与 personal-client.ts 之间形成循环依赖
      // （auto-respond.ts 反过来要 import 本文件的 sendPersonalText / isPersonalReady）。
      void import('@/lib/ai/auto-respond')
        .then((m) => m.triggerAutoRespond(canonical))
        .catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[wa-personal] auto-respond load error', e);
        });
    } catch (e) {
      // swallow to keep client alive
      // eslint-disable-next-line no-console
      console.error('[wa-personal] message handler error', e);
    }
  });

  // 来电监听：whatsapp-web.js 能感知到来电事件，但 web 协议本身**无法接听语音/视频**。
  // 我们的策略：
  //   1) 静默拒接（避免在 web 端一直响铃），如果用户配置了 WA_AUTO_REJECT_CALLS=0 则保留响铃；
  //   2) 把一条系统消息写到对应会话里（"📞 来电（语音/视频）— 请用手机接听"），
  //      让销售在 inbox 能一眼看到「客户刚打过电话」，并提示自己去手机回拨；
  //   3) 群组通话忽略。
  client.on('call', async (call: any) => {
    try {
      const serialized: string = call?.from || call?.peerJid || '';
      if (!serialized) return;
      if (serialized.includes('@g.us')) return;
      if (isSystemAccount(serialized)) return;

      const isVideo = !!call?.isVideo;
      const isGroup = !!call?.isGroup;
      if (isGroup) return;

      // 默认拒接，避免无人值守时 web 端一直响。可通过环境变量关掉。
      if (process.env.WA_AUTO_REJECT_CALLS !== '0') {
        try {
          await call.reject?.();
        } catch {
          /* ignore */
        }
      }

      const convId = normalizeConversationId(serialized);
      if (!convId) return;
      const canonical = resolveAlias(convId);
      const ts = (call?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;
      const kind = isVideo ? '视频通话' : '语音通话';
      await appendIncoming({
        conversationId: canonical,
        text: `📞 来电（${kind}）— 请用手机或官方桌面客户端回拨`,
        timestamp: ts,
        id: `wweb_call_${call?.id ?? ts}`
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[wa-personal] call handler error', e);
    }
  });

  // 表情 reaction：whatsapp-web.js 在对方加 / 删 reaction 时会触发 `message_reaction`。
  // 我们把它落到本地消息的 reactions[] 里，让前端能像 WA 一样在气泡下方显示 emoji 小芯片。
  client.on('message_reaction', async (reaction: any) => {
    try {
      const targetSer: string | undefined = reaction?.msgId?._serialized ?? reaction?.msgId?.id;
      if (!targetSer) return;
      // 优先用 waMessageId 反查；historical 消息和 inbound 消息都已经填了这个字段
      let local = await getMessageByWaId(targetSer);
      if (!local) {
        // 兼容旧数据：inbound 的本地 id 就是 wweb_<_serialized>
        local = await getMessageById(`wweb_${targetSer}`);
      }
      if (!local) return;
      const fromMe = !!reaction?.id?.fromMe || !!reaction?.senderId?.fromMe;
      const senderSer: string | undefined =
        reaction?.senderId?._serialized ?? reaction?.senderId?.id;
      await setReaction(local.id, {
        emoji: typeof reaction?.reaction === 'string' ? reaction.reaction : '',
        from: fromMe ? 'me' : 'them',
        ts: (reaction?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
        senderId: senderSer
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[wa-personal] reaction handler error', e);
    }
  });

  // 已读回执：whatsapp-web.js 会在送达 / 已读时触发 `message_ack`。
  // ack 数值：-1 error, 0 pending, 1 sent (服务端), 2 delivered (设备), 3 read, 4 played (语音/视频)
  // 我们映射到 store 的 status：1→sent, 2→delivered, 3/4→read。
  client.on('message_ack', async (msg: any, ack: number) => {
    try {
      const ser: string | undefined = msg?.id?._serialized ?? msg?.id?.id;
      if (!ser) return;
      // 只关心自己发的消息：对方的回执对我们没有展示意义
      if (msg?.id?.fromMe === false) return;
      const next: 'sent' | 'delivered' | 'read' | undefined =
        ack >= 3 ? 'read' : ack === 2 ? 'delivered' : ack === 1 ? 'sent' : undefined;
      if (!next) return;
      // 先 waMessageId 反查，再尝试旧的 wweb_ 前缀
      const local = (await getMessageByWaId(ser)) ?? (await getMessageById(`wweb_${ser}`));
      if (!local) return;
      // 单调推进：read 不应被 delivered 覆盖
      const rank: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 };
      if ((rank[local.status ?? ''] ?? 0) >= (rank[next] ?? 0)) return;
      await updateMessage(local.id, { status: next });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[wa-personal] ack handler error', e);
    }
  });
}

/**
 * 历史回灌：扫描最近 N 个会话，每个拉最近 M 条消息写入本地 store。
 * - 调用幂等：按 msg.id 去重，重复执行不会膨胀数据
 * - 不增 unread；不抓媒体（图片体积大、首次回灌慢），仅保留 [图片] 占位
 * - 每个会话失败不影响其它，全程错误进 backfill.error
 */
async function backfillRecentChats(
  client: WwebClient,
  opts: { maxChats?: number; perChat?: number } = {}
): Promise<void> {
  const h = holder();
  const envMaxChats = Number.parseInt(process.env.WA_BACKFILL_MAX_CHATS ?? '', 10);
  const envPerChat = Number.parseInt(process.env.WA_BACKFILL_PER_CHAT ?? '', 10);
  // 默认拉得足够多：WhatsApp Web 本身缓存上限在这个量级。
  // 业务现场需要「交接给同事也能看到全部历史联系人」，不敢裁少。
  const maxChats = opts.maxChats ?? (Number.isFinite(envMaxChats) && envMaxChats > 0 ? envMaxChats : 1000);
  const perChat = opts.perChat ?? (Number.isFinite(envPerChat) && envPerChat > 0 ? envPerChat : 200);
  h.backfill = {
    state: 'running',
    chatsTotal: 0,
    chatsDone: 0,
    messagesInserted: 0,
    startedAt: Date.now(),
    finishedAt: null
  };

  const chats: any[] = await client.getChats();
  // 按时间倒序取前 N
  chats.sort((a, b) => (b?.timestamp ?? 0) - (a?.timestamp ?? 0));
  const targets = chats
    .filter((c) => {
      const id: string = c?.id?._serialized ?? '';
      if (!id) return false;
      if (id.includes('status@')) return false;
      if (id.endsWith('@newsletter')) return false;
      if (id.endsWith('@broadcast')) return false;
      if (id.endsWith('@g.us')) return false; // 群暂不回灌
      return true;
    })
    .slice(0, maxChats);

  h.backfill.chatsTotal = targets.length;

  for (const chat of targets) {
    try {
      const serialized: string = chat?.id?._serialized ?? '';
      const convIdRaw = normalizeConversationId(serialized);
      let convId = resolveAlias(convIdRaw);
      if (!convId) {
        continue;
      }
      // 拉联系人名（一次即可）
      let name: string | undefined;
      try {
        const contact = await chat.getContact?.();
        name = contact?.name || contact?.pushname || contact?.shortName;
        const phone: string | undefined =
          (typeof contact?.number === 'string' && contact.number) ||
          (contact?.id?.server === 'c.us' && typeof contact?.id?.user === 'string'
            ? contact.id.user
            : undefined);
        const phoneId = phone?.replace(/\D/g, '') ?? '';
        if (phoneId && phoneId !== convIdRaw) {
          const fromCanonical = resolveAlias(convIdRaw);
          const phoneCanonical = resolveAlias(phoneId);
          if (fromCanonical === convIdRaw && phoneCanonical === phoneId) {
            await addAlias(convIdRaw, phoneId);
            convId = phoneId;
          } else {
            convId = fromCanonical === convIdRaw ? phoneCanonical : fromCanonical;
          }
        }
      } catch {
        /* ignore */
      }

      const msgs: any[] = await chat.fetchMessages({ limit: perChat });
      for (const m of msgs) {
        try {
          // 跳过系统通知
          if (m?.type === 'notification_template' || m?.type === 'e2e_notification') continue;
          const stableId = `wweb_${m?.id?._serialized ?? m?.id?.id ?? `${convId}_${m?.timestamp}`}`;
          const text: string | undefined = typeof m?.body === 'string' && m.body ? m.body : undefined;
          const hasImage = m?.hasMedia && (m?.type === 'image' || m?.type === 'sticker');
          // 历史回灌也捕获引用关系，让早期对话里的「你 / xxx」气泡能正确显示
          let quotedMessageId: string | undefined;
          let quoteText: string | undefined;
          try {
            if (m?.hasQuotedMsg) {
              const q = await m.getQuotedMessage();
              const qSer: string | undefined = q?.id?._serialized ?? q?.id?.id;
              if (qSer) quotedMessageId = `wweb_${qSer}`;
              const raw: string | undefined =
                typeof q?.body === 'string' && q.body ? q.body : undefined;
              quoteText = raw
                ? raw.length > 140 ? `${raw.slice(0, 140)}…` : raw
                : q?.hasMedia
                ? q?.type === 'video' || q?.type === 'ptv'
                  ? '[视频]'
                  : '[图片]'
                : undefined;
            }
          } catch {
            /* ignore */
          }
          // 历史回灌不下载媒体，占位即可（避免首次回灌几十 MB）
          const result = await upsertHistoricalMessage({
            id: stableId,
            conversationId: convId,
            direction: m?.fromMe ? 'out' : 'in',
            type: hasImage ? 'image' : 'text',
            text: text ?? (hasImage ? '[图片]' : undefined),
            imageUrls: undefined,
            timestamp: (m?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
            status: m?.fromMe ? 'sent' : undefined,
            waMessageId: m?.id?._serialized ?? m?.id?.id,
            quotedMessageId,
            quoteText,
            name
          });
          if (result.inserted) h.backfill.messagesInserted += 1;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[wa-personal] backfill msg failed', e);
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[wa-personal] backfill chat failed', e);
    } finally {
      h.backfill.chatsDone += 1;
    }
  }

  h.backfill.state = 'done';
  h.backfill.finishedAt = Date.now();

  // 顺手把通讯录里所有真实联系人也补成空会话条目，避免「只看到几个聊天过的人」。
  // 失败不影响主流程（通讯录可能因 WA Web 限流读取失败）。
  importAllContacts().catch(() => undefined);
}

/**
 * 把 WhatsApp 通讯录里**所有**联系人都补成空会话条目，让侧栏一眼能看全：
 * - 跳过 me / 群 / 广播 / 业务账户标签
 * - 已存在的会话只补 name
 * - 不创建任何消息
 * 返回新增数量。
 */
export async function importAllContacts(): Promise<{ added: number; total: number; reason?: string }> {
  const h = holder();
  if (!h.client || h.state !== 'ready') {
    return { added: 0, total: 0, reason: `client not ready (${h.state})` };
  }
  try {
    const contacts: any[] = await h.client.getContacts();
    const entries: { id: string; name?: string }[] = [];
    for (const c of contacts) {
      const id: string = c?.id?._serialized ?? '';
      if (!id) continue;
      if (c?.isMe) continue;
      if (c?.isGroup) continue;
      if (id.endsWith('@broadcast')) continue;
      if (id.endsWith('@newsletter')) continue;
      if (isSystemAccount(id)) continue;
      // 只导入「我加过的」+ 有名字的联系人，避免把整个 WA 用户池都灌进来
      // c.isMyContact === true 表示在用户通讯录里
      if (c?.isMyContact !== true) continue;
      const name: string =
        c?.name || c?.pushname || c?.shortName || (c?.number ? `+${c.number}` : '');
      // 关键：必须与消息事件里的 normalizeConversationId 完全一致，否则
      // 「通讯录里的张三」和「张三发来的消息」会落在两个不同的 conversationId 上，
      // 表现为侧栏看到两个张三（一个有头像无聊天，一个有聊天没名字）。
      // - c.us → 去后缀，纯 phone 数字
      // - lid / 其它 → 保留完整 serialized
      const rawId = id.endsWith('@c.us')
        ? String(c?.id?.user ?? '').replace(/\D/g, '')
        : id;
      if (!rawId) continue;
      // 再过一道 alias，已被用户合并的联系人直接落到 canonical 槽，避免重复创建
      const canonicalId = resolveAlias(rawId);
      entries.push({ id: canonicalId, name: name || undefined });
    }
    const { added } = await ensureEmptyConversations(entries);
    return { added, total: entries.length };
  } catch (e: any) {
    return { added: 0, total: 0, reason: e?.message ?? String(e) };
  }
}

export async function startPersonalClient(opts?: { useProxy?: boolean; force?: boolean }): Promise<PersonalState> {
  const h = holder();
  // 确保进程退出时能干净关闭 Chromium（避免脏 profile 导致下次启动 execution context destroyed）
  registerShutdownHooks();
  // force=true：跳过「已 ready 直接返回」的捷径，强制销毁旧 client 并重建。
  // 用于「Web 会话僵尸化」场景：state 仍是 ready 但 wweb 内部 Store 已失效，
  // 表现是发出 `Cannot read properties of undefined (reading 'getChat')`、收不到新消息等。
  if (!opts?.force && h.client &&
    (h.state === 'ready' ||
      h.state === 'qr' ||
      h.state === 'initializing' ||
      h.state === 'authenticated')
  ) {
    // 已 ready 时，允许通过再次 start 触发一次历史回灌（幂等 upsert）。
    if (h.state === 'ready' && h.backfill.state !== 'running') {
      backfillRecentChats(h.client).catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[wa-personal] backfill failed', e);
        h.backfill.state = 'error';
        h.backfill.error = e instanceof Error ? e.message : String(e);
        h.backfill.finishedAt = Date.now();
      });
    }
    return h.state;
  }

  // 之前 auth_failure / disconnected：先彻底销毁旧 client，免得浏览器进程残留锁住 userDataDir
  if (h.client) {
    try {
      await h.client.destroy();
    } catch {
      /* ignore */
    }
    h.client = null;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client, LocalAuth } = require('whatsapp-web.js');

  const dataPath = path.join(process.cwd(), 'data', '.wwebjs_auth');
  // 走当前激活 profile：default -> 'default' (与以前相同)，其他会落在 .wwebjs_auth/session-<id>/
  const profileId = await getActiveProfileId();
  const clientId = getProfileClientId(profileId);
  // 清理上次崩溃残留的 Chromium 单例锁，否则 puppeteer 报 "browser is already running"
  const sessionDir = getProfileSessionDir(profileId);
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await fs.rm(path.join(sessionDir, f), { force: true }).catch(() => undefined);
  }

  const executablePath = resolveChromiumPath();
  const proxyServer = resolveProxyServer(opts);
  const proxyBypass = proxyServer ? process.env.WA_PROXY_BYPASS : undefined;
  // 记住本次是否主动禁用了代理，以便状态接口汇报。
  h.proxy = {
    configured: Boolean(configuredProxyServer()),
    inUse: proxyServer ?? null,
    explicitlyDisabled: opts?.useProxy === false
  };

  // 启动前先快速探测代理可达性：失败就立刻报“代理不可达”，避免 Chromium 等 180s
  if (proxyServer) {
    const probe = await probeProxyReachable(proxyServer);
    if (!probe.ok) {
      h.state = 'auth_failure';
      h.lastError = `代理不可达：WA_PROXY_SERVER=${proxyServer}（${probe.reason}）。请确认该代理在运行并能打开 web.whatsapp.com；或在页面上取消勾选「通过代理启动」后重试。`;
      // eslint-disable-next-line no-console
      console.warn('[wa-personal] proxy preflight failed:', h.lastError);
      return h.state;
    }
  }

  const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu'
  ];
  if (proxyServer) puppeteerArgs.push(`--proxy-server=${proxyServer}`);
  if (proxyBypass) puppeteerArgs.push(`--proxy-bypass-list=${proxyBypass}`);

  // 网络慢 / VPN / 代理场景下 WA Web 可能要很久才加载完；
  // 默认 Puppeteer 超时只有 30s，改成 180s 减少 "Runtime.callFunctionOn timed out" 报错
  const client = new Client({
    authStrategy: new LocalAuth({ clientId, dataPath }),
    // whatsapp-web.js 自身的超时参数
    authTimeoutMs: 180_000, // 扫码 / 自动登录等待
    qrMaxRetries: 5, // QR 失效后最多刷新几次
    takeoverOnConflict: true, // 如果手机端提示"其他地方登录"，自动接管
    puppeteer: {
      headless: true,
      executablePath,
      protocolTimeout: 180_000, // CDP 协议超时
      timeout: 120_000, // 页面导航超时
      args: puppeteerArgs
    }
  });

  h.client = client;
  h.state = 'initializing';
  h.startedAt = Date.now();
  h.lastError = null;

  await attachEvents(client);

  client.initialize().catch(async (e: any) => {
    h.state = 'auth_failure';
    h.lastError = normalizeStartupError(e?.message ?? String(e));
    // 立即销毁，免得下次 start 又撞锁
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
    h.client = null;
    // 初始化失败（网络 / 浏览器崩溃）同样退避重试
    if (!h.reconnect.disabled) scheduleReconnect('init-failed');
  });

  return h.state;
}

export async function logoutPersonalClient(opts?: { wipeSession?: boolean }): Promise<void> {
  const h = holder();
  // 主动 logout 应防止后续重连“又弹 QR 页”
  cancelReconnect(true);
  const profileId = await getActiveProfileId();
  if (h.client) {
    // 需要抹掉磁盘 session 时才调 logout()；whatsapp-web.js 的 logout() 会同时 destroy 并清除 LocalAuth 目录。
    // 默认（保留 session）时只调 destroy()，文件保留在盘上，下次启动可免扫。
    if (opts?.wipeSession) {
      try {
        await h.client.logout();
      } catch {
        /* ignore */
      }
    }
    try {
      await h.client.destroy();
    } catch {
      /* ignore */
    }
  }
  h.client = null;
  h.state = 'idle';
  h.qrDataUrl = null;
  h.qrText = null;
  h.me = null;
  h.lastError = null;
  h.startedAt = null;
  // logout 完成后重新允许下一次手动 start 后的重连
  h.reconnect.disabled = false;
  // wipeSession=true 时手动再抹一遍子目录，避免库里的 logout() 在某些状态下没清干净。
  if (opts?.wipeSession) {
    await wipeProfileSession(profileId);
  }
}

export function getPersonalStatus() {
  const h = holder();
  const profileId = getActiveProfileIdSyncSafe();
  const sessionDir = getProfileSessionDir(profileId);
  const hasSession = existsSync(sessionDir);
  return {
    state: h.state,
    qr: h.qrDataUrl,
    me: h.me,
    lastError: h.lastError,
    startedAt: h.startedAt,
    session: {
      profileId,
      hasSession,
      invalid: isSavedSessionInvalid(h.state, h.lastError, hasSession),
      dir: path.relative(process.cwd(), sessionDir)
    },
    backfill: h.backfill,
    reconnect: {
      attempts: h.reconnect.attempts,
      nextAttemptAt: h.reconnect.nextAttemptAt
    },
    proxy: {
      configured: Boolean(configuredProxyServer()),
      configuredServer: configuredProxyServer() ?? null,
      // 本次启动实际生效的代理（null = 未走代理）
      inUse: h.proxy?.inUse ?? null,
      explicitlyDisabled: Boolean(h.proxy?.explicitlyDisabled)
    }
  };
}

function getActiveProfileIdSyncSafe(): string {
  try {
    return getActiveProfileIdSync();
  } catch {
    return 'default';
  }
}

export function isPersonalReady(): boolean {
  return holder().state === 'ready';
}

export async function sendPersonalText(
  to: string,
  text: string,
  options?: { quotedMessageId?: string }
): Promise<{ ok: boolean; reason?: string; waMessageId?: string }> {
  const h = holder();
  if (!h.client || h.state !== 'ready') {
    return { ok: false, reason: `client not ready (${h.state})` };
  }
  // 路由表：纯数字 id 可能是 LID（必须 @lid）或电话（@c.us），先查历史命中
  const { resolveSendChatId, altChatId, markSendSuccess } = await import('./send-routing');
  const primary = await resolveSendChatId(to);
  const sendOpts = buildQuotedOpts(options?.quotedMessageId);
  try {
    const sent = await sendMessageWithRetry(h.client, primary, text, sendOpts);
    await markSendSuccess(to, primary);
    return { ok: true, waMessageId: extractWaMessageId(sent) };
  } catch (e: any) {
    const reason = e?.message ?? String(e);
    const alt = altChatId(primary);
    if (alt && isAddressingError(reason)) {
      try {
        const sent = await sendMessageWithRetry(h.client, alt, text, sendOpts);
        await markSendSuccess(to, alt);
        return { ok: true, waMessageId: extractWaMessageId(sent) };
      } catch (e2: any) {
        const r2 = e2?.message ?? String(e2);
        return {
          ok: false,
          reason: `primary(${primary}) ${toFriendlySendError(reason)}; alt(${alt}) ${toFriendlySendError(r2)}`
        };
      }
    }
    return { ok: false, reason: toFriendlySendError(reason) };
  }
}

export async function sendPersonalImage(
  to: string,
  imageUrl: string,
  caption?: string,
  options?: { quotedMessageId?: string }
): Promise<{ ok: boolean; reason?: string; waMessageId?: string }> {
  return sendPersonalMedia(to, imageUrl, caption, options);
}

/**
 * 发送任意媒体（图片 / 视频 / 文件）。
 * - data:URL 会从 MIME 前缀自动识别类型，whatsapp-web.js 会正确发出
 * - http(s) URL 走 MessageMedia.fromUrl，需服务端能拉到
 */
export async function sendPersonalMedia(
  to: string,
  mediaUrl: string,
  caption?: string,
  options?: { quotedMessageId?: string }
): Promise<{ ok: boolean; reason?: string; waMessageId?: string }> {
  const h = holder();
  if (!h.client || h.state !== 'ready') {
    return { ok: false, reason: `client not ready (${h.state})` };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MessageMedia } = require('whatsapp-web.js');
    const media = mediaUrl.startsWith('data:')
      ? new MessageMedia(
          mediaUrl.slice(5, mediaUrl.indexOf(';')),
          mediaUrl.slice(mediaUrl.indexOf(',') + 1)
        )
      : await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
    const { resolveSendChatId, altChatId, markSendSuccess } = await import('./send-routing');
    const primary = await resolveSendChatId(to);
    const quotedOpts = buildQuotedOpts(options?.quotedMessageId);
    const opts = { ...(caption ? { caption } : {}), ...quotedOpts };
    try {
      const sent = await sendMessageWithRetry(h.client, primary, media, opts);
      await markSendSuccess(to, primary);
      return { ok: true, waMessageId: extractWaMessageId(sent) };
    } catch (e: any) {
      const reason = e?.message ?? String(e);
      const alt = altChatId(primary);
      if (alt && isAddressingError(reason)) {
        const sent = await sendMessageWithRetry(h.client, alt, media, opts);
        await markSendSuccess(to, alt);
        return { ok: true, waMessageId: extractWaMessageId(sent) };
      }
      throw e;
    }
  } catch (e: any) {
    return { ok: false, reason: toFriendlySendError(e?.message ?? String(e)) };
  }
}

/**
 * 本地 inbound 消息 id 是 `wweb_<msg.id._serialized>`；whatsapp-web.js 需要原始 `_serialized`。
 * Outbound 消息记录 waMessageId（也是 `_serialized`）后，/api/wa/send 会在调本函数前将
 * `out_*` 本地 id 替换为该 waMessageId。本函数只负责「拿到什么就传什么」。
 */
function buildQuotedOpts(rawId?: string): { quotedMessageId?: string } {
  if (!rawId) return {};
  if (rawId.startsWith('wweb_')) return { quotedMessageId: rawId.slice(5) };
  if (rawId.startsWith('out_') || rawId.startsWith('in_')) return {};
  return { quotedMessageId: rawId };
}

/** 从 whatsapp-web.js sendMessage 返回的 Message 对象里抽 `_serialized` id；拿不到返 undefined。 */
function extractWaMessageId(sent: any): string | undefined {
  return sent?.id?._serialized ?? sent?.id?.id ?? undefined;
}

export type PersonalChatKind = 'phone' | 'lid' | 'group';

export type PersonalChat = {
  /** whatsapp-web.js 的完整 serialized id，永远可以直接传给 sendMessage */
  chatId: string;
  /** 仅当 kind=phone 时为真实 E.164（无 +）；LID 时为 15 位 LID（不可拨打） */
  waId: string;
  /** 类型：phone = 正常电话号；lid = 隐私模式联系人（仅能用 chatId 寻址）；group = 群 */
  kind: PersonalChatKind;
  name: string;
  /** LID 联系人的真实电话号（如果能从 WhatsApp 竔出谁的）；仅用于展示 */
  resolvedPhone?: string;
  unread: number;
  lastTimestamp: number; // ms
  lastMessage?: string;
};

/**
 * 列出已登录账号的最近会话 / 联系人。
 * 关键设计：
 * - 永远返回 `chatId`（完整 serialized id），sendMessage 直接用它，不再尝试 LID→phone 转换。
 *   whatsapp-web.js 接受 `<lid>@lid` 作为收件人。
 * - `waId` 字段仅在 kind=phone 时是真实电话号，UI 用它显示 +xxx。
 * - 过滤掉 newsletter（WhatsApp 频道，如 Real Madrid C.F.）、broadcast、status。
 * - 默认过滤群；不过滤 LID（用户需要给这些联系人发消息）。
 */
export async function listPersonalChats(opts?: {
  limit?: number;
  includeGroups?: boolean;
}): Promise<{ ok: boolean; chats?: PersonalChat[]; reason?: string }> {
  const h = holder();
  if (!h.client || h.state !== 'ready') {
    return { ok: false, reason: `client not ready (${h.state})` };
  }
  try {
    const chats: any[] = await h.client.getChats();
    const limit = opts?.limit ?? 100;
    const result: PersonalChat[] = [];
    chats.sort((a, b) => (b?.timestamp ?? 0) - (a?.timestamp ?? 0));

    for (const c of chats) {
      const id: string = c?.id?._serialized ?? '';
      if (!id) continue;
      // 过滤掉非聊天实体
      if (
        id.includes('status@') ||
        id.endsWith('@newsletter') || // WhatsApp Channels（频道）如 Real Madrid C.F.
        id.endsWith('@broadcast')
      )
        continue;
      const isGroup = id.endsWith('@g.us');
      if (isGroup && !opts?.includeGroups) continue;
      const isLid = id.endsWith('@lid');
      const isPhone = id.endsWith('@c.us');
      if (!isGroup && !isLid && !isPhone) continue;

      const kind: PersonalChatKind = isGroup ? 'group' : isLid ? 'lid' : 'phone';
      const idUser = String(c?.id?.user ?? '').replace(/\D/g, '');
      let waId = idUser;
      let name: string = c?.name || c?.formattedTitle || '';
      let resolvedPhoneForLid: string | undefined;

      // 仅当不是 LID 时，尝试通过 contact 拿真实电话号 / 通讯录姓名
      if (!isLid && !isGroup) {
        if (!/^\d{5,15}$/.test(waId)) {
          try {
            const contact = await c.getContact();
            if (contact?.number && /^\d{5,15}$/.test(String(contact.number))) {
              waId = String(contact.number);
            }
          } catch {
            /* ignore */
          }
        }
        if (!name) {
          try {
            const contact = await c.getContact();
            name = contact?.pushname || contact?.name || contact?.shortName || '';
          } catch {
            /* ignore */
          }
        }
      } else if (isLid) {
        // ★ 关键：WhatsApp 隐私改版后大量联系人都以 LID 寻址，但其实能拿到真实电话号。
        // 这里主动走一道 contact.getContact()，不仅补 name，还竔 number 到 resolvedPhone，
        // 让设置页控制台能显示“你朝友实际是哪个 +xx”。
        try {
          const contact = await c.getContact();
          if (!name) name = contact?.pushname || contact?.name || contact?.shortName || '';
          const phone =
            (typeof contact?.number === 'string' && contact.number) ||
            (contact?.id?.server === 'c.us' && typeof contact?.id?.user === 'string'
              ? contact.id.user
              : undefined);
          if (phone) {
            const digits = String(phone).replace(/\D/g, '');
            if (/^\d{5,15}$/.test(digits)) resolvedPhoneForLid = digits;
          }
        } catch {
          /* ignore */
        }
      }

      if (!name) name = kind === 'phone' ? `+${waId}` : kind === 'lid' ? `私密联系人` : id;

      result.push({
        chatId: id,
        waId,
        kind,
        name,
        resolvedPhone: resolvedPhoneForLid,
        unread: c?.unreadCount ?? 0,
        lastTimestamp: (c?.timestamp ?? 0) * 1000,
        lastMessage:
          typeof c?.lastMessage?.body === 'string' ? c.lastMessage.body.slice(0, 80) : undefined
      });
      if (result.length >= limit) break;
    }
    return { ok: true, chats: result };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

/**
 * 校验某个号码是否注册了 WhatsApp。
 * 用 client.isRegisteredUser() —— 这能在「发送前」就告诉用户号码无效，
 * 比起依赖 sendMessage 抛 "No LID for user" 友好得多。
 */
export async function checkPersonalNumber(waId: string): Promise<{
  ok: boolean;
  registered?: boolean;
  reason?: string;
}> {
  const h = holder();
  if (!h.client || h.state !== 'ready') {
    return { ok: false, reason: `client not ready (${h.state})` };
  }
  const clean = waId.replace(/\D/g, '');
  if (!clean) return { ok: false, reason: '号码为空' };
  try {
    const registered: boolean = await h.client.isRegisteredUser(waIdToChatId(clean));
    return { ok: true, registered };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

/**
 * 给一条消息加 / 取消 emoji reaction（类似 WA 长按消息的表情）。
 * - `emoji=''` 表示取消我之前的 reaction
 * - 本地 store 会立刻乐观更新一份（from='me'），WA 回调到 message_reaction 时会再同步一次
 */
export async function sendReaction(
  localMsgId: string,
  emoji: string
): Promise<{ ok: boolean; reason?: string }> {
  const h = holder();
  if (!h.client || h.state !== 'ready') {
    return { ok: false, reason: `client not ready (${h.state})` };
  }
  const local = await getMessageById(localMsgId);
  if (!local) return { ok: false, reason: '本地消息不存在' };
  const waId = local.waMessageId;
  if (!waId) return { ok: false, reason: '该消息没有 WA id（可能是旧数据或本地占位消息）' };
  try {
    const wm: any = await h.client.getMessageById(waId);
    if (!wm) return { ok: false, reason: 'WA 服务端找不到该消息' };
    await wm.react(emoji ?? '');
    // 乐观更新本地，避免等回调时 UI 看不到效果
    await setReaction(localMsgId, { emoji: emoji ?? '', from: 'me', ts: Date.now() });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

/**
 * 把一条消息转发到一个或多个会话（类似 WA 的转发箭头）。
 * 优先使用 whatsapp-web.js `Message.forward(chat)`（会保留媒体、转发标签）；
 * 任意一个目标失败不影响其它目标。
 */
export async function forwardMessage(
  localMsgId: string,
  toChatIds: string[]
): Promise<{
  ok: boolean;
  reason?: string;
  results: Array<{ to: string; ok: boolean; reason?: string }>;
}> {
  const h = holder();
  if (!h.client || h.state !== 'ready') {
    return { ok: false, reason: `client not ready (${h.state})`, results: [] };
  }
  const local = await getMessageById(localMsgId);
  if (!local) return { ok: false, reason: '本地消息不存在', results: [] };
  const waId = local.waMessageId;
  if (!waId) return { ok: false, reason: '该消息没有 WA id，无法转发', results: [] };
  let wm: any;
  try {
    wm = await h.client.getMessageById(waId);
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e), results: [] };
  }
  if (!wm) return { ok: false, reason: 'WA 服务端找不到该消息', results: [] };

  const { resolveSendChatId, markSendSuccess } = await import('./send-routing');
  const results: Array<{ to: string; ok: boolean; reason?: string }> = [];
  for (const raw of toChatIds) {
    try {
      const chatId = await resolveSendChatId(raw);
      const chat = await h.client.getChatById(chatId);
      await wm.forward(chat);
      await markSendSuccess(raw, chatId);
      results.push({ to: raw, ok: true });
    } catch (e: any) {
      results.push({ to: raw, ok: false, reason: toFriendlySendError(e?.message ?? String(e)) });
    }
  }
  return { ok: results.some((r) => r.ok), results };
}
