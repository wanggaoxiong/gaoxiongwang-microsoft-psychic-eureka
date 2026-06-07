'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button, Input, Badge, Empty, Card } from '@/lib/ui/primitives';
import { loadWaConfig, isWaConfigured, type WaConfig } from '@/lib/wa/config';
import { loadAiConfig, isAiConfigured, getEffectiveSearchModel, getEffectiveModel } from '@/lib/ai/config';
import {
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  type LangCode
} from '@/lib/i18n/languages';
import type { CatalogProduct } from '@/lib/catalog/repo';
import { buildCollage } from '@/lib/images/collage';

type Conversation = {
  id: string;
  name?: string;
  lastMessage?: string;
  lastTimestamp?: number;
  unread: number;
  pinned?: boolean;
  /** 发出语言锁：发送时如果不为空，会先把任意输入翻译成此语言再发出 */
  outputLang?: string;
  /** 会话级 AI 自动化档位；空 = 跟随全局 defaultMode */
  autoMode?: 'OFF' | 'SUGGEST' | 'DRAFT_AUTO' | 'AUTO_SAFE' | 'AUTO_FULL';
  /** DRAFT_AUTO 模式下，服务端写的 AI 草稿；前端见到就填进输入框并请求清除 */
  aiDraft?: { text: string; lang?: string; createdAt: number; basedOnMessageId?: string };
  /** 销售漏斗阶段（与 lib/ai/sales-stage.ts 对齐）；不设默认 S1 */
  salesStage?: 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7';
  /** AI 抽取的偏好槽位；员工可改 */
  slots?: {
    category?: string;
    occasion?: string;
    colorPref?: string;
    priceBand?: string;
    audience?: string;
  };
  /** 客户温度灯 */
  leadTemperature?: 'cold' | 'warm' | 'hot';
  /** 待人工介入（如 S5 报价需人工核价/出 PI）；销售手动回复后清除 */
  needsHuman?: boolean;
  needsHumanReason?: string;
  needsHumanAt?: number;
};

type Message = {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  type: 'text' | 'image' | 'video';
  text?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  productTitle?: string;
  productId?: string;
  quoteText?: string;
  /** 引用的源消息是图片时，后端会下载后填入 data URL，供气泡内缩略图 + AI 以图搜图复用。 */
  quoteImageUrl?: string;
  /** 被引用的源消息 id（本地 store id）；后端负责折成 WA 原生 quoted reply */
  quotedMessageId?: string;
  /** 表情 reactions（与 WA 一样：每个发送方最多一个 emoji） */
  reactions?: Array<{ emoji: string; from: 'me' | 'them'; ts: number; senderId?: string }>;
  timestamp: number;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
  aiAuto?: boolean;
  aiSource?: 'human' | 'suggest-click' | 'auto-safe' | 'auto-full';
  aiReason?: string;
};

type AutoMode = 'OFF' | 'SUGGEST' | 'DRAFT_AUTO' | 'AUTO_SAFE' | 'AUTO_FULL';
const AUTO_MODE_ITEMS: Array<{ value: AutoMode; label: string; short: string }> = [
  { value: 'OFF', label: '关闭', short: '关' },
  { value: 'SUGGEST', label: '仅建议', short: '建议' },
  { value: 'DRAFT_AUTO', label: '半自动起草', short: '半自动' },
  { value: 'AUTO_SAFE', label: '安全自动', short: '安全自动' },
  { value: 'AUTO_FULL', label: '全自动', short: '全自动' }
];

export default function InboxPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#F7F8FB]" />}>
      <InboxPageContent />
    </Suspense>
  );
}

function InboxPageContent() {
  const search = useSearchParams();
  const [waConfig, setWaConfig] = useState<WaConfig | null>(null);
  const [autopilot, setAutopilot] = useState<{
    killSwitch: boolean;
    defaultMode: AutoMode;
    pausedUntil: Record<string, number>;
  } | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const needsHumanCount = conversations.filter((c) => c.needsHuman).length;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  /** 当前要「引用」的原消息；null = 不引用。发送后自动清除，切会话也清除。 */
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  /** 当前要转发的消息；非空时弹出转发选择面板 */
  const [forwardTarget, setForwardTarget] = useState<Message | null>(null);
  /** 粘贴/上传的未发送媒体（data URL）；Enter 后随文本一起发出 */
  const [pendingMedia, setPendingMedia] = useState<{ kind: 'image' | 'video'; url: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** 历史回灌状态提示，由 /api/wa/personal/status 轮询 */
  const [backfill, setBackfill] = useState<{
    state: 'idle' | 'running' | 'done' | 'error';
    chatsDone?: number;
    chatsTotal?: number;
    messagesInserted?: number;
    error?: string;
  } | null>(null);
  /** 「完成」横幅是否当前要显示。state===done 仅短暂提示几秒后自动消失，避免遮挡聊天界面。 */
  const [showBackfillDone, setShowBackfillDone] = useState(false);
  /** 个人号（QR）是否已登录。不是商业号 Cloud API，但同样可收发，才不会误报「未配置」。 */
  const [personalReady, setPersonalReady] = useState(false);
  /** 可选：个人号的显示名（push name），用于顶部子标题 */
  const [personalLabel, setPersonalLabel] = useState<string | null>(null);
  const [showCatalog, setShowCatalog] = useState(false);
  /** 新建会话弹窗：手动输入电话号开启聊天 */
  const [showNewChat, setShowNewChat] = useState(false);
  /** 加入重点客户弹窗（基于当前 active 会话预填） */
  const [showAddContact, setShowAddContact] = useState(false);
  /** AI 识别当前会话弹窗 */
  const [showAiExtract, setShowAiExtract] = useState(false);
  /** 选中商品后的发送面板：编辑文案 / 选图 / 选模式 */
  const [sendPanel, setSendPanel] = useState<{ product: CatalogProduct; lang: LangCode } | null>(
    null
  );
  /** 发送面板按需翻译状态：正在翻译哪个语言 / 错误 */
  const [panelTranslating, setPanelTranslating] = useState<LangCode | null>(null);
  const [panelTranslateError, setPanelTranslateError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  /**
   * Compose 区域的辅助 UI 状态：附件上传、表情、快捷话术。
   * 都是纯前端状态，没有持久化（除快捷话术存 localStorage）。
   */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  /**
   * 用于「点击外部自动关闭」的容器引用。
   * 每个浮层（trigger + panel）都包在自己的 ref 容器里，
   * mousedown 不在容器内就关闭，避免「只能用按钮再次点击才能退出」。
   */
  const emojiWrapRef = useRef<HTMLDivElement>(null);
  const quickRepliesWrapRef = useRef<HTMLDivElement>(null);
  /** 常用表情，覆盖业务场景（问候/确认/物流/价格/产品） */
  const EMOJI_SET = useMemo(
    () => [
      '👋','😊','👍','🙏','❤️','🔥','✅','❌','💯','🎉',
      '😂','🤝','💪','📦','🚚','💵','💎','✨','🌟','📷',
      '🎁','⏰','📩','🔔','🤔','🙋','📝','📞','🛒','🎯'
    ],
    []
  );
  /**
   * 快捷话术条目：原文 (text，作为唯一 key) + 各语言翻译缓存 (loc)。
   * 旧版（v1）存的是 string[]，挂载时一次性升级为新版结构。
   */
  type QuickReply = { text: string; loc?: Partial<Record<LangCode, string>> };
  const QUICK_REPLY_STORAGE_V2 = 'wa.quick-replies.v2';
  const QUICK_REPLY_STORAGE_V1 = 'wa.quick-replies.v1';
  const DEFAULT_QUICK_REPLIES: string[] = useMemo(
    () => [
      '您好，请稍等，我看一下',
      '好的，没问题 👍',
      '已发送，请查收',
      '请问您需要多少件？发到哪里？',
      '感谢您的关注 🙏',
      '请稍等，我确认一下库存'
    ],
    []
  );
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  /** 快捷话术当前展示语言（默认中文） */
  const [qrLang, setQrLang] = useState<LangCode>('zh');
  /** 翻译进行中（避免重复触发 + UI 显示 loading） */
  const [qrTranslating, setQrTranslating] = useState(false);
  const [qrTranslateError, setQrTranslateError] = useState<string | null>(null);
  /** 手动新增话术输入框 */
  const [qrManualInput, setQrManualInput] = useState('');
  /** AI 生成快捷话术的子流程状态 */
  const [aiQRTopic, setAiQRTopic] = useState('');
  const [aiQRBusy, setAiQRBusy] = useState(false);
  const [aiQRError, setAiQRError] = useState<string | null>(null);
  const [aiQRCandidates, setAiQRCandidates] = useState<string[]>([]);
  const [aiQRSelected, setAiQRSelected] = useState<Set<number>>(new Set());

  /**
   * AI 智能建议：基于当前会话最近几条消息，自动准备 4-6 条“下一句该怎么回”。
   * - 仅会话切换 / 最后一条消息变化时重拉
   * - lang 跟随会话 outputLang；不上锁时由后端判断“auto”（跟随客户语言）
   */
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [aiSugBusy, setAiSugBusy] = useState(false);
  const [aiSugError, setAiSugError] = useState<string | null>(null);
  const [aiSugLang, setAiSugLang] = useState<string>('');
  /**
   * AI 建议「显示语言」。独立于会话发出语言 (outputLang)。
   * - 'auto' = 跟随 outputLang 或客户语言（服务端判断）
   * - 'zh' / 'en' / … = 强制以该语言生成，便于不熟悉外语的销售阅读
   * 点击 ⚡ 发送时：如果 outputLang 锁定且与显示语不同，会在发出前调翻译；
   * 如果未锁定且显示语不是 auto，同样会调 /api/ai/translate 译回会话实际语言。
   */
  const [aiSugDisplayLang, setAiSugDisplayLang] = useState<string>('auto');
  /**
   * AI 建议总开关。默认关闭，避免每聊一句都烧 token。
   * 开关状态同步 localStorage。关闭时不走 auto-refresh、也不渲染建议条。
   */
  const [aiSugEnabled, setAiSugEnabled] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const v = window.localStorage.getItem('wa.ai-suggestions.enabled');
      if (v === '1') setAiSugEnabled(true);
    } catch {
      /* ignore */
    }
  }, []);
  function toggleAiSugEnabled(next: boolean) {
    setAiSugEnabled(next);
    try {
      window.localStorage.setItem('wa.ai-suggestions.enabled', next ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (!next) {
      // 关闭时清掉上一批结果，避免重新开启时看到陈旧建议
      setAiSuggestions([]);
      setAiSugError(null);
    }
  }
  // 「总结客户」按钮的 loading 态
  const [summarizingProfile, setSummarizingProfile] = useState(false);
  // 初始化从 localStorage 读，变更同步写回。不随会话变化为全局首选项。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const v = window.localStorage.getItem('wa.ai-suggestions.display-lang');
      if (v) setAiSugDisplayLang(v);
    } catch {
      /* ignore */
    }
  }, []);

  /** 点击外部关闭浮层 */
  useEffect(() => {
    if (!showEmoji && !showQuickReplies) return;
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (showEmoji && emojiWrapRef.current && !emojiWrapRef.current.contains(target)) {
        setShowEmoji(false);
      }
      if (
        showQuickReplies &&
        quickRepliesWrapRef.current &&
        !quickRepliesWrapRef.current.contains(target)
      ) {
        setShowQuickReplies(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setShowEmoji(false);
        setShowQuickReplies(false);
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [showEmoji, showQuickReplies]);

  /** 初次挂载时从 localStorage 读取已保存的快捷话术；若没有则用默认种子 */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw2 = window.localStorage.getItem(QUICK_REPLY_STORAGE_V2);
      if (raw2) {
        const parsed = JSON.parse(raw2);
        if (Array.isArray(parsed)) {
          setQuickReplies(
            parsed
              .filter((x) => x && typeof x.text === 'string')
              .map((x) => ({ text: x.text, loc: x.loc ?? {} }))
          );
          return;
        }
      }
      // 旧版迁移：v1 是 string[]
      const raw1 = window.localStorage.getItem(QUICK_REPLY_STORAGE_V1);
      if (raw1) {
        const parsed = JSON.parse(raw1);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
          setQuickReplies(parsed.map((t) => ({ text: t, loc: {} })));
          return;
        }
      }
    } catch {
      // ignore parse errors, fall back to defaults
    }
    setQuickReplies(DEFAULT_QUICK_REPLIES.map((t) => ({ text: t, loc: {} })));
  }, [DEFAULT_QUICK_REPLIES]);

  /** 任何修改都同步写回 localStorage */
  function persistQuickReplies(next: QuickReply[]) {
    setQuickReplies(next);
    try {
      window.localStorage.setItem(QUICK_REPLY_STORAGE_V2, JSON.stringify(next));
    } catch {
      // ignore quota errors
    }
  }

  /**
   * 取一条话术在当前展示语言下的文本：
   * - zh 直接用 text；
   * - 其它语言优先取 loc[lang]，没有就回退原文。
   */
  function quickReplyDisplay(r: QuickReply, lang: LangCode): string {
    if (lang === 'zh') return r.text;
    return r.loc?.[lang] || r.text;
  }

  /** 切换语言时，找出所有缺翻译的条目一次性请求 AI 翻译并缓存 */
  async function changeQuickReplyLang(next: LangCode) {
    setQrLang(next);
    setQrTranslateError(null);
    if (next === 'zh') return;
    const missing = quickReplies.filter((r) => !r.loc?.[next]);
    if (missing.length === 0) return;
    const cfg = loadAiConfig();
    if (!isAiConfigured(cfg)) {
      setQrTranslateError('未配置 AI：请先在「设置 → AI 模型」填写 Endpoint / API Key');
      return;
    }
    setQrTranslating(true);
    try {
      const r = await fetch('/api/ai/translate-quick-replies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          texts: missing.map((m) => m.text),
          lang: next,
          azure: {
            endpoint: cfg.endpoint,
            apiKey: cfg.apiKey,
            model: getEffectiveSearchModel(cfg)
          }
        })
      });
      const data = (await r.json().catch(() => ({}))) as { items?: string[]; error?: string };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const items = data.items ?? [];
      const map = new Map<string, string>();
      missing.forEach((m, i) => map.set(m.text, items[i] || m.text));
      persistQuickReplies(
        quickReplies.map((q) =>
          map.has(q.text)
            ? { ...q, loc: { ...(q.loc ?? {}), [next]: map.get(q.text)! } }
            : q
        )
      );
    } catch (err) {
      setQrTranslateError(err instanceof Error ? err.message : String(err));
    } finally {
      setQrTranslating(false);
    }
  }

  /** 手动新增一条话术：始终以输入文本作为原文（按当前语言录入也算原文）。 */
  function addManualQuickReply() {
    const t = qrManualInput.trim();
    if (!t) return;
    if (quickReplies.some((q) => q.text === t)) {
      setQrManualInput('');
      return;
    }
    persistQuickReplies([...quickReplies, { text: t, loc: {} }]);
    setQrManualInput('');
  }

  /** 触发隐藏 <input type=file> */
  function openFilePicker() {
    fileInputRef.current?.click();
  }

  /** 把选中的图片/视频文件转 data URL 加入待发媒体列表（复用 readAsDataUrl） */
  async function onFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/')
    );
    e.target.value = ''; // 允许重复选同一文件
    if (files.length === 0) return;
    try {
      const next: { kind: 'image' | 'video'; url: string }[] = [];
      for (const f of files) {
        next.push({
          kind: f.type.startsWith('video/') ? 'video' : 'image',
          url: await readAsDataUrl(f)
        });
      }
      setPendingMedia((prev) => [...prev, ...next]);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }

  /** 把字符 / 话术追加进当前 draft（中间留空格） */
  function appendToDraft(s: string) {
    setDraft((d) => (d ? `${d}${d.endsWith(' ') ? '' : ' '}${s}` : s));
  }

  /** 调 /api/ai/quick-replies 生成候选话术 */
  async function generateQuickReplies() {
    if (!aiQRTopic.trim()) {
      setAiQRError('请先输入场景，例如「回复砍价」「催付款」');
      return;
    }
    const cfg = loadAiConfig();
    if (!isAiConfigured(cfg)) {
      setAiQRError('未配置 AI：请先在「设置 → AI 模型」填写 Endpoint / API Key');
      return;
    }
    setAiQRBusy(true);
    setAiQRError(null);
    setAiQRCandidates([]);
    setAiQRSelected(new Set());
    try {
      const r = await fetch('/api/ai/quick-replies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: aiQRTopic.trim(),
          count: 6,
          lang: 'zh',
          azure: {
            endpoint: cfg.endpoint,
            apiKey: cfg.apiKey,
            model: getEffectiveSearchModel(cfg)
          }
        })
      });
      const data = (await r.json().catch(() => ({}))) as { items?: string[]; error?: string };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setAiQRCandidates(data.items ?? []);
      setAiQRSelected(new Set((data.items ?? []).map((_, i) => i)));
    } catch (err) {
      setAiQRError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiQRBusy(false);
    }
  }

  /** 把选中的 AI 候选合并保存进本地快捷话术列表（去重） */
  function adoptSelectedAiReplies() {
    const picked = aiQRCandidates.filter((_, i) => aiQRSelected.has(i));
    if (picked.length === 0) return;
    const existing = new Set(quickReplies.map((q) => q.text));
    const additions: QuickReply[] = picked
      .filter((p) => !existing.has(p))
      .map((t) => ({ text: t, loc: {} }));
    if (additions.length > 0) persistQuickReplies([...quickReplies, ...additions]);
    setAiQRCandidates([]);
    setAiQRSelected(new Set());
    setAiQRTopic('');
  }


  const waReady = isWaConfigured(waConfig) || personalReady;
  /** 在商业号 / 个人号中说明当前走哪个通道，供顶部小标语使用 */
  const channelLabel = personalReady
    ? `个人号已登录${personalLabel ? ` · ${personalLabel}` : ''}`
    : isWaConfigured(waConfig)
      ? `商业号 · ${waConfig?.displayPhone || waConfig?.phoneNumberId}`
      : '未连接 WhatsApp';

  useEffect(() => {
    setWaConfig(loadWaConfig());
  }, []);

  // 深链：/inbox?conv=xxx
  useEffect(() => {
    const conv = search?.get('conv');
    if (conv) setActiveId(conv);
  }, [search]);

  // 深链：/inbox?conv=xxx&product=yyy → 自动选品并发送
  const [pendingProduct, setPendingProduct] = useState<string | null>(null);
  useEffect(() => {
    const pid = search?.get('product');
    if (pid) setPendingProduct(pid);
  }, [search]);
  useEffect(() => {
    if (!pendingProduct || !activeId) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/catalog/${pendingProduct}`);
      if (!res.ok) return;
      const p = (await res.json()) as CatalogProduct;
      if (cancelled) return;
      setPendingProduct(null);
      // 深链场景：直接打开发送面板（让用户看到要发什么再确认）
      setSendPanel({ product: p, lang: DEFAULT_LANG });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingProduct, activeId]);

  // 拉会话列表，5s 轮询
  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/wa/conversations');
      const json = await res.json();
      setConversations(json.conversations ?? []);
      if (!activeId && json.conversations?.length > 0) {
        setActiveId(json.conversations[0].id);
      }
    } catch {
      // ignore
    }
  }, [activeId]);

  useEffect(() => {
    refreshConversations();
    const t = setInterval(refreshConversations, 5000);
    return () => clearInterval(t);
  }, [refreshConversations]);

  const refreshAutopilotState = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/autopilot/state');
      if (!r.ok) return;
      const j = (await r.json()) as {
        killSwitch?: boolean;
        defaultMode?: AutoMode;
        pausedUntil?: Record<string, number>;
      };
      setAutopilot({
        killSwitch: !!j.killSwitch,
        defaultMode: j.defaultMode ?? 'SUGGEST',
        pausedUntil: j.pausedUntil ?? {}
      });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshAutopilotState();
    const t = setInterval(refreshAutopilotState, 5000);
    return () => clearInterval(t);
  }, [refreshAutopilotState]);

  // 拉当前会话消息，3s 轮询
  const refreshMessages = useCallback(async (conversationId: string) => {
    try {
      const res = await fetch(`/api/wa/conversations/${conversationId}`);
      if (!res.ok) return;
      const json = await res.json();
      setMessages(json.messages ?? []);
    } catch {
      // Network blips are expected when testing against a remote dev server; keep the current messages.
    }
  }, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    const conversationId = activeId;
    let cancelled = false;
    async function load() {
      if (!cancelled) await refreshMessages(conversationId);
    }
    load();
    const t = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [activeId, refreshMessages]);

  // auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, activeId]);

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  );
  const effectiveAutoMode: AutoMode = (activeConv?.autoMode as AutoMode | undefined) ?? autopilot?.defaultMode ?? 'SUGGEST';
  const activeAutoPausedUntil =
    activeId && autopilot?.pausedUntil ? autopilot.pausedUntil[activeId] : undefined;
  const activeAutoPaused = !!activeAutoPausedUntil && activeAutoPausedUntil > Date.now();
  const activeAutoMinutesLeft = activeAutoPausedUntil
    ? Math.max(0, Math.ceil((activeAutoPausedUntil - Date.now()) / 60000))
    : 0;

  // ----------------------------------------------------------------
  // DRAFT_AUTO：服务端写在 conversation.aiDraft 里的 AI 草稿，前端轮询拿到后填
  // 进输入框；按 createdAt 去重，避免同一条草稿被反复覆盖用户正在打字的内容。
  // 应用规则：
  //   1) 当前会话存在 aiDraft，且 createdAt 比上次已应用的新；
  //   2) 输入框为空（不打断用户已经在打字的内容）；
  // 满足时填入并立刻 DELETE 服务端那份，避免下次轮询又看到它。
  // ----------------------------------------------------------------
  const lastAppliedDraftAtRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!activeConv?.aiDraft || !activeId) return;
    const d = activeConv.aiDraft;
    if ((lastAppliedDraftAtRef.current[activeId] ?? 0) >= d.createdAt) return;
    if (draft.trim().length > 0) return; // 不打断正在编辑
    lastAppliedDraftAtRef.current[activeId] = d.createdAt;
    setDraft(d.text);
    // 服务端清掉这份草稿；失败也无所谓，前端 ref 已经记住不会重填
    fetch(`/api/wa/conversations/${activeId}/draft`, { method: 'DELETE' }).catch(() => {});
  }, [activeConv?.aiDraft?.createdAt, activeId, draft]);

  async function send(payload: Record<string, unknown>) {
    if (!activeId) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch('/api/wa/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: activeId,
          name: activeConv?.name,
          phoneNumberId: waConfig?.phoneNumberId,
          accessToken: waConfig?.accessToken,
          ...payload
        })
      });
      const json = await res.json();
      if (!res.ok || json.ok === false) {
        setSendError(json.reason || `HTTP ${res.status}`);
      }
      // 立刻刷新一次
      await refreshMessages(activeId);
      refreshConversations();
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  /**
   * 重试一条失败消息：把同样的负载 + retryMessageId 发回 /api/wa/send，
   * 服务端会原地更新这条消息的 status，不会产生重复气泡。
   * 中间态 UI：本地立刻把这条置为 'sending'，得到响应后再被刷新覆盖。
   */
  async function retryMessage(m: Message) {
    if (!activeId) return;
    setMessages((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, status: 'sending', error: undefined } : x))
    );
    try {
      await fetch('/api/wa/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: activeId,
          name: activeConv?.name,
          phoneNumberId: waConfig?.phoneNumberId,
          accessToken: waConfig?.accessToken,
          retryMessageId: m.id,
          text: m.text,
          imageUrls: m.imageUrls,
          videoUrls: m.videoUrls,
          productId: m.productId,
          productTitle: m.productTitle,
          quoteText: m.quoteText,
          quotedMessageId: m.quotedMessageId
        })
      });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      await refreshMessages(activeId);
      refreshConversations();
    }
  }

  /**
   * 添加 / 取消我对某条消息的 emoji reaction（类似 WA 长按消息选 emoji）。
   * - 同 emoji 二次点 = 取消（传空 emoji 给后端）
   * - 乐观更新本地，得到响应后再用接口拉一次保证一致
   */
  async function reactMessage(m: Message, emoji: string) {
    if (!activeId) return;
    const mine = (m.reactions ?? []).find((r) => r.from === 'me');
    const toggleOff = mine?.emoji === emoji;
    const nextEmoji = toggleOff ? '' : emoji;
    setMessages((prev) =>
      prev.map((x) => {
        if (x.id !== m.id) return x;
        const others = (x.reactions ?? []).filter((r) => r.from !== 'me');
        return {
          ...x,
          reactions: nextEmoji
            ? [...others, { emoji: nextEmoji, from: 'me', ts: Date.now() }]
            : others
        };
      })
    );
    try {
      await fetch('/api/wa/reaction', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: m.id, emoji: nextEmoji })
      });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      await refreshMessages(activeId);
    }
  }

  /** 转发一条消息到选中的若干会话。成功后关弹窗，并刷新源会话以便看到「转发中」/失败提示。 */
  async function forwardSubmit(m: Message, toIds: string[]) {
    if (!toIds.length) return;
    try {
      const res = await fetch('/api/wa/forward', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: m.id, toConversationIds: toIds })
      });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) {
        setSendError(`转发失败：${j?.reason ?? '未知错误'}`);
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setForwardTarget(null);
      refreshConversations();
    }
  }
  // 现由 ConversationMenu 直接调用 /api/wa/conversations/:id/pin。保留此注释作为入口提示。

  // 历史回灌状态轮询：5s 一次，只在 personal 模式下有意义。
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/wa/personal/status');
        if (!res.ok) return;
        const j = await res.json();
        if (cancelled) return;
        if (j?.backfill) setBackfill(j.backfill);
        setPersonalReady(j?.state === 'ready');
        const label =
          j?.me?.pushname || j?.me?.name || (j?.me?.number ? `+${j.me.number}` : null);
        setPersonalLabel(label || null);
      } catch {
        /* ignore */
      }
    }
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  /**
   * 「历史补齐完成」横幅只短暂闪一下：当后端 backfill 跳到 done，
   * 立刻显示 5 秒，再隐藏；之后即使 status 接口还在返回 done，也不再打扰。
   * 重新发起一次回灌时（state 变回 running）就会刷出新的进度条。
   */
  const lastSeenStateRef = useRef<string | null>(null);
  useEffect(() => {
    const s = backfill?.state;
    if (s && s !== lastSeenStateRef.current) {
      lastSeenStateRef.current = s;
      if (s === 'done') {
        setShowBackfillDone(true);
        const t = setTimeout(() => setShowBackfillDone(false), 5000);
        return () => clearTimeout(t);
      }
    }
  }, [backfill?.state]);

  async function sendText() {
    const tRaw = draft.trim();
    const media = pendingMedia;
    if (!tRaw && media.length === 0) return;
    // 快照一份引用，发送前清除 UI，避免重复引用
    const quoting = replyTo;
    setReplyTo(null);
    setDraft('');
    setPendingMedia([]);
    const imageUrls = media.filter((m) => m.kind === 'image').map((m) => m.url);
    const videoUrls = media.filter((m) => m.kind === 'video').map((m) => m.url);
    const t = await maybeTranslateForSend(tRaw);
    const payload: Record<string, unknown> = {};
    if (t) payload.text = t;
    if (imageUrls.length) payload.imageUrls = imageUrls;
    if (videoUrls.length) payload.videoUrls = videoUrls;
    if (quoting) {
      // quoteText 是 UI 快照，仅引用文本消息才填；
      // quotedMessageId 传给后端，后端会去掉 wweb_ 前缀后传给 whatsapp-web.js。
      payload.quotedMessageId = quoting.id;
      const snippet = quoting.text
        ? quoting.text.slice(0, 140)
        : quoting.imageUrls?.length
          ? '[图片]'
          : quoting.videoUrls?.length
            ? '[视频]'
            : '';
      if (snippet) payload.quoteText = snippet;
    }
    await send(payload);
  }

  /**
   * 「发出语言锁」翻译助手：给任意文本走一遍。
   * - 会话 outputLang 未设 → 原文返回（遵从客户语言路径）
   * - outputLang 设了 → 调 /api/ai/translate；失败回退原文 + 提示
   * sendText 和 ⚡直接发送都走这里，避免路径不一致。
   */
  async function maybeTranslateForSend(text: string): Promise<string> {
    if (!text) return text;
    const lockedLang = activeConv?.outputLang;
    if (!lockedLang) return text;
    const cfg = loadAiConfig();
    if (!isAiConfigured(cfg)) {
      setSendError('已锁定语言但未配置 AI，按原文发送');
      return text;
    }
    try {
      const r = await fetch('/api/ai/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          lang: lockedLang,
          azure: {
            endpoint: cfg.endpoint,
            apiKey: cfg.apiKey,
            model: getEffectiveSearchModel(cfg)
          }
        })
      });
      const j = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
      if (r.ok && j.text && j.text.trim()) return j.text.trim();
      if (j.error) setSendError(`翻译失败，已按原文发送：${j.error}`);
      return text;
    } catch (err) {
      setSendError(`翻译失败，已按原文发送：${err instanceof Error ? err.message : String(err)}`);
      return text;
    }
  }

  /**
   * 拉一次 AI 智能建议（基于最近会话上下文）。
   * 在 activeId 切换 / 最后一条客户消息变化时被 useEffect 自动触发。
   */
  const refreshAiSuggestions = useCallback(async () => {
    if (!activeId) return;
    if (!aiSugEnabled) return; // 总开关关 → 一律不调
    const cfg = loadAiConfig();
    if (!isAiConfigured(cfg)) {
      setAiSuggestions([]);
      setAiSugError(null);
      return;
    }
    setAiSugBusy(true);
    setAiSugError(null);
    try {
      // displayLang 是“auto” 时 → 不传 lang，后端走 outputLang 或 跟随客户语言
      // 否则以显示语言为准（便于销售阅读）
      const reqLang = aiSugDisplayLang && aiSugDisplayLang !== 'auto' ? aiSugDisplayLang : undefined;
      const r = await fetch('/api/wa/suggestions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: activeId,
          count: 5,
          ...(reqLang ? { lang: reqLang } : {}),
          azure: {
            endpoint: cfg.endpoint,
            apiKey: cfg.apiKey,
            model: getEffectiveSearchModel(cfg)
          }
        })
      });
      const j = (await r.json().catch(() => ({}))) as {
        items?: string[];
        lang?: string;
        error?: string;
      };
      if (!r.ok) {
        setAiSugError(j.error || `HTTP ${r.status}`);
        setAiSuggestions([]);
        return;
      }
      setAiSuggestions(j.items ?? []);
      setAiSugLang(j.lang ?? '');
    } catch (e) {
      setAiSugError(e instanceof Error ? e.message : String(e));
      setAiSuggestions([]);
    } finally {
      setAiSugBusy(false);
    }
  }, [activeId, aiSugDisplayLang, aiSugEnabled]);

  /** 设定 / 清空当前会话的发出语言锁。本地乐观更新 + 后端 PATCH */
  async function setActiveOutputLang(next: string | null) {
    if (!activeId) return;
    // 乐观：先在本地更新 conversations 列表
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeId ? { ...c, outputLang: next || undefined } : c
      )
    );
    try {
      await fetch(`/api/wa/conversations/${activeId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outputLang: next ?? null })
      });
    } catch {
      // 回滚由下一轮 refreshConversations 兜底
    }
    refreshConversations();
    // 语言变了，建议也应该跟着重新生成
    refreshAiSuggestions();
  }

  /** 设定当前会话 AI 档位（乐观更新 + 后端 PATCH） */
  async function setActiveAutoMode(next: AutoMode | null) {
    if (!activeId) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === activeId ? { ...c, autoMode: next ?? undefined } : c))
    );
    try {
      await fetch(`/api/wa/conversations/${activeId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoMode: next })
      });
    } catch {
      /* ignore */
    }
    refreshConversations();
  }

  /** 全局急停（Kill Switch） */
  async function toggleKillSwitch() {
    if (!autopilot || autoBusy) return;
    setAutoBusy(true);
    try {
      await fetch('/api/ai/autopilot/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'kill', on: !autopilot.killSwitch })
      });
      await refreshAutopilotState();
    } finally {
      setAutoBusy(false);
    }
  }

  /** 暂停当前会话自动发送（minutes=0 代表恢复） */
  async function pauseActiveAutopilot(minutes: number) {
    if (!activeId || autoBusy) return;
    setAutoBusy(true);
    try {
      await fetch('/api/ai/autopilot/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pauseConv', conversationId: activeId, minutes })
      });
      await refreshAutopilotState();
    } finally {
      setAutoBusy(false);
    }
  }

  /**
   * 「📝 总结客户」：基于当前会话最近 50 条消息，调 AI 生成长期画像并写入对应 contact。
   * 后续 /api/wa/suggestions 会自动把这段画像喂给 AI。
   * 联系人不存在时会自动 upsert 一条 source='inbox' 的占位记录。
   */
  async function summarizeActiveContact() {
    if (!activeId) return;
    const cfg = loadAiConfig();
    if (!isAiConfigured(cfg)) {
      setSendError('请先在「设置 → AI 模型」配置 Endpoint / API Key');
      return;
    }
    setSummarizingProfile(true);
    try {
      const r = await fetch(
        `/api/wa/conversations/${encodeURIComponent(activeId)}/profile`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            fallbackName: activeConv?.name || undefined,
            azure: {
              endpoint: cfg.endpoint,
              apiKey: cfg.apiKey,
              model: getEffectiveSearchModel(cfg)
            }
          })
        }
      );
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        contact?: { aiProfile?: { summary?: string } };
        error?: string;
      };
      if (!r.ok || !j.ok) {
        setSendError(`总结失败：${j.error || `HTTP ${r.status}`}`);
        return;
      }
      const summary = j.contact?.aiProfile?.summary;
      // 复用 sendError 槽做轻量 toast 提示
      setSendError(summary ? `✅ 客户画像已更新：${summary}` : '✅ 客户画像已更新');
      // 立刻刷新一次建议，让画像生效
      refreshAiSuggestions();
    } catch (e) {
      setSendError(`总结失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSummarizingProfile(false);
    }
  }

  // 切换会话或最后一条消息（含我方/客户）变化时，自动刷新建议
  const lastMsgKey = useMemo(() => {
    const m = messages[messages.length - 1];
    return m ? `${m.id}:${m.direction}` : '';
  }, [messages]);
  useEffect(() => {
    if (!activeId) {
      setAiSuggestions([]);
      setAiSugError(null);
      return;
    }
    // 轻防抖：避免轮询拉消息时频繁触发
    const t = window.setTimeout(() => {
      refreshAiSuggestions();
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, lastMsgKey]);

  /**
   * 处理粘贴事件：从剪贴板读取图片/视频文件转为 data URL 暂存。
   * - 文本仍走默认粘贴（不拦截）
   * - 只有出现图片/视频才 preventDefault
   */
  function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error ?? new Error('read failed'));
      r.readAsDataURL(file);
    });
  }

  async function handleDraftPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === 'file' && (it.type.startsWith('image/') || it.type.startsWith('video/')))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length === 0) return;
    e.preventDefault();
    try {
      const next: { kind: 'image' | 'video'; url: string }[] = [];
      for (const f of files) {
        const url = await readAsDataUrl(f);
        next.push({ kind: f.type.startsWith('video/') ? 'video' : 'image', url });
      }
      setPendingMedia((prev) => [...prev, ...next]);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }



  /**
   * 按需翻译：返回含指定语言本地化的 product。
   * - lang === 'zh' 或已有缓存→直接返回原件
   * - 否则调 /api/catalog/{id}/translate，成功后返回合并后的 product；失败抛错
   * 为了避免重复调，同一个 (productId, lang) 在动画期间由调用方控制。
   */
  async function ensureTranslation(p: CatalogProduct, lang: LangCode): Promise<CatalogProduct> {
    if (lang === 'zh' || p.localizations?.[lang]) return p;
    const cfg = loadAiConfig();
    if (!isAiConfigured(cfg)) {
      throw new Error('未配置 AI：请先在「设置 → AI 模型」填写 Azure Endpoint / API Key');
    }
    const r = await fetch(`/api/catalog/${p.id}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lang,
        azure: {
          endpoint: cfg.endpoint,
          apiKey: cfg.apiKey,
          model: getEffectiveSearchModel(cfg)
        }
      })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j?.error || `翻译失败 (HTTP ${r.status})`);
    }
    return (await r.json()) as CatalogProduct;
  }

  /**
   * 商品发送：从 picker 点商品 → 关闭 picker，打开「发送面板」让用户调整文案/选图/选模式。
   * lang 由 picker 顶部选择决定；非中文会即时拉翻译（缓存到 catalog）。
   */
  async function openSendPanel(p: CatalogProduct, lang: LangCode) {
    setShowCatalog(false);
    setPanelTranslateError(null);
    let merged: CatalogProduct = p;
    if (lang !== 'zh' && !p.localizations?.[lang]) {
      setPanelTranslating(lang);
      try {
        merged = await ensureTranslation(p, lang);
      } catch (e) {
        setPanelTranslateError(e instanceof Error ? e.message : String(e));
        // 翻译失败仍然打开面板（用原文占位），但 lang 回退中文避免“说一套发一套”
        lang = 'zh';
      } finally {
        setPanelTranslating(null);
      }
    }
    setSendPanel({ product: merged, lang });
  }

  /**
   * 面板内切语言：若无缓存先调翻译再切，该语言资源未准备好之前不切 lang。
   * 这样能保证「看到什么语言” ≡ “发出什么语言」。
   */
  async function handlePanelChangeLang(next: LangCode) {
    if (!sendPanel) return;
    if (next === sendPanel.lang) return;
    setPanelTranslateError(null);
    // 已缓存 / 中文：直接切
    if (next === 'zh' || sendPanel.product.localizations?.[next]) {
      setSendPanel({ ...sendPanel, lang: next });
      return;
    }
    setPanelTranslating(next);
    try {
      const merged = await ensureTranslation(sendPanel.product, next);
      setSendPanel({ product: merged, lang: next });
    } catch (e) {
      setPanelTranslateError(e instanceof Error ? e.message : String(e));
      // 翻译失败：不切 lang，保持原语言状态。避免 UI 与实际发送语言不一致
    } finally {
      setPanelTranslating(null);
    }
  }

  /**
   * 真发：来自 ProductSendPanel 的「发送」按钮。
   * mode='per-image' → 先发文案文本，再依次发图（whatsapp-web 600ms 间隔，朋友逐张接收）
   * mode='collage'   → 本地 canvas 拼成一张图，发文案 + 1 张大图（朋友一次接收完）
   */
  async function runSend(opts: {
    product: CatalogProduct;
    lang: LangCode;
    caption: string;
    imageUrls: string[];
    mode: 'per-image' | 'collage';
  }) {
    const { product, lang, caption, imageUrls, mode } = opts;
    if (imageUrls.length === 0 && !caption.trim()) return;
    // 兑底：发送前再校一次。若面板不是中文但商品仍无该语言翻译（极端场景：
    // 用户手动改过文案 / 刚切过来 → 翻译结果还未回复到 catalog），则拒发并返回错误。
    if (lang !== 'zh' && !product.localizations?.[lang]) {
      try {
        await ensureTranslation(product, lang);
      } catch (e) {
        setSendError(
          `发送已取消：当前选择语言还没有翻译版本，请重试或切回中文。原因：${
            e instanceof Error ? e.message : String(e)
          }`
        );
        return;
      }
    }
    let finalImages = imageUrls;
    if (mode === 'collage' && imageUrls.length > 1) {
      try {
        const dataUrl = await buildCollage(imageUrls, { cell: 600 });
        finalImages = [dataUrl];
      } catch (e) {
        setSendError('拼图失败：' + (e instanceof Error ? e.message : String(e)));
        return;
      }
    }
    await send({
      text: caption,
      imageUrls: finalImages,
      productId: product.id,
      productTitle: product.title,
      quoteText: product.price && product.price !== '价格待确认' ? product.price : undefined
    });
    setSendPanel(null);
  }

  return (
    <div className="flex h-screen">
      {/* 会话列表 */}
      <aside className="flex w-[320px] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50">
        <header className="border-b border-zinc-200 bg-white px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <Link
                href="/settings/whatsapp"
                title={
                  waReady
                    ? `已连接：${channelLabel}（点击去设置）`
                    : '未连接，点击去设置扫码登录'
                }
                aria-label={waReady ? '已连接' : '未连接'}
                className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                  waReady ? 'bg-emerald-500' : 'bg-amber-500'
                }`}
              />
              <h1 className="truncate text-base font-semibold text-zinc-950">Inbox</h1>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowNewChat(true)}
                className="rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                title="手动输入电话号，开启一个新会话（无需先加到重点客户）"
              >
                + 新建
              </button>
              <button
                type="button"
                onClick={async () => {
                  await fetch('/api/wa/personal/import-contacts', { method: 'POST' });
                  await fetch('/api/wa/personal/rebuild', { method: 'POST' });
                  refreshConversations();
                }}
                className="rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                title="从 WhatsApp 通讯录导入全部联系人到侧栏；并从本地历史消息重建缺失的会话。交接同事时避免「只看到几个人」。"
              >
                同步联系人
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!confirm('强制销毁并重建 WhatsApp Web 会话？\n\n用于：收不到新消息 / 发送报 getChat undefined / 客户端僵尸状态。\n约需 10–30 秒，期间会话不可用。')) return;
                  try {
                    const r = await fetch('/api/wa/personal/start', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ force: true }),
                    });
                    if (!r.ok) {
                      const j = await r.json().catch(() => ({}));
                      alert('重连失败：' + (j?.reason || r.statusText));
                    }
                  } catch (e: any) {
                    alert('重连请求失败：' + (e?.message || String(e)));
                  }
                }}
                className="rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                title="收不到新消息或发送报 getChat 错误时点这里：强制销毁并重建 WhatsApp Web 客户端。"
              >
                重连
              </button>
            </div>
          </div>
          <p className="mt-0.5 truncate text-xs text-zinc-500">
            {waReady ? channelLabel : '未连接 · 去设置页扫码登录个人号'}
          </p>
        </header>

        {needsHumanCount > 0 ? (
          <button
            type="button"
            onClick={() => {
              const first = conversations.find((c) => c.needsHuman);
              if (first) setActiveId(first.id);
            }}
            className="flex w-full items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-2 text-left transition-colors hover:bg-rose-100"
            title="有客户进入报价环节，等待你核价/出 PI。点击跳到第一个。"
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
            </span>
            <span className="text-xs font-semibold text-rose-700">
              {needsHumanCount} 个客户待人工报价
            </span>
            <span className="ml-auto text-[10px] text-rose-500">点击跳转 →</span>
          </button>
        ) : null}

        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-zinc-400">
              没有会话<br />
              {waReady
                ? '等待客户发来第一条消息'
                : '配置 WhatsApp 后客户消息会自动到这里'}
            </div>
          ) : (
            conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <div
                  key={c.id}
                  className={`group relative border-b border-zinc-200 transition-colors ${
                    c.needsHuman
                      ? 'border-l-[3px] border-l-rose-500 bg-rose-50/60 hover:bg-rose-50'
                      : active
                        ? 'bg-white'
                        : 'hover:bg-white/50'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveId(c.id)}
                    className="block w-full px-4 py-3 pr-9 text-left"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-zinc-950">
                        {c.needsHuman ? (
                          <span className="mr-1" title={c.needsHumanReason || '待人工介入'}>
                            🔴
                          </span>
                        ) : c.pinned ? (
                          <span className="mr-1 text-[#5E6AD2]">📌</span>
                        ) : null}
                        {c.name || formatConversationDisplayName(c.id)}
                      </span>
                      <span className="shrink-0 text-[10px] text-zinc-400">
                        {c.lastTimestamp ? formatTime(c.lastTimestamp) : ''}
                      </span>
                    </div>
                    {c.needsHuman ? (
                      <div className="mt-1">
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 ring-1 ring-rose-300"
                          title={c.needsHumanReason || '待人工介入'}
                        >
                          ⚠️ 待人工报价
                        </span>
                      </div>
                    ) : null}
                    <p className="mt-0.5 line-clamp-1 text-xs text-zinc-500">
                      {c.lastMessage || '—'}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-[10px] text-zinc-400">
                        {formatConversationSubtitle(c.id)}
                      </span>
                      {c.unread > 0 ? (
                        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#5E6AD2] px-1 text-[10px] font-semibold text-white">
                          {c.unread}
                        </span>
                      ) : null}
                    </div>
                  </button>
                  <ConversationMenu
                    conv={c}
                    allConvs={conversations}
                    onChanged={async (nextActiveId) => {
                      await refreshConversations();
                      if (nextActiveId !== undefined) setActiveId(nextActiveId);
                    }}
                  />
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* 聊天主区 */}
      <section className="flex flex-1 flex-col bg-white">
        {activeConv ? (
          <>
            <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-zinc-950">
                  {activeConv.name || activeConv.id}
                </h2>
                <p className="text-xs text-zinc-500">{formatConversationSubtitle(activeConv.id)}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <AutoModeButton
                  value={activeConv.autoMode ?? null}
                  fallback={autopilot?.defaultMode ?? 'SUGGEST'}
                  onChange={setActiveAutoMode}
                />
                <LangLockButton
                  value={activeConv.outputLang ?? null}
                  onChange={setActiveOutputLang}
                />
                <Button
                  size="sm"
                  variant={autopilot?.killSwitch ? 'primary' : 'secondary'}
                  onClick={toggleKillSwitch}
                  disabled={autoBusy}
                  title={autopilot?.killSwitch ? '关闭全局急停，恢复 AI 自动发送' : '立即停止全部 AI 自动发送'}
                  className={autopilot?.killSwitch ? '' : 'text-rose-700'}
                >
                  {autopilot?.killSwitch ? '⛔ 已急停' : '⛔ 急停'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={summarizeActiveContact}
                  disabled={!activeId || summarizingProfile}
                  title="用最近 50 条聊天生成客户长期画像，下次自动喂给 AI 建议"
                >
                  {summarizingProfile ? '总结中…' : '📝 总结客户'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setShowAddContact(true)}
                  disabled={!activeId}
                  title="把当前会话对方加入重点客户跟进"
                >
                  + 重点客户
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setShowAiExtract(true)}
                  disabled={!activeId}
                  title="用 AI 从当前对话识别对方姓名 / 公司 / 手机号"
                >
                  AI 识别
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setShowCatalog(true)}
                  disabled={!activeId}
                >
                  发送商品
                </Button>
              </div>
            </header>

            <div
              className={`flex items-center justify-between border-b px-5 py-1.5 text-[11px] ${
                autopilot?.killSwitch
                  ? 'border-rose-200 bg-rose-50 text-rose-700'
                  : activeAutoPaused
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : 'border-zinc-200 bg-zinc-50 text-zinc-600'
              }`}
            >
              <span>
                AI 自动化：
                {autopilot?.killSwitch
                  ? '全局急停中'
                  : `当前会话 ${AUTO_MODE_ITEMS.find((x) => x.value === effectiveAutoMode)?.label ?? effectiveAutoMode}`}
                {activeAutoPaused ? ` · 已暂停（剩余约 ${activeAutoMinutesLeft} 分钟）` : ''}
              </span>
              <SalesStageChips conv={activeConv} />
              <div className="flex items-center gap-2">
                {!autopilot?.killSwitch ? (
                  activeAutoPaused ? (
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[11px] text-emerald-700 hover:bg-emerald-100"
                      onClick={() => pauseActiveAutopilot(0)}
                      disabled={autoBusy}
                    >
                      恢复自动
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[11px] text-amber-700 hover:bg-amber-100"
                      onClick={() => pauseActiveAutopilot(60)}
                      disabled={autoBusy}
                    >
                      暂停本会话 60 分钟
                    </button>
                  )
                ) : null}
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-white"
                  onClick={refreshAutopilotState}
                  disabled={autoBusy}
                >
                  ↻ 刷新
                </button>
              </div>
            </div>

            {backfill && backfill.state === 'running' ? (
              <div
                className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-amber-50 px-5 py-2 text-xs text-amber-800"
                title="仅统计本轮新插入的条数；已存在的重复消息不计入。消息会出现在对应联系人的会话里，不会全部需要出现在当前这个会话。"
              >
                <span>
                  正在补齐近期历史消息：
                  {typeof backfill.chatsDone === 'number' && typeof backfill.chatsTotal === 'number'
                    ? ` ${backfill.chatsDone}/${backfill.chatsTotal} 个会话`
                    : ''}
                  {typeof backfill.messagesInserted === 'number'
                    ? ` · 本轮新增 ${backfill.messagesInserted} 条到本地库`
                    : ''}
                </span>
                <span className="text-amber-600">进行中…</span>
              </div>
            ) : backfill && backfill.state === 'error' ? (
              <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-red-50 px-5 py-2 text-xs text-red-700">
                <span>历史补齐失败：{backfill.error || '未知错误'}</span>
                <button
                  type="button"
                  className="underline hover:text-red-900"
                  onClick={() => {
                    fetch('/api/wa/personal/start', { method: 'POST' });
                  }}
                >
                  重试
                </button>
              </div>
            ) : backfill && backfill.state === 'done' && (backfill.messagesInserted ?? 0) > 0 && showBackfillDone ? (
              <div
                className="border-b border-zinc-200 bg-emerald-50 px-5 py-2 text-xs text-emerald-700"
                title="仅表示本次启动后新补齐进本地库的条数；已存在的重复消息会被跳过。"
              >
                历史补齐完成 · 本轮新增 {backfill.messagesInserted} 条到本地库（重复条目会被跳过）
              </div>
            ) : null}

            <div className="flex-1 overflow-y-auto bg-zinc-50 px-6 py-5">
              <div className="mx-auto max-w-2xl space-y-3">
                {messages.length === 0 ? (
                  <p className="py-8 text-center text-xs text-zinc-400">暂无消息</p>
                ) : (
                  messages.map((m, i) => {
                    const prev = i > 0 ? messages[i - 1] : null;
                    const showDay = !prev || !isSameDay(prev.timestamp, m.timestamp);
                    return (
                      <React.Fragment key={m.id}>
                        {showDay ? <DayDivider ts={m.timestamp} /> : null}
                        <MessageBubble
                          message={m}
                          onRetry={retryMessage}
                          onReply={(msg) => {
                            setReplyTo(msg);
                            window.setTimeout(() => {
                              const el = document.getElementById('wa-inbox-composer-input') as HTMLInputElement | null;
                              el?.focus();
                            }, 0);
                          }}
                          onReact={reactMessage}
                          onForward={(msg) => setForwardTarget(msg)}
                        />
                      </React.Fragment>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            <footer className="border-t border-zinc-200 bg-white px-5 py-3">
              {/* AI 建议：总开关关 → 展示一条轻量提示；开 → 展示完整建议条。
                  开关不随会话，是全局首选项（需要时才烒 token） */}
              {aiSugEnabled ? (
                <AiSuggestionsRow
                  items={aiSuggestions}
                  busy={aiSugBusy}
                  error={aiSugError}
                  lang={aiSugLang}
                  lockedLang={activeConv.outputLang ?? null}
                  displayLang={aiSugDisplayLang}
                  onDisplayLangChange={(next) => {
                    setAiSugDisplayLang(next);
                    try {
                      window.localStorage.setItem('wa.ai-suggestions.display-lang', next);
                    } catch {
                      /* ignore */
                    }
                  }}
                  onDisable={() => toggleAiSugEnabled(false)}
                  onInsert={(t) => {
                    // 插入草稿，后续点「发送」会走 sendText → maybeTranslateForSend，自动补上锁定语言
                    setDraft((prev) => (prev ? `${prev} ${t}` : t));
                  }}
                  onSendDirect={async (t) => {
                    setDraft('');
                    setSending(true);
                    setSendError(null);
                    try {
                      // ⚡ 直接发送：走同一个 maybeTranslateForSend，避免「显示是中文但会话锁定了英文」时原文发送
                      const finalText = await maybeTranslateForSend(t);
                      await send({
                        text: finalText,
                        aiSource: 'suggest-click',
                        aiMode: effectiveAutoMode,
                        aiReason: '用户点击 AI 建议条 ⚡ 直接发送'
                      });
                    } finally {
                      setSending(false);
                    }
                  }}
                  onRefresh={refreshAiSuggestions}
                />
              ) : (
                <div className="mb-2 flex items-center justify-between rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-3 py-1.5 text-[11px] text-zinc-500">
                  <span>✨ AI 建议已关闭（节省 token）</span>
                  <button
                    type="button"
                    onClick={() => {
                      toggleAiSugEnabled(true);
                      // 手动启用后立即拉一次
                      window.setTimeout(() => {
                        refreshAiSuggestions();
                      }, 50);
                    }}
                    className="rounded bg-white px-2 py-0.5 text-[11px] text-indigo-600 ring-1 ring-indigo-200 hover:bg-indigo-50"
                    title="开启后会在每次聊天更新时自动生成建议。记得多了可随时关闭。"
                  >
                    点此开启
                  </button>
                </div>
              )}
              {sendError ? (
                <div className="mb-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                  {sendError} ·{' '}
                  <Link href="/settings/whatsapp" className="underline">
                    检查配置
                  </Link>
                </div>
              ) : null}
              {!waReady ? (
                <div className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  未连接 WhatsApp，消息只写入本地不会真发出。{' '}
                  <Link href="/settings/whatsapp" className="underline">
                    去设置
                  </Link>
                </div>
              ) : null}
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendText();
                }}
              >
                {replyTo ? (
                  <div className="flex items-start gap-2 rounded-md border-l-2 border-[#5E6AD2] bg-zinc-50 px-2.5 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-medium text-[#5E6AD2]">
                        引用 {replyTo.direction === 'out' ? '你' : (activeConv?.name ?? '对方')}
                      </p>
                      <p className="truncate text-[11px] text-zinc-600">
                        {replyTo.text
                          ? replyTo.text
                          : replyTo.imageUrls?.length
                            ? '[图片]'
                            : replyTo.videoUrls?.length
                              ? '[视频]'
                              : '[消息]'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReplyTo(null)}
                      className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
                      aria-label="取消引用"
                      title="取消引用"
                    >
                      ×
                    </button>
                  </div>
                ) : null}
                {pendingMedia.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {pendingMedia.map((m, i) => (
                      <div
                        key={i}
                        className="relative h-16 w-16 overflow-hidden rounded border border-zinc-200 bg-zinc-100"
                      >
                        {m.kind === 'image' ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <video src={m.url} className="h-full w-full object-cover" muted />
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setPendingMedia((prev) => prev.filter((_, idx) => idx !== i))
                          }
                          className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/60 text-[10px] text-white"
                          aria-label="移除"
                        >
                          ×
                        </button>
                        <span className="absolute bottom-0 left-0 rounded-tr bg-black/60 px-1 text-[9px] text-white">
                          {m.kind === 'video' ? '视频' : '图'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <Input
                    id="wa-inbox-composer-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onPaste={handleDraftPaste}
                    placeholder={
                      activeConv.outputLang
                        ? `🌐 已锁定 ${(SUPPORTED_LANGS.find((l) => l.code === activeConv.outputLang)?.label) ?? activeConv.outputLang} ：输入任意语言，发送时自动翻译…`
                        : waReady
                          ? '输入回复（可直接粘贴图片/视频），Enter 发送到 WhatsApp...'
                          : '输入回复（未连接，仅本地保存不发送）...'
                    }
                    className="flex-1"
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={(!draft.trim() && pendingMedia.length === 0) || sending}
                  >
                    {sending ? '发送中…' : '发送'}
                  </Button>
                </div>
                {/* 辅助工具栏：上传文件 / 表情 / 快捷话术。
                    每个浮层都包在自己 ref 的 relative 容器里，外面点击会自动关闭。 */}
                <div className="flex items-center gap-1 text-zinc-500">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    hidden
                    onChange={onFilesSelected}
                  />
                  <button
                    type="button"
                    onClick={openFilePicker}
                    title="上传图片或视频"
                    className="rounded p-1.5 text-base hover:bg-zinc-100 hover:text-zinc-900"
                  >
                    📎
                  </button>

                  {/* === 表情浮层 === */}
                  <div ref={emojiWrapRef} className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        setShowEmoji((v) => !v);
                        setShowQuickReplies(false);
                      }}
                      title="插入表情"
                      className={`rounded p-1.5 text-base hover:bg-zinc-100 hover:text-zinc-900 ${
                        showEmoji ? 'bg-zinc-100 text-zinc-900' : ''
                      }`}
                    >
                      😀
                    </button>
                    {showEmoji ? (
                      <div className="absolute bottom-full left-0 z-10 mb-2 grid w-[280px] grid-cols-8 gap-1 rounded-md border border-zinc-200 bg-white p-2 shadow-lg">
                        {EMOJI_SET.map((e) => (
                          <button
                            key={e}
                            type="button"
                            onClick={() => {
                              appendToDraft(e);
                            }}
                            className="rounded p-1 text-lg hover:bg-zinc-100"
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {/* === 常用话术浮层 === */}
                  <div ref={quickRepliesWrapRef} className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        setShowQuickReplies((v) => !v);
                        setShowEmoji(false);
                      }}
                      title="常用回复话术"
                      className={`rounded px-2 py-1 text-xs hover:bg-zinc-100 hover:text-zinc-900 ${
                        showQuickReplies ? 'bg-zinc-100 text-zinc-900' : ''
                      }`}
                    >
                      💬 常用话术
                    </button>

                    {showQuickReplies ? (
                      <div className="absolute bottom-full left-0 z-10 mb-2 flex w-[400px] flex-col gap-2 rounded-md border border-zinc-200 bg-white p-3 shadow-lg">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-zinc-700">常用话术</span>
                          <button
                            type="button"
                            onClick={() => setShowQuickReplies(false)}
                            className="text-xs text-zinc-400 hover:text-zinc-700"
                          >
                            关闭
                          </button>
                        </div>

                        {/* 语言切换条：与商品翻译共用 SUPPORTED_LANGS，AI 自动翻译并缓存 */}
                        <div className="flex flex-wrap items-center gap-1">
                          {SUPPORTED_LANGS.map((l) => (
                            <button
                              key={l.code}
                              type="button"
                              onClick={() => changeQuickReplyLang(l.code)}
                              disabled={qrTranslating}
                              className={`rounded px-1.5 py-0.5 text-[11px] transition ${
                                qrLang === l.code
                                  ? 'bg-zinc-900 text-white'
                                  : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
                              } disabled:opacity-40`}
                              title={l.englishName}
                            >
                              {l.flag} {l.label}
                            </button>
                          ))}
                          {qrTranslating ? (
                            <span className="ml-1 text-[11px] text-zinc-400">翻译中…</span>
                          ) : null}
                        </div>
                        {qrTranslateError ? (
                          <p className="text-[11px] text-red-600">{qrTranslateError}</p>
                        ) : null}

                        {quickReplies.length === 0 ? (
                          <p className="text-[11px] text-zinc-400">还没有话术，下面用 AI 生成或手动添加</p>
                        ) : (
                          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                            {quickReplies.map((r, i) => {
                              const display = quickReplyDisplay(r, qrLang);
                              const isFallback = qrLang !== 'zh' && !r.loc?.[qrLang];
                              return (
                                <li
                                  key={`${i}-${r.text}`}
                                  className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-zinc-50"
                                >
                                  <button
                                    type="button"
                                    onClick={() => {
                                      appendToDraft(display);
                                      setShowQuickReplies(false);
                                    }}
                                    className="flex-1 text-left text-xs text-zinc-700"
                                    title={
                                      isFallback
                                        ? `尚无 ${qrLang.toUpperCase()} 翻译，将插入原文`
                                        : '插入到输入框'
                                    }
                                  >
                                    {display}
                                    {isFallback ? (
                                      <span className="ml-1 text-[10px] text-amber-500">（未翻译）</span>
                                    ) : null}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      persistQuickReplies(
                                        quickReplies.filter((_, idx) => idx !== i)
                                      )
                                    }
                                    className="rounded px-1 text-[11px] text-zinc-400 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                                    title="删除"
                                  >
                                    删除
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}

                        {/* 手动新增 */}
                        <div className="mt-1 border-t border-zinc-100 pt-2">
                          <div className="flex items-center gap-2">
                            <Input
                              value={qrManualInput}
                              onChange={(e) => setQrManualInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  addManualQuickReply();
                                }
                              }}
                              placeholder="手动添加一条话术，回车保存"
                              className="flex-1 text-xs"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={addManualQuickReply}
                              disabled={!qrManualInput.trim()}
                              className="text-xs"
                            >
                              添加
                            </Button>
                          </div>
                        </div>

                        {/* AI 生成区 */}
                        <div className="mt-1 border-t border-zinc-100 pt-2">
                          <div className="flex items-center gap-2">
                            <Input
                              value={aiQRTopic}
                              onChange={(e) => setAiQRTopic(e.target.value)}
                              placeholder="✨ 让 AI 写：场景，如「回复砍价」"
                              className="flex-1 text-xs"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              disabled={aiQRBusy}
                              onClick={generateQuickReplies}
                              className="text-xs"
                            >
                              {aiQRBusy ? '生成中…' : '生成'}
                            </Button>
                          </div>
                          {aiQRError ? (
                            <p className="mt-1 text-[11px] text-red-600">{aiQRError}</p>
                          ) : null}
                          {aiQRCandidates.length > 0 ? (
                            <div className="mt-2 flex flex-col gap-1">
                              {aiQRCandidates.map((c, i) => (
                                <label
                                  key={i}
                                  className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                                >
                                  <input
                                    type="checkbox"
                                    checked={aiQRSelected.has(i)}
                                    onChange={(e) => {
                                      setAiQRSelected((prev) => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.add(i);
                                        else next.delete(i);
                                        return next;
                                      });
                                    }}
                                    className="mt-0.5"
                                  />
                                  <span className="flex-1">{c}</span>
                                </label>
                              ))}
                              <div className="flex justify-end gap-2">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  onClick={() => {
                                    setAiQRCandidates([]);
                                    setAiQRSelected(new Set());
                                  }}
                                  className="text-xs"
                                >
                                  取消
                                </Button>
                                <Button
                                  type="button"
                                  variant="primary"
                                  onClick={adoptSelectedAiReplies}
                                  disabled={aiQRSelected.size === 0}
                                  className="text-xs"
                                >
                                  添加到常用（{aiQRSelected.size}）
                                </Button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <span className="ml-auto text-[11px] text-zinc-400">
                    {pendingMedia.length > 0 ? `${pendingMedia.length} 个附件待发送` : ''}
                  </span>
                </div>
              </form>
            </footer>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Empty
              title="选择一个会话"
              description="左侧选择会话查看消息，或先模拟一条收信"
            />
          </div>
        )}
      </section>

      {showCatalog && activeId ? (
        <CatalogPicker
          onClose={() => setShowCatalog(false)}
          onPick={openSendPanel}
        />
      ) : null}
      {sendPanel ? (
        <ProductSendPanel
          product={sendPanel.product}
          lang={sendPanel.lang}
          sending={sending}
          translatingLang={panelTranslating}
          translateError={panelTranslateError}
          onClose={() => {
            setSendPanel(null);
            setPanelTranslateError(null);
          }}
          onChangeLang={handlePanelChangeLang}
          onSend={runSend}
        />
      ) : null}
      {showNewChat ? (
        <NewChatModal
          onClose={() => setShowNewChat(false)}
          onCreated={async (conversationId) => {
            setShowNewChat(false);
            await refreshConversations();
            setActiveId(conversationId);
          }}
        />
      ) : null}
      {forwardTarget ? (
        <ForwardModal
          message={forwardTarget}
          conversations={conversations}
          excludeId={activeId ?? undefined}
          onClose={() => setForwardTarget(null)}
          onSubmit={(ids) => forwardSubmit(forwardTarget, ids)}
        />
      ) : null}
      {showAddContact && activeConv ? (
        <AddToContactsModal
          conversationId={activeConv.id}
          defaultName={activeConv.name}
          onClose={() => setShowAddContact(false)}
        />
      ) : null}
      {showAiExtract && activeConv ? (
        <AiExtractModal
          conversationId={activeConv.id}
          conversationName={activeConv.name}
          onClose={() => setShowAiExtract(false)}
        />
      ) : null}
    </div>
  );
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/** 气泡内时间：今天显示 HH:mm，其他天显示 M/D HH:mm，避免与日分隔条重复又能一眼看出跨天。 */
function formatBubbleTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hhmm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return hhmm;
  const md = d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  return `${md} ${hhmm}`;
}

/** 完整日期+时间，用于点击/悬停展开。年-月-日 HH:mm:ss。 */
function formatFullDateTime(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date} ${time}`;
}

/** 两个时间戳是否同一天（按本地时区）。用于在消息流里插入「今天 / 昨天 / 某月某日」分隔。 */
function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** 把时间戳格式化成「今天 / 昨天 / 周X / YYYY年M月D日」——用于聊天流里的日期分隔条。 */
function formatDayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((today - target) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays > 1 && diffDays < 7) {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]!;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  }
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** 聊天流里的日期分隔条：居中胶囊，灰白底，跟 WhatsApp 同样的视觉锚点。 */
function DayDivider({ ts }: { ts: number }) {
  return (
    <div className="my-2 flex items-center justify-center">
      <span className="rounded-full bg-white px-3 py-0.5 text-[11px] font-medium text-zinc-500 shadow-sm ring-1 ring-zinc-200">
        {formatDayLabel(ts)}
      </span>
    </div>
  );
}

/**
 * 销售阶段 + 偏好槽位 + 客户温度的展示条。
 * 摆在 AI 自动化状态栏右侧；纯展示（后续 P1 让 chip 可点击编辑）。
 */
function SalesStageChips({ conv }: { conv: Conversation | undefined }) {
  if (!conv) return null;
  const stage = conv.salesStage ?? 'S1';
  const STAGE_LABEL: Record<NonNullable<Conversation['salesStage']>, string> = {
    S1: '破冰', S2: '探询', S3: '推介', S4: '反馈', S5: '报价', S6: '物流', S7: '成交'
  };
  const SLOT_LABEL: Record<keyof NonNullable<Conversation['slots']>, string> = {
    category: '品类', occasion: '场景', colorPref: '颜色', priceBand: '价位', audience: '受众'
  };
  // 阶段配色：S1-S2 灰、S3-S4 蓝、S5 黄、S6 紫、S7 绿（成交）
  const stageColor: Record<NonNullable<Conversation['salesStage']>, string> = {
    S1: 'bg-zinc-100 text-zinc-700 ring-zinc-200',
    S2: 'bg-zinc-100 text-zinc-700 ring-zinc-200',
    S3: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
    S4: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
    S5: 'bg-amber-50 text-amber-700 ring-amber-200',
    S6: 'bg-violet-50 text-violet-700 ring-violet-200',
    S7: 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  };
  const temp = conv.leadTemperature;
  const tempLight = temp === 'hot' ? '🔴' : temp === 'warm' ? '🟡' : temp === 'cold' ? '🔵' : null;
  const slotEntries = (Object.entries(conv.slots ?? {}) as Array<
    [keyof NonNullable<Conversation['slots']>, string | undefined]
  >).filter(([, v]) => !!v);
  return (
    <div className="flex flex-wrap items-center gap-1.5" title="销售漏斗阶段 + AI 已收集到的客户偏好（自动）">
      <span
        className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${stageColor[stage]}`}
      >
        {stage}·{STAGE_LABEL[stage]}
      </span>
      {conv.needsHuman ? (
        <span
          className="animate-pulse rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 ring-1 ring-rose-300"
          title={conv.needsHumanReason || '待人工介入'}
        >
          ⚠️ 待人工报价
        </span>
      ) : null}
      {tempLight ? <span className="text-[10px]">{tempLight}</span> : null}
      {slotEntries.length > 0 ? (
        <span className="text-zinc-300">·</span>
      ) : null}
      {slotEntries.map(([k, v]) => (
        <span
          key={k}
          className="rounded-full bg-white px-1.5 py-0.5 text-[10px] text-zinc-600 ring-1 ring-zinc-200"
          title={`${SLOT_LABEL[k]}: ${v}`}
        >
          {SLOT_LABEL[k]} {v}
        </span>
      ))}
    </div>
  );
}

/**
 * 已读回执小标：✓ 已发服务端 / ✓✓ 已送达对方设备 / ✓✓(蓝) 已读。
 * - 仅对我方发出且已成功的消息显示
 * - 用 SVG 而不是 Unicode，是为了能控制双勾叠加与配色（已读=蓝色）
 */
function ReadTicks({ status, tone }: { status?: string; tone: 'light' | 'dark' }) {
  if (status !== 'sent' && status !== 'delivered' && status !== 'read') return null;
  const isRead = status === 'read';
  const isDouble = status === 'delivered' || status === 'read';
  // light = 紫底气泡上的浅色；dark = 白底（少见，留作扩展）
  const color = isRead
    ? '#4FC3F7'
    : tone === 'light'
      ? 'rgba(255,255,255,0.85)'
      : '#71717a';
  return (
    <span
      className="inline-flex items-center"
      title={isRead ? '对方已读' : isDouble ? '已送达' : '已发送'}
      aria-label={isRead ? '对方已读' : isDouble ? '已送达' : '已发送'}
    >
      <svg
        width={isDouble ? 16 : 12}
        height={10}
        viewBox={isDouble ? '0 0 16 10' : '0 0 12 10'}
        fill="none"
      >
        <path
          d="M1 5.5l3 3L11 1"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {isDouble ? (
          <path
            d="M5 5.5l3 3L15 1"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </svg>
    </span>
  );
}

/**
 * conversation.id 现在有两种形态：
 * - 纯数字（如 "85267619768"）：来自 @c.us 联系人或手输电话号
 * - "<lid>@lid"：来自 WhatsApp 隐私模式联系人，无电话号
 */
function formatConversationSubtitle(id: string): string {
  if (id.endsWith('@lid')) {
    const tail = id.slice(0, -4).slice(-4);
    return `WA 私密 ID · …${tail}`;
  }
  if (id.endsWith('@g.us')) return `群聊`;
  return `+${id}`;
}

function formatConversationDisplayName(id: string): string {
  if (id.endsWith('@lid')) {
    const tail = id.slice(0, -4).slice(-4);
    return `私密 …${tail}`;
  }
  if (id.endsWith('@g.us')) return '群聊';
  return id;
}

/* ====================================================================== */
/* AI 智能建议 + 发出语言锁 —— Inbox 专用辅助组件                            */
/* ====================================================================== */

function AiSuggestionsRow({
  items,
  busy,
  error,
  lang,
  lockedLang,
  displayLang,
  onDisplayLangChange,
  onDisable,
  onInsert,
  onSendDirect,
  onRefresh
}: {
  items: string[];
  busy: boolean;
  error: string | null;
  lang: string;
  lockedLang: string | null;
  displayLang: string;
  onDisplayLangChange: (next: string) => void;
  /** 点「×」关闭总开关 */
  onDisable: () => void;
  onInsert: (text: string) => void;
  onSendDirect: (text: string) => void | Promise<void>;
  onRefresh: () => void;
}) {
  if (!busy && items.length === 0 && !error) return null;
  const effectiveLang =
    displayLang && displayLang !== 'auto' ? displayLang : lockedLang || lang || 'auto';
  return (
    <div className="mb-2 rounded-md border border-indigo-100 bg-indigo-50/40 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-indigo-700">
        <div className="flex items-center gap-1.5">
          <span>✨ AI 建议（基于最近聊天）</span>
          <select
            value={displayLang}
            onChange={(e) => onDisplayLangChange(e.target.value)}
            title="选择建议的显示语言。实际发出仍随右上角「锁定」或客户语言。"
            className="rounded border border-indigo-200 bg-white px-1.5 py-0.5 text-[10px] text-indigo-700 focus:outline-none focus:ring-1 focus:ring-indigo-300"
          >
            <option value="auto">
              跟随{lockedLang ? `锁定 (${lockedLang})` : '客户语言'}
            </option>
            {SUPPORTED_LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.flag} {l.label}
              </option>
            ))}
          </select>
          {effectiveLang ? (
            <span
              className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[10px] text-indigo-700 ring-1 ring-indigo-100"
              title={
                lockedLang && displayLang !== 'auto' && displayLang !== lockedLang
                  ? `显示 ${effectiveLang}，发出时会自动译为 ${lockedLang}`
                  : '建议与发出同语言'
              }
            >
              {effectiveLang}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="rounded px-1.5 py-0.5 text-[11px] text-indigo-600 hover:bg-white/60 disabled:opacity-50"
            title="重新生成建议"
          >
            {busy ? '生成中…' : '↻ 刷新'}
          </button>
          <button
            type="button"
            onClick={onDisable}
            className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-white/60"
            title="关闭 AI 建议（不再自动生成，可节省 token）"
          >
            × 关闭
          </button>
        </div>
      </div>
      {error ? (
        <div className="text-[11px] text-rose-600">建议失败：{error}</div>
      ) : items.length === 0 && busy ? (
        <div className="text-[11px] text-zinc-500">正在为你准备话术…</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((t, i) => (
            <div
              key={i}
              className="group inline-flex items-center overflow-hidden rounded-full bg-white text-xs text-zinc-700 ring-1 ring-indigo-100 transition-colors hover:ring-indigo-300"
            >
              <button
                type="button"
                onClick={() => onInsert(t)}
                title="插入到输入框（可继续修改）"
                className="max-w-[420px] truncate px-3 py-1 hover:bg-indigo-50/60"
              >
                {t}
              </button>
              <button
                type="button"
                onClick={() => onSendDirect(t)}
                title="直接发送"
                className="border-l border-indigo-100 px-2 py-1 text-indigo-600 hover:bg-indigo-100"
              >
                ⚡
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LangLockButton({
  value,
  onChange
}: {
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  const cur = value ? SUPPORTED_LANGS.find((l) => l.code === value) : null;
  const label = cur ? `${cur.flag} ${cur.label}` : '🌐 自动';
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          value
            ? `已锁定发出语言：${cur?.englishName ?? value}。输入任意语言会自动翻译再发出。`
            : '未锁定：发什么就发什么。点击锁定一种发出语言。'
        }
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
          value
            ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
            : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50'
        }`}
      >
        <span>{label}</span>
        <span className="text-[10px] opacity-70">▾</span>
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-md border border-zinc-200 bg-white p-1.5 shadow-lg">
          <div className="px-2 py-1 text-[11px] text-zinc-500">
            发出时自动译成所选语言
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-zinc-100 ${
              !value ? 'bg-zinc-50 font-medium' : ''
            }`}
          >
            <span>🌐 自动（不强制翻译）</span>
            {!value ? <span className="text-emerald-600">✓</span> : null}
          </button>
          <div className="my-1 border-t border-zinc-100" />
          {SUPPORTED_LANGS.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => {
                onChange(l.code);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-zinc-100 ${
                value === l.code ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-zinc-700'
              }`}
            >
              <span>
                {l.flag} {l.label} · {l.englishName}
              </span>
              {value === l.code ? <span className="text-emerald-600">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AutoModeButton({
  value,
  fallback,
  onChange
}: {
  value: AutoMode | null;
  fallback: AutoMode;
  onChange: (next: AutoMode | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  const effective = value ?? fallback;
  const effectiveLabel = AUTO_MODE_ITEMS.find((x) => x.value === effective)?.short ?? effective;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
        title="切换当前会话 AI 自动化档位"
      >
        <span>自动</span>
        <span className="rounded bg-zinc-100 px-1 py-0.5 text-[10px]">{effectiveLabel}</span>
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-zinc-200 bg-white p-1 shadow-lg">
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={`mb-1 flex w-full items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-zinc-100 ${
              value == null ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-zinc-700'
            }`}
          >
            <span>跟随全局默认</span>
            <span className="text-[10px] text-zinc-500">{fallback}</span>
          </button>
          {AUTO_MODE_ITEMS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => {
                onChange(m.value);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-zinc-100 ${
                value === m.value ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-zinc-700'
              }`}
            >
              <span>{m.label}</span>
              {value === m.value ? <span className="text-emerald-600">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MessageBubble({
  message,
  onRetry,
  onReply,
  onReact,
  onForward
}: {
  message: Message;
  onRetry?: (m: Message) => void;
  /** 点击「引用」按钮：把该消息放进 composer 的 replyTo 槽位 */
  onReply?: (m: Message) => void;
  /** 点击 emoji：添加/取消我对该条消息的 reaction */
  onReact?: (m: Message, emoji: string) => void;
  /** 点击「转发」：弹出会话选择面板 */
  onForward?: (m: Message) => void;
}) {
  const isOut = message.direction === 'out';
  const failed = message.status === 'failed';
  const sending = message.status === 'sending';
  const [emojiOpen, setEmojiOpen] = useState(false);
  // 点击时间戳切换显示完整日期+时间（再次点击收起）
  const [showFullTs, setShowFullTs] = useState(false);
  const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const myReaction = (message.reactions ?? []).find((r) => r.from === 'me')?.emoji;
  // 聚合 reaction 为 emoji -> count，与 WA 行为一致
  const reactionGroups = (message.reactions ?? []).reduce<Record<string, number>>((acc, r) => {
    if (!r.emoji) return acc;
    acc[r.emoji] = (acc[r.emoji] ?? 0) + 1;
    return acc;
  }, {});
  const aiTag =
    message.aiSource === 'suggest-click'
      ? 'AI建议直发'
      : message.aiSource === 'auto-safe'
        ? 'AI安全自动'
        : message.aiSource === 'auto-full'
          ? 'AI全自动'
          : null;

  /** 悬停时显示的小工具条：引用 / 表情 / 转发。出/入站镜像放置。
   * 视觉：浮动卡片 + 微阴影 + 半透明背景，避免与气泡争夺注意力。
   */
  const Toolbar = onReply || onReact || onForward ? (
    <div className="relative flex items-center gap-0.5 rounded-full bg-white/95 px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-zinc-200 backdrop-blur transition group-hover:opacity-100">
      {onReply ? (
        <button
          type="button"
          onClick={() => onReply(message)}
          className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-indigo-600"
          title="引用这条消息"
          aria-label="引用这条消息"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M9 4L4 8l5 4M4 8h6a3 3 0 013 3v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      {onReact ? (
        <button
          type="button"
          onClick={() => setEmojiOpen((v) => !v)}
          className="rounded-full p-1 text-base leading-none hover:bg-zinc-100"
          title="添加表情"
          aria-label="添加表情"
        >
          <span aria-hidden>😊</span>
        </button>
      ) : null}
      {onForward ? (
        <button
          type="button"
          onClick={() => onForward(message)}
          className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-indigo-600"
          title="转发"
          aria-label="转发"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M7 4L12 8l-5 4M12 8H6a3 3 0 00-3 3v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      {emojiOpen && onReact ? (
        <div
          className={`absolute bottom-full z-10 mb-2 flex items-center gap-0.5 rounded-full bg-white px-1.5 py-1 shadow-lg ring-1 ring-zinc-200 ${
            isOut ? 'right-0' : 'left-0'
          }`}
        >
          {QUICK_EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                onReact(message, e);
                setEmojiOpen(false);
              }}
              className={`rounded-full px-1.5 py-0.5 text-lg transition hover:scale-125 hover:bg-zinc-100 ${
                myReaction === e ? 'bg-indigo-50' : ''
              }`}
              title={myReaction === e ? '取消这个表情' : `加 ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div className={`group flex flex-col gap-0.5 ${isOut ? 'items-end' : 'items-start'}`}>
      <div className={`relative flex items-center gap-2 ${isOut ? 'justify-end' : 'justify-start'}`}>
        {/* 出站消息：工具条放气泡左侧；入站消息：放右侧 */}
        {isOut ? Toolbar : null}
        <div
          className={`relative max-w-[80%] px-3.5 py-2 text-sm shadow-[0_1px_2px_rgba(0,0,0,0.06)] ${
            isOut
              ? `rounded-2xl rounded-br-md ${
                  failed
                    ? 'bg-red-50 text-red-900 ring-1 ring-red-200'
                    : message.aiAuto
                      ? 'bg-gradient-to-br from-[#0E9E96] to-[#0B8A83] text-white ring-1 ring-teal-300/40'
                      : 'bg-gradient-to-br from-[#6470DA] to-[#5E6AD2] text-white'
                }`
              : 'rounded-2xl rounded-bl-md bg-white text-zinc-900 ring-1 ring-zinc-200/80'
          }`}
        >
          {isOut && message.aiAuto ? (
            <div className="mb-1.5 flex items-center gap-1">
              <span
                className="inline-flex items-center rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] text-white/90 ring-1 ring-white/20"
                title={message.aiReason || 'AI 触发发送'}
              >
                {aiTag || 'AI发送'}
              </span>
            </div>
          ) : null}
          {/* 引用预览：渲染在气泡顶部，配色根据出/入站气泡略调以保证可读 */}
          {message.quoteText || message.quoteImageUrl ? (
            <div
              className={`mb-1.5 flex items-start gap-2 rounded-md border-l-2 px-2 py-1 text-[11px] leading-snug ${
                isOut
                  ? 'border-white/60 bg-white/10 text-white/85'
                  : 'border-[#5E6AD2] bg-zinc-50 text-zinc-600'
              }`}
              title="引用的消息内容"
            >
              {message.quoteImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={message.quoteImageUrl}
                  alt="引用的图片"
                  className="h-10 w-10 flex-shrink-0 rounded object-cover"
                />
              ) : null}
              {message.quoteText ? (
                <p className="line-clamp-3 whitespace-pre-wrap break-words">{message.quoteText}</p>
              ) : null}
            </div>
          ) : null}
          {message.imageUrls && message.imageUrls.length > 0 ? (
            <div className={`grid gap-1 ${message.imageUrls.length > 1 ? 'grid-cols-3' : 'grid-cols-1'} mb-2`}>
              {message.imageUrls.slice(0, 6).map((u) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={u}
                  src={u}
                  alt=""
                  className="aspect-square w-full rounded object-cover"
                />
              ))}
            </div>
          ) : null}
          {message.videoUrls && message.videoUrls.length > 0 ? (
            <div className="mb-2 grid gap-1">
              {message.videoUrls.slice(0, 3).map((u) => (
                <video
                  key={u}
                  src={u}
                  controls
                  preload="metadata"
                  className="max-h-72 w-full rounded bg-black"
                />
              ))}
            </div>
          ) : null}
          {message.text ? <p className="whitespace-pre-wrap">{message.text}</p> : null}
          {message.productTitle && !message.text ? (
            <p className="font-medium">{message.productTitle}</p>
          ) : null}
          <div
            className={`mt-1 flex items-center gap-1 text-[10px] ${
              isOut ? 'justify-end text-white/70' : 'text-zinc-400'
            }`}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowFullTs((v) => !v);
              }}
              title={formatFullDateTime(message.timestamp)}
              className={`cursor-pointer ${isOut ? 'hover:text-white' : 'hover:text-zinc-600'}`}
            >
              {showFullTs ? formatFullDateTime(message.timestamp) : formatBubbleTime(message.timestamp)}
            </button>
            {sending ? <span className="text-zinc-300">发送中…</span> : null}
            {failed ? <span className="font-medium text-red-200">发送失败</span> : null}
            {isOut && !failed && !sending ? (
              <ReadTicks status={message.status} tone="light" />
            ) : null}
          </div>
          {failed && message.error ? (
            <p className="mt-1 text-[10px] text-red-700">{message.error}</p>
          ) : null}
          {failed && onRetry ? (
            <button
              type="button"
              onClick={() => onRetry(message)}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-100"
            >
              重试
            </button>
          ) : null}
        </div>
        {!isOut ? Toolbar : null}
      </div>
      {/* reaction chips：贴在气泡下方对应的一侧，向上轻微叠在气泡角上，类似 WA 的小气泡
          注意：emoji 字形通常比文本基线高，必须给足行高 + 垂直 padding，否则会被裁掉上下半截 */}
      {Object.keys(reactionGroups).length > 0 ? (
        <div className={`relative z-10 -mt-1.5 flex flex-wrap gap-1 ${isOut ? 'justify-end pr-3' : 'justify-start pl-3'}`}>
          {Object.entries(reactionGroups).map(([emoji, count]) => {
            const mine = myReaction === emoji;
            return (
              <button
                key={emoji}
                type="button"
                onClick={() => onReact?.(message, emoji)}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[13px] leading-[1.1] shadow-sm ring-1 transition hover:-translate-y-0.5 ${
                  mine
                    ? 'bg-indigo-50 text-indigo-700 ring-indigo-200'
                    : 'bg-white text-zinc-700 ring-zinc-200 hover:bg-zinc-50'
                }`}
                title={mine ? '取消我的表情' : '加入这个表情'}
              >
                <span aria-hidden>{emoji}</span>
                {count > 1 ? <span className="text-[11px] font-medium text-zinc-500">{count}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 新建会话弹窗：输入电话号（E.164，不带 +）+ 可选备注名。
 * - 默认开 verify：服务端会用 client.isRegisteredUser 校验该号有没有注册 WA
 * - 已存在 canonical 会话时直接返回 → 直接跳进现成的会话
 */
function NewChatModal({
  onClose,
  onCreated
}: {
  onClose: () => void;
  onCreated: (conversationId: string) => void | Promise<void>;
}) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [verify, setVerify] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const digits = phone.replace(/\D/g, '');
  const phoneValid = digits.length >= 5 && digits.length <= 16;

  async function submit() {
    if (!phoneValid || submitting) return;
    setSubmitting(true);
    setError(null);
    setHint(null);
    try {
      const res = await fetch('/api/wa/conversations/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          phone: digits,
          name: name.trim() || undefined,
          verify
        })
      });
      const json = await res.json();
      if (!res.ok || json.ok === false) {
        setError(json.reason || `HTTP ${res.status}`);
        return;
      }
      if (json.alreadyExists) setHint('该会话已存在，直接打开');
      await onCreated(json.conversationId as string);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-950">新建会话</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <p className="mb-3 text-[11px] text-zinc-500">
          输入对方电话号即可（带或不带 + 都行），不需要先加入重点客户。
        </p>
        <label className="mb-2 block text-xs font-medium text-zinc-700">
          电话号
          <input
            autoFocus
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && phoneValid && !submitting) submit();
              if (e.key === 'Escape') onClose();
            }}
            placeholder="例如：8613800001234 或 +34 635 388 942"
            className="mt-1 w-full rounded border border-zinc-200 px-2 py-1.5 text-sm focus:border-[#5E6AD2] focus:outline-none focus:ring-2 focus:ring-[#5E6AD2]/30"
          />
          {phone && !phoneValid ? (
            <span className="mt-1 block text-[10px] text-red-600">
              号码长度需 5-16 位数字
            </span>
          ) : null}
        </label>
        <label className="mb-3 block text-xs font-medium text-zinc-700">
          备注名（可选）
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：Jason / 老王"
            className="mt-1 w-full rounded border border-zinc-200 px-2 py-1.5 text-sm focus:border-[#5E6AD2] focus:outline-none focus:ring-2 focus:ring-[#5E6AD2]/30"
          />
        </label>
        <label className="mb-3 flex items-center gap-2 text-[11px] text-zinc-600">
          <input
            type="checkbox"
            checked={verify}
            onChange={(e) => setVerify(e.target.checked)}
          />
          先校验该号码已注册 WhatsApp（推荐）
        </label>
        {error ? <p className="mb-2 text-[11px] text-red-600">{error}</p> : null}
        {hint ? <p className="mb-2 text-[11px] text-emerald-600">{hint}</p> : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!phoneValid || submitting}
            onClick={submit}
            className="rounded bg-[#5E6AD2] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4E5AC2] disabled:cursor-not-allowed disabled:bg-zinc-300"
          >
            {submitting ? '创建中…' : '创建会话'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CatalogPicker({
  onClose,
  onPick
}: {
  onClose: () => void;
  onPick: (p: CatalogProduct, lang: LangCode) => void | Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [lang, setLang] = useState<LangCode>(DEFAULT_LANG);
  // AI 检索
  const [aiQuery, setAiQuery] = useState('');
  const [aiSearching, setAiSearching] = useState(false);
  const [aiResult, setAiResult] = useState<{
    ids: string[];
    reasoning: string;
    query: string;
  } | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  // 以图搜图
  const imageSearchInputRef = useRef<HTMLInputElement>(null);
  const [imgSearching, setImgSearching] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const params = new URLSearchParams();
      if (q && !aiResult) params.set('q', q);
      const res = await fetch('/api/catalog?' + params.toString());
      const json = await res.json();
      if (!cancelled) {
        setItems(json.items ?? []);
        setLoading(false);
      }
    }
    const t = setTimeout(load, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, aiResult]);

  async function runAiSearch() {
    const query = aiQuery.trim();
    if (!query) return;
    const cfg = loadAiConfig();
    if (!isAiConfigured(cfg)) {
      setAiError('请先在「设置 → AI 模型」填写 Azure 配置');
      return;
    }
    setAiSearching(true);
    setAiError(null);
    try {
      const r = await fetch('/api/catalog/ai-search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          azure: {
            endpoint: cfg.endpoint,
            apiKey: cfg.apiKey,
            model: getEffectiveSearchModel(cfg)
          }
        })
      });
      const j = await r.json();
      if (!r.ok) setAiError(j?.error ?? `HTTP ${r.status}`);
      else setAiResult({ ids: j.ids ?? [], reasoning: j.reasoning ?? '', query });
    } catch (e: unknown) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiSearching(false);
    }
  }

  function clearAi() {
    setAiQuery('');
    setAiResult(null);
    setAiError(null);
  }

  /** 以图搜图：把选中的图片转 base64，POST 给 /api/catalog/ai-search-image */
  async function runImageSearch(file: File) {
    const cfg = loadAiConfig();
    if (!isAiConfigured(cfg)) {
      setAiError('请先在「设置 → AI 模型」填写 Azure 配置');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setAiError('图片过大（>8MB），请压缩后再试');
      return;
    }
    setImgSearching(true);
    setAiError(null);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      const r = await fetch('/api/catalog/ai-search-image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl: dataUrl,
          azure: {
            endpoint: cfg.endpoint,
            apiKey: cfg.apiKey,
            model: getEffectiveSearchModel(cfg)
          }
        })
      });
      const j = await r.json();
      if (!r.ok) {
        setAiError(j?.error ?? `HTTP ${r.status}`);
      } else {
        const kw = Array.isArray(j.keywords) ? j.keywords.join(' / ') : '';
        const desc = j.description ? `${j.description}` : '';
        setAiResult({
          ids: j.ids ?? [],
          reasoning: [desc, kw && `关键词：${kw}`].filter(Boolean).join('｜'),
          query: `📷 以图搜图`
        });
      }
    } catch (e: unknown) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setImgSearching(false);
      if (imageSearchInputRef.current) imageSearchInputRef.current.value = '';
    }
  }

  // AI 命中后按相关性排序
  const visible = useMemo(() => {
    if (!aiResult) return items;
    const map = new Map(items.map((p) => [p.id, p] as const));
    return aiResult.ids.map((id) => map.get(id)).filter((p): p is CatalogProduct => !!p);
  }, [items, aiResult]);

  async function handlePick(p: CatalogProduct) {
    setPicking(p.id);
    try {
      await onPick(p, lang);
    } finally {
      setPicking(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1" />
      <aside
        className="flex h-screen w-[520px] flex-col border-l border-zinc-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-zinc-200 px-5 py-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-950">从 Catalog 选商品</h3>
            <Button size="sm" variant="ghost" onClick={onClose}>
              关闭
            </Button>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            点商品 → 进入发送面板，可选图、改文案、选「逐张发送」或「拼成一张」。
          </p>

          {/* 语言选择 */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-zinc-500">语言</span>
            {SUPPORTED_LANGS.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => setLang(l.code)}
                className={`rounded px-2 py-1 text-xs ${
                  lang === l.code
                    ? 'bg-zinc-900 text-white'
                    : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                }`}
                title={l.englishName}
              >
                {l.flag} {l.label}
              </button>
            ))}
          </div>

          {/* AI 检索 */}
          <div className="mt-3 flex items-center gap-1.5">
            <div className="relative flex-1">
              <Input
                value={aiQuery}
                onChange={(e) => setAiQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !aiSearching) runAiSearch();
                }}
                placeholder="AI 检索：例如「黑色女士斜挎包 1000 元内」"
                className="pl-7"
                disabled={aiSearching}
              />
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-[#5E6AD2]">
                ✦
              </span>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={runAiSearch}
              disabled={!aiQuery.trim() || aiSearching}
            >
              {aiSearching ? '检索中…' : 'AI 检索'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => imageSearchInputRef.current?.click()}
              disabled={imgSearching}
              title="上传一张图，AI 多模态识图后在 Catalog 里找同款 / 相似款"
            >
              {imgSearching ? '识图中…' : '📷 以图搜图'}
            </Button>
            <input
              ref={imageSearchInputRef}
              type="file"
              accept="image/*"
              aria-label="上传图片以图搜图"
              title="上传图片以图搜图"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void runImageSearch(f);
              }}
            />
            {aiResult || aiError ? (
              <Button size="sm" variant="ghost" onClick={clearAi}>
                清除
              </Button>
            ) : null}
          </div>
          {aiError ? (
            <p className="mt-1.5 text-[11px] text-red-600">{aiError}</p>
          ) : aiResult ? (
            <p className="mt-1.5 text-[11px] text-[#5E6AD2]">
              ✦ 「{aiResult.query}」命中 {aiResult.ids.length} 件
              {aiResult.reasoning ? ` · ${aiResult.reasoning}` : ''}
            </p>
          ) : null}

          {/* 普通关键字搜索（AI 结果存在时禁用） */}
          {!aiResult ? (
            <div className="mt-2">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索 标题 / 品牌 / 型号"
              />
            </div>
          ) : null}
        </header>
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <p className="py-6 text-center text-xs text-zinc-400">加载中…</p>
          ) : visible.length === 0 ? (
            <Empty
              title={aiResult ? 'AI 没找到匹配项' : 'Catalog 还没有商品'}
              description={aiResult ? '换个描述再试' : '去 Catalog 抓一个先'}
              action={
                <Link href="/catalog">
                  <Button variant="primary" size="sm">
                    去 Catalog
                  </Button>
                </Link>
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {visible.map((p) => {
                const loc = lang !== 'zh' ? p.localizations?.[lang] : undefined;
                const displayTitle = loc?.title || p.title;
                const isBusy = picking === p.id;
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => handlePick(p)}
                    disabled={isBusy || picking !== null}
                    className="group relative overflow-hidden rounded-lg border border-zinc-200 bg-white text-left transition-shadow hover:shadow-md disabled:opacity-60"
                  >
                    <div className="aspect-square overflow-hidden bg-zinc-100">
                      {p.mainImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.mainImage}
                          alt=""
                          className="h-full w-full object-cover transition group-hover:scale-105"
                        />
                      ) : null}
                    </div>
                    <div className="space-y-0.5 p-2">
                      <p className="line-clamp-1 text-xs font-medium text-zinc-900">{displayTitle}</p>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-[#5E6AD2]">{p.price}</span>
                        <Badge tone="muted">{1 + p.galleryImages.length}图</Badge>
                      </div>
                    </div>
                    {isBusy ? (
                      <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-xs font-medium text-[#5E6AD2]">
                        加载中…
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/**
 * 商品发送面板（picker 之后的第二步）：
 * - 顶部：商品标题 + 价格 + 语言切换
 * - 文案 textarea（默认拼好的卖点话术，可编辑）
 * - 图片网格 checkbox（默认主图+全部 gallery 全选）
 * - 发送模式：
 *    • 逐张发送：先发文案，再每张图 600ms 间隔发出（朋友逐张接收）
 *    • 拼成一张：本地 canvas 把选中图拼成一张大图，文案 + 1 张图，朋友一次到达
 * - 「发送」按钮 disable 直到至少有文案或图片
 */
function ProductSendPanel({
  product,
  lang,
  sending,
  translatingLang,
  translateError,
  onClose,
  onChangeLang,
  onSend
}: {
  product: CatalogProduct;
  lang: LangCode;
  sending: boolean;
  /** 正在翻译的语言 code（null = 空闲） */
  translatingLang: LangCode | null;
  translateError: string | null;
  onClose: () => void;
  onChangeLang: (l: LangCode) => void;
  onSend: (opts: {
    product: CatalogProduct;
    lang: LangCode;
    caption: string;
    imageUrls: string[];
    mode: 'per-image' | 'collage';
  }) => void | Promise<void>;
}) {
  // 当前语言下的本地化（无则原文）
  const loc = lang !== 'zh' ? product.localizations?.[lang] : null;
  const title = loc?.title || product.title;
  const bullets = (loc?.descriptionBullets ?? product.descriptionBullets ?? []).filter(Boolean);
  const priceText = product.price && product.price !== '价格待确认' ? product.price : '';

  // 所有图：主图 + 组图，去重，最多 10 张（whatsapp-web 单批体验阈）
  const allImages = useMemo(
    () =>
      Array.from(new Set([product.mainImage, ...product.galleryImages].filter(Boolean))).slice(
        0,
        10
      ),
    [product]
  );

  const [selected, setSelected] = useState<Set<string>>(() => new Set(allImages));
  // 默认拼图：朋友一次接收、不被迫迫收 N 张。若选不足 2 张会被下面 useEffect 回退为 per-image。
  const [mode, setMode] = useState<'per-image' | 'collage'>('collage');
  // 本地准备发送状态：点下发送 → 拼图 → 交给外层发。为了避免拼图期间重复点击。
  const [preparing, setPreparing] = useState<null | 'collage' | 'polish'>(null);
  // === 文案三件套 ===
  // 1）是否附带文案（取消后只发图）
  const [includeCaption, setIncludeCaption] = useState(true);
  // 2）补充描述：独立于语言切换，永不重置
  const [extraCaption, setExtraCaption] = useState('');
  // 3）AI 润色
  const [usePolish, setUsePolish] = useState(false);
  const [audience, setAudience] = useState<'standard' | 'wholesale' | 'vip' | 'priceSensitive' | 'qualityFirst'>(
    'standard'
  );
  const [polishedText, setPolishedText] = useState<string | null>(null);
  const [polishing, setPolishing] = useState(false);
  const [polishError, setPolishError] = useState<string | null>(null);
  // 文案：随语言变化重置；用户手改后保留
  const defaultCaption = useMemo(() => {
    return [
      title,
      priceText ? `💰 ${priceText}` : '',
      ...bullets.slice(0, 6).map((b) => `• ${b}`)
    ]
      .filter(Boolean)
      .join('\n');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, priceText, bullets.join('|')]);
  const [caption, setCaption] = useState(defaultCaption);
  // 切语言时刷新默认文案（用户可以再改）
  useEffect(() => {
    setCaption(defaultCaption);
  }, [defaultCaption]);
  // 切商品时重置选图 + 补充描述 + AI 润色预览（补充描述是该商品该谈判场景专属的）
  useEffect(() => {
    setSelected(new Set(allImages));
    setExtraCaption('');
    setPolishedText(null);
    setPolishError(null);
  }, [allImages, product.id]);
  // 任何输入变动都使上一次的 AI 润色结果失效，避免发错内容
  useEffect(() => {
    setPolishedText(null);
  }, [caption, extraCaption, audience, lang]);

  // 拼图需要 ≥2 张；不足时自动回退为逐张发送，避免「默认拼图」与「只有1 张」冲突
  useEffect(() => {
    setMode((m) => (m === 'collage' && selected.size < 2 ? 'per-image' : m));
  }, [selected.size]);

  const selectedList = allImages.filter((u) => selected.has(u));
  // 该语言是否已准备好（中文或已有缓存）
  const langReady = lang === 'zh' || !!product.localizations?.[lang];
  const isTranslating = translatingLang !== null;
  const isPreparing = preparing !== null;
  const isPolishing = polishing;
  // “将要发出”的文案预览：
  //  • 未附带 → 空串
  //  • AI 润色且已生成预览 → 预览文本
  //  • 其余 → 基础 + 补充拼接
  const mergedRaw = useMemo(() => {
    const parts = [caption.trim(), extraCaption.trim()].filter(Boolean);
    return parts.join('\n\n');
  }, [caption, extraCaption]);
  const finalCaption = !includeCaption ? '' : usePolish && polishedText ? polishedText : mergedRaw;
  const canSend =
    !sending &&
    !isTranslating &&
    !isPreparing &&
    !isPolishing &&
    langReady &&
    ((includeCaption && mergedRaw.length > 0) || selectedList.length > 0);

  async function runPolish(): Promise<string | null> {
    const cfg = loadAiConfig();
    if (!isAiConfigured(cfg)) {
      setPolishError('未配置 AI：请先在「设置 → AI 模型」填写 Endpoint / API Key');
      return null;
    }
    setPolishing(true);
    setPolishError(null);
    try {
      const r = await fetch('/api/ai/polish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          base: caption.trim(),
          extra: extraCaption.trim(),
          lang,
          audience,
          azure: {
            endpoint: cfg.endpoint,
            apiKey: cfg.apiKey,
            model: getEffectiveSearchModel(cfg)
          }
        })
      });
      const j = await r.json();
      if (!r.ok || !j?.polished) {
        setPolishError(j?.error || `润色失败 (HTTP ${r.status})`);
        return null;
      }
      setPolishedText(j.polished);
      return j.polished as string;
    } catch (e) {
      setPolishError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setPolishing(false);
    }
  }

  async function handleSendClick() {
    if (!canSend) return;
    // 勾选了 AI 润色但还没生成：先生成，拿不到则兑退送
    let textToSend = finalCaption;
    if (includeCaption && usePolish && !polishedText) {
      setPreparing('polish');
      const polished = await runPolish();
      setPreparing(null);
      if (!polished) return; // 润色失败不发
      textToSend = polished;
    }
    // 拼图模式且 ≥2 张：先进入「拼图中」状态，避免重复点击
    if (mode === 'collage' && selectedList.length >= 2) {
      setPreparing('collage');
    }
    try {
      await onSend({
        product,
        lang,
        caption: textToSend,
        imageUrls: selectedList,
        mode
      });
    } finally {
      setPreparing(null);
    }
  }

  function toggle(u: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(u)) next.delete(u);
      else next.add(u);
      return next;
    });
  }
  function selectAll() {
    setSelected(new Set(allImages));
  }
  function selectNone() {
    setSelected(new Set());
  }

  return (
    <div className="fixed inset-0 z-[60] flex" onClick={onClose}>
      <div className="flex-1 bg-black/30" />
      <aside
        className="flex h-screen w-[560px] flex-col border-l border-zinc-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-zinc-200 px-5 py-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-950">发送商品</h3>
            <Button size="sm" variant="ghost" onClick={onClose}>
              关闭
            </Button>
          </div>
          <p className="mt-1 truncate text-xs text-zinc-500">{title}</p>

          {/* 语言切换 */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-zinc-500">语言</span>
            {SUPPORTED_LANGS.map((l) => {
              const active = lang === l.code;
              const hasCache = l.code === 'zh' || !!product.localizations?.[l.code];
              const busy = translatingLang === l.code;
              const disabled = isTranslating && !busy; // 翻译中禁止再点别的
              return (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => onChangeLang(l.code)}
                  disabled={disabled}
                  title={hasCache ? l.englishName : `${l.englishName}（按需翻译）`}
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition ${
                    active
                      ? 'bg-zinc-900 text-white'
                      : hasCache
                        ? 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                        : 'border border-dashed border-zinc-300 text-zinc-500 hover:border-zinc-400'
                  } ${busy ? 'opacity-70' : ''} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                >
                  <span>{l.flag}</span>
                  <span>{l.label}</span>
                  {busy ? <span className="animate-pulse">…</span> : null}
                </button>
              );
            })}
          </div>
          {translateError ? (
            <p className="mt-1.5 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
              {translateError}
            </p>
          ) : null}
          {isTranslating ? (
            <p className="mt-1.5 text-[11px] text-zinc-500">正在翻译为目标语言，完成后才能发送…</p>
          ) : null}
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {/* 文案区块 */}
          <div className="space-y-3">
            {/* 1) 附带文案开关：取消 = 只发图，不发文 */}
            <label className="flex items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50/60 px-2.5 py-2">
              <input
                type="checkbox"
                checked={includeCaption}
                onChange={(e) => setIncludeCaption(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300 text-[#5E6AD2] focus:ring-[#5E6AD2]"
              />
              <span className="flex-1 text-[12px] leading-5 text-zinc-700">
                <span className="font-medium text-zinc-900">附带文案一起发</span>
                <span className="ml-2 text-[11px] text-zinc-500">
                  取消勾选后将只发送图片，不发送任何文字
                </span>
              </span>
            </label>

            {/* 2) 基础文案 */}
            <div className={includeCaption ? '' : 'opacity-40 pointer-events-none'}>
              <div className="flex items-center justify-between">
                <Label>商品文案（基础卖点，可编辑）</Label>
                <button
                  type="button"
                  onClick={() => setCaption(defaultCaption)}
                  className="text-[11px] text-[#5E6AD2] hover:underline"
                >
                  还原默认
                </button>
              </div>
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                rows={5}
                placeholder="商品文案"
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-[12px] leading-5 text-zinc-950 focus:border-[#5E6AD2] focus:outline-none focus:ring-2 focus:ring-[#5E6AD2]/30"
              />
            </div>

            {/* 3) 补充描述：针对这个客户/这次会话的临时备注 */}
            <div className={includeCaption ? '' : 'opacity-40 pointer-events-none'}>
              <div className="flex items-center justify-between">
                <Label>补充描述（针对这个客户的本次推介，可选）</Label>
                <span className="text-[11px] text-zinc-400">{extraCaption.length} 字</span>
              </div>
              <textarea
                value={extraCaption}
                onChange={(e) => setExtraCaption(e.target.value)}
                rows={3}
                placeholder="例如：客户问的就是这款，刚到货 2 件、可以现货发出；或：上次她看过的同系列新色到了…"
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[12px] leading-5 text-zinc-950 focus:border-[#5E6AD2] focus:outline-none focus:ring-2 focus:ring-[#5E6AD2]/30"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                发送时会与基础文案合并；若启用 AI 润色，AI 会重新统一语种与风格。
              </p>
            </div>

            {/* 4) AI 润色：客户类型 + 预览 / 重新生成 */}
            <div
              className={`rounded-md border px-2.5 py-2 ${
                usePolish ? 'border-[#5E6AD2]/50 bg-[#5E6AD2]/[0.04]' : 'border-zinc-200 bg-white'
              } ${includeCaption ? '' : 'opacity-40 pointer-events-none'}`}
            >
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={usePolish}
                  onChange={(e) => setUsePolish(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300 text-[#5E6AD2] focus:ring-[#5E6AD2]"
                />
                <span className="flex-1 text-[12px] leading-5 text-zinc-700">
                  <span className="font-medium text-zinc-900">用 AI 润色（合并基础+补充，统一语种与卖点）</span>
                  <span className="ml-2 text-[11px] text-zinc-500">按客户类型调整语气</span>
                </span>
              </label>

              {usePolish ? (
                <div className="mt-2 space-y-2 pl-5">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-zinc-500">客户类型</span>
                    <select
                      aria-label="客户类型"
                      title="客户类型"
                      value={audience}
                      onChange={(e) => setAudience(e.target.value as typeof audience)}
                      className="h-7 rounded border border-zinc-200 bg-white px-1.5 text-[11px] focus:border-[#5E6AD2] focus:outline-none"
                    >
                      <option value="standard">标准客户</option>
                      <option value="wholesale">批发客户</option>
                      <option value="vip">VIP / 高净值</option>
                      <option value="priceSensitive">价格敏感</option>
                      <option value="qualityFirst">品质优先</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => runPolish()}
                      disabled={isPolishing || (!caption.trim() && !extraCaption.trim())}
                      className="ml-auto h-7 rounded-md border border-zinc-200 bg-white px-2 text-[11px] text-zinc-700 hover:border-[#5E6AD2] hover:text-[#5E6AD2] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isPolishing ? '生成中…' : polishedText ? '重新生成' : '预览 AI 文案'}
                    </button>
                  </div>

                  {polishError ? (
                    <p className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
                      {polishError}
                    </p>
                  ) : null}

                  {polishedText ? (
                    <div>
                      <Label>AI 润色结果（可编辑）</Label>
                      <textarea
                        aria-label="AI 润色结果"
                        title="AI 润色结果"
                        placeholder="AI 润色结果"
                        value={polishedText}
                        onChange={(e) => setPolishedText(e.target.value)}
                        rows={6}
                        className="mt-1 w-full rounded-md border border-[#5E6AD2]/40 bg-white px-2.5 py-1.5 text-[12px] leading-5 text-zinc-950 focus:border-[#5E6AD2] focus:outline-none focus:ring-2 focus:ring-[#5E6AD2]/30"
                      />
                      <p className="mt-1 text-[11px] text-zinc-500">
                        将以这段文案发送。修改基础/补充/客户类型/语言后需要重新生成。
                      </p>
                    </div>
                  ) : (
                    <p className="text-[11px] text-zinc-500">
                      未生成预览；点击「发送」会先自动生成再发送。
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {/* 图片选择 */}
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <Label>
                图片（{selectedList.length}/{allImages.length}）
              </Label>
              <div className="flex gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={selectAll}
                  className="text-[#5E6AD2] hover:underline"
                >
                  全选
                </button>
                <span className="text-zinc-300">·</span>
                <button
                  type="button"
                  onClick={selectNone}
                  className="text-zinc-500 hover:underline"
                >
                  全不选
                </button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {allImages.map((u, i) => {
                const on = selected.has(u);
                return (
                  <button
                    key={u}
                    type="button"
                    onClick={() => toggle(u)}
                    className={`relative aspect-square overflow-hidden rounded-md border-2 transition ${
                      on ? 'border-[#5E6AD2]' : 'border-transparent opacity-50 hover:opacity-80'
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u} alt="" className="h-full w-full object-cover" />
                    {i === 0 ? (
                      <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] font-medium text-white">
                        主图
                      </span>
                    ) : null}
                    <span
                      className={`absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
                        on ? 'bg-[#5E6AD2] text-white' : 'bg-white/80 text-zinc-400'
                      }`}
                    >
                      {on ? '✓' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 发送模式 */}
          <div className="mt-4">
            <Label>发送方式</Label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <ModeOption
                active={mode === 'per-image'}
                onClick={() => setMode('per-image')}
                title="逐张发送"
                desc={`先发文案，再依次发 ${selectedList.length || 0} 张图（约 ${
                  Math.max(0, selectedList.length - 1) * 0.6 + (includeCaption && finalCaption ? 0.6 : 0)
                }s）`}
              />
              <ModeOption
                active={mode === 'collage'}
                onClick={() => setMode('collage')}
                disabled={selectedList.length < 2}
                title="拼成一张"
                desc={
                  selectedList.length < 2
                    ? '至少选 2 张才能拼图'
                    : `本地拼成 1 张大图发出（朋友一次接收）`
                }
              />
            </div>
          </div>
        </div>

        {/* 底部操作 */}
        <footer className="border-t border-zinc-200 bg-white px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-zinc-500">
              {preparing === 'polish'
                ? '正在调用 AI 生成文案，请稍候…'
                : preparing === 'collage'
                  ? `正在把 ${selectedList.length} 张图拼成 1 张大图，请稍候…`
                  : !includeCaption
                    ? '仅发送图片（不附带文案）'
                    : mode === 'collage'
                      ? '将本地拼图（仅你看到为大图，朋友收到也是 1 张）'
                      : ''}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose} disabled={sending}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={!canSend}
                title={
                  !langReady
                    ? '当前语言还没有翻译版本，请等翻译完成或切回已缓存的语言'
                    : undefined
                }
                onClick={handleSendClick}
              >
                {sending
                  ? '发送中…'
                  : preparing === 'polish'
                    ? '生成文案中…'
                    : preparing === 'collage'
                      ? '拼图中…'
                      : isTranslating
                        ? '翻译中…'
                        : '发送'}
              </Button>
            </div>
          </div>
        </footer>
      </aside>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-[11px] font-medium text-zinc-600">{children}</label>;
}

function ModeOption({
  active,
  disabled,
  onClick,
  title,
  desc
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border p-2.5 text-left transition disabled:opacity-50 ${
        active
          ? 'border-[#5E6AD2] bg-[#5E6AD2]/5'
          : 'border-zinc-200 bg-white hover:border-zinc-300'
      }`}
    >
      <p
        className={`text-xs font-medium ${
          active ? 'text-[#5E6AD2]' : 'text-zinc-900'
        }`}
      >
        {title}
      </p>
      <p className="mt-1 text-[10px] leading-4 text-zinc-500">{desc}</p>
    </button>
  );
}

/**
 * 会话项右侧的 ⋯ 菜单：重命名 / 合并到… / 删除
 * 解决 LID/电话双线串号、以及 push name 缺失时无法识别的痛点。
 */
function ConversationMenu({
  conv,
  allConvs,
  onChanged
}: {
  conv: Conversation;
  allConvs: Conversation[];
  onChanged: (nextActiveId?: string | null) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'rename' | 'merge'>('menu');
  const [renameValue, setRenameValue] = useState(conv.name ?? '');
  const [mergeTarget, setMergeTarget] = useState<string>('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setMode('menu');
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function doRename() {
    const name = renameValue.trim();
    await fetch(`/api/wa/conversations/${encodeURIComponent(conv.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    });
    setOpen(false);
    setMode('menu');
    await onChanged();
  }

  async function doMerge() {
    if (!mergeTarget) return;
    await fetch(`/api/wa/conversations/${encodeURIComponent(conv.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mergeInto: mergeTarget })
    });
    setOpen(false);
    setMode('menu');
    await onChanged(mergeTarget);
  }

  async function doDelete() {
    if (!confirm(`删除会话「${conv.name || conv.id}」及其所有消息？`)) return;
    await fetch(`/api/wa/conversations/${encodeURIComponent(conv.id)}`, { method: 'DELETE' });
    setOpen(false);
    setMode('menu');
    await onChanged(null);
  }

  async function doTogglePin() {
    await fetch(`/api/wa/conversations/${encodeURIComponent(conv.id)}/pin`, { method: 'POST' });
    setOpen(false);
    setMode('menu');
    await onChanged();
  }

  const others = allConvs.filter((c) => c.id !== conv.id);

  return (
    <div ref={ref} className="absolute right-2 top-2">
      <button
        type="button"
        aria-label="会话菜单"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
          setMode('menu');
          setRenameValue(conv.name ?? '');
        }}
        className={`rounded p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 ${
          open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        ⋯
      </button>
      {open ? (
        <div
          className="absolute right-0 top-7 z-20 w-64 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {mode === 'menu' ? (
            <div className="py-1 text-xs">
              <MenuItem onClick={doTogglePin}>
                {conv.pinned ? '📌 取消置顶' : '📌 置顶会话'}
              </MenuItem>
              <MenuItem onClick={() => setMode('rename')}>✎ 重命名</MenuItem>
              <MenuItem
                onClick={() => {
                  setMergeTarget('');
                  setMode('merge');
                }}
                disabled={others.length === 0}
              >
                ⇄ 合并到另一会话…
              </MenuItem>
              <div className="my-1 border-t border-zinc-100" />
              <MenuItem onClick={doDelete} danger>
                🗑 删除会话
              </MenuItem>
            </div>
          ) : mode === 'rename' ? (
            <div className="p-3">
              <p className="mb-2 text-[11px] text-zinc-500">给这个会话起个你认得的名字</p>
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doRename();
                  if (e.key === 'Escape') setMode('menu');
                }}
                placeholder="例如：老王 / Jason / 测试号"
                className="w-full rounded border border-zinc-200 px-2 py-1 text-xs focus:border-[#5E6AD2] focus:outline-none focus:ring-2 focus:ring-[#5E6AD2]/30"
              />
              <div className="mt-2 flex justify-end gap-1">
                <button
                  type="button"
                  onClick={() => setMode('menu')}
                  className="rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-100"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={doRename}
                  className="rounded bg-[#5E6AD2] px-2 py-1 text-[11px] font-medium text-white hover:bg-[#4E5AC2]"
                >
                  保存
                </button>
              </div>
            </div>
          ) : (
            <div className="p-3">
              <p className="mb-2 text-[11px] text-zinc-500">
                把当前会话的所有消息合并到目标会话，自身将被删除（不可撤销）
              </p>
              <div className="max-h-48 overflow-y-auto rounded border border-zinc-200">
                {others.length === 0 ? (
                  <p className="px-2 py-3 text-center text-[11px] text-zinc-400">没有其它会话</p>
                ) : (
                  others.map((o) => {
                    const sel = mergeTarget === o.id;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => setMergeTarget(o.id)}
                        className={`block w-full border-b border-zinc-100 px-2 py-1.5 text-left text-[11px] last:border-b-0 ${
                          sel ? 'bg-[#5E6AD2]/10 text-[#5E6AD2]' : 'hover:bg-zinc-50'
                        }`}
                      >
                        <div className="truncate font-medium">
                          {o.name || formatConversationDisplayName(o.id)}
                        </div>
                        <div className="truncate text-[10px] text-zinc-400">
                          {formatConversationSubtitle(o.id)}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="mt-2 flex justify-end gap-1">
                <button
                  type="button"
                  onClick={() => setMode('menu')}
                  className="rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-100"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={doMerge}
                  disabled={!mergeTarget}
                  className="rounded bg-[#5E6AD2] px-2 py-1 text-[11px] font-medium text-white hover:bg-[#4E5AC2] disabled:opacity-50"
                >
                  合并
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
  danger
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`block w-full px-3 py-1.5 text-left text-xs disabled:opacity-40 ${
        danger ? 'text-red-600 hover:bg-red-50' : 'text-zinc-700 hover:bg-zinc-50'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 把当前 active 会话的对方加入重点客户。
 * 自动从 conversationId 推断 phone（@c.us / 纯数字）或 lid（@lid），
 * 仅做一次 upsert（重复时合并不空覆盖）。
 */
function AddToContactsModal({
  conversationId,
  defaultName,
  onClose
}: {
  conversationId: string;
  defaultName?: string;
  onClose: () => void;
}) {
  const isLid = conversationId.endsWith('@lid');
  const phoneFromId = isLid ? '' : conversationId.replace(/@.*/, '');
  const [name, setName] = useState(defaultName ?? '');
  const [phone, setPhone] = useState(phoneFromId);
  const [lid, setLid] = useState(isLid ? conversationId : '');
  const [company, setCompany] = useState('');
  const [note, setNote] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: boolean } | null>(null);

  const submit = async () => {
    setErr(null);
    if (!phone.trim() && !lid.trim()) {
      setErr('phone 或 lid 至少要填一个');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: phone.trim() || undefined,
          lid: lid.trim() || undefined,
          name: name.trim() || undefined,
          company: company.trim() || undefined,
          note: note.trim() || undefined,
          tags: tagsInput
            .split(/[,，;；]/)
            .map((s) => s.trim())
            .filter(Boolean),
          source: 'inbox'
        })
      });
      const j = await r.json();
      if (!r.ok) {
        setErr(j.error ?? r.statusText);
        return;
      }
      setDone({ created: !!j.created });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold">加入重点客户</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900">
            ✕
          </button>
        </header>
        {done ? (
          <div className="px-5 py-6 text-sm">
            <p className="mb-3 text-emerald-700">
              {done.created ? '✓ 已加入重点客户' : '✓ 重点客户中已存在，已合并新信息'}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                关闭
              </Button>
              <Link
                href="/contacts"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700"
              >
                去重点客户查看
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3 px-5 py-4 text-xs">
              <label className="block">
                <span className="mb-1 block text-zinc-600">姓名</span>
                <input
                  className="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-zinc-600">电话</span>
                  <input
                    className="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="E.164 不带 +"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-zinc-600">LID</span>
                  <input
                    className="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm font-mono text-[11px]"
                    value={lid}
                    onChange={(e) => setLid(e.target.value)}
                    placeholder="…@lid"
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-zinc-600">公司</span>
                <input
                  className="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-zinc-600">标签（逗号分隔）</span>
                <input
                  className="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="鞋类, 美国客户"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-zinc-600">备注</span>
                <textarea
                  className="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm"
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              {err ? <p className="text-rose-600">{err}</p> : null}
            </div>
            <footer className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
              <Button variant="ghost" onClick={onClose}>
                取消
              </Button>
              <Button onClick={submit} disabled={busy}>
                {busy ? '保存中…' : '加入'}
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 用 AI 从当前会话最近 60 条消息里抽取联系人草稿，确认后入重点客户。
 * 直接读 localStorage 里的 AI 配置（与翻译快捷话术等保持同一套）。
 */
function AiExtractModal({
  conversationId,
  conversationName,
  onClose
}: {
  conversationId: string;
  conversationName?: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    name?: string;
    company?: string;
    position?: string;
    phone?: string;
    lid?: string;
    tags?: string[];
    note?: string;
  } | null>(null);
  const [meta, setMeta] = useState<{
    kind: 'phone' | 'lid' | 'group';
    me?: { name?: string; id?: string };
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ created: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = loadAiConfig();
        if (!isAiConfigured(cfg)) {
          setErr('未配置 AI：请到「设置 → AI 模型」填写 Endpoint / API Key');
          return;
        }
        const r = await fetch('/api/contacts/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId,
            azure: {
              endpoint: cfg.endpoint,
              apiKey: cfg.apiKey,
              model: getEffectiveModel(cfg)
            }
          })
        });
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setErr(j.error ?? r.statusText);
          return;
        }
        setDraft(j.draft ?? {});
        setMeta(j.meta ?? null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, source: 'ai' })
      });
      const j = await r.json();
      if (!r.ok) {
        setErr(j.error ?? r.statusText);
        return;
      }
      setDone({ created: !!j.created });
    } finally {
      setSaving(false);
    }
  };

  const kind = meta?.kind ?? (conversationId.endsWith('@lid') ? 'lid' : conversationId.endsWith('@g.us') ? 'group' : 'phone');
  const kindLabel =
    kind === 'lid' ? 'WA 私密 ID' : kind === 'group' ? '群聊' : '电话号';
  const kindColor =
    kind === 'lid'
      ? 'bg-amber-50 text-amber-700 ring-amber-200'
      : kind === 'group'
        ? 'bg-zinc-100 text-zinc-600 ring-zinc-200'
        : 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  const convDisplay =
    kind === 'lid'
      ? conversationId
      : kind === 'group'
        ? conversationId
        : `+${conversationId.replace(/@.*/, '')}`;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold">AI 识别联系人</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900">
            ✕
          </button>
        </header>

        {/* 识别对象卡片：让用户清晰知道 AI 正在/已经分析的是哪个会话 */}
        <div className="border-b border-zinc-100 bg-zinc-50/50 px-5 py-3">
          <div className="text-[11px] uppercase tracking-wide text-zinc-400">识别对象</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-900">
              {conversationName || '(未命名会话)'}
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${kindColor}`}
            >
              {kindLabel}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">{convDisplay}</div>
          {meta?.me?.name ? (
            <div className="mt-1.5 text-[11px] text-zinc-400">
              当前登录销售：<span className="text-zinc-600">{meta.me.name}</span>
              （AI 会自动排除你自己的姓名 / 号码）
            </div>
          ) : null}
        </div>

        {loading ? (
          <div className="px-5 py-10 text-center text-sm text-zinc-500">
            <div className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700" />
            <div className="mt-3">AI 正在阅读最近的对话…</div>
          </div>
        ) : err ? (
          <div className="px-5 py-6 text-sm text-rose-600">{err}</div>
        ) : done ? (
          <div className="px-5 py-6 text-sm">
            <p className="mb-3 text-emerald-700">
              {done.created ? '✓ 已加入重点客户' : '✓ 重点客户中已存在，已合并新信息'}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                关闭
              </Button>
              <Link
                href="/contacts"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700"
              >
                去重点客户查看
              </Link>
            </div>
          </div>
        ) : draft ? (
          <>
            <div className="space-y-3 px-5 py-4 text-xs">
              <p className="text-zinc-500">AI 抽取结果（可手动修改后再加入重点客户）：</p>
              <DraftField
                label="姓名"
                value={draft.name ?? ''}
                onChange={(v) => setDraft({ ...draft, name: v })}
                placeholder="客户自报的姓名 / 昵称"
              />
              <div className="grid grid-cols-2 gap-2">
                <DraftField
                  label="公司"
                  value={draft.company ?? ''}
                  onChange={(v) => setDraft({ ...draft, company: v })}
                />
                <DraftField
                  label="职位"
                  value={draft.position ?? ''}
                  onChange={(v) => setDraft({ ...draft, position: v })}
                />
              </div>
              {kind === 'lid' ? (
                <DraftField
                  label="LID"
                  value={draft.lid ?? ''}
                  onChange={(v) => setDraft({ ...draft, lid: v })}
                  mono
                  hint="该会话是 WA 私密 ID，无法直接获取电话号"
                />
              ) : (
                <DraftField
                  label="电话（E.164 数字）"
                  value={draft.phone ?? ''}
                  onChange={(v) => setDraft({ ...draft, phone: v })}
                  mono
                  hint="来自会话 ID，可手动修正"
                />
              )}
              <DraftField
                label="标签（逗号分隔）"
                value={(draft.tags ?? []).join(', ')}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    tags: v
                      .split(/[,，;；]/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                  })
                }
              />
              <label className="block">
                <span className="mb-1 block text-zinc-600">备注（AI 画像）</span>
                <textarea
                  className="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm"
                  rows={3}
                  value={draft.note ?? ''}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              </label>
              {err ? <p className="text-rose-600">{err}</p> : null}
            </div>
            <footer className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
              <Button variant="ghost" onClick={onClose}>
                取消
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? '保存中…' : '加入重点客户'}
              </Button>
            </footer>
          </>
        ) : null}
      </div>
    </div>
  );
}

function DraftField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-zinc-600">{label}</span>
      <input
        className={`w-full rounded-md border border-zinc-300 px-2 py-1 text-sm ${
          mono ? 'font-mono text-[12px]' : ''
        }`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <span className="mt-1 block text-[10px] text-zinc-400">{hint}</span> : null}
    </label>
  );
}

/**
 * 转发选择弹窗：多选若干会话，把当前消息一次性转发出去。
 * - 排除当前会话（避免无意义自转发，可在 prop 中传 excludeId）
 * - 支持按名称搜索
 * - 显示原消息内容预览（截短）
 */
function ForwardModal({
  message,
  conversations,
  excludeId,
  onClose,
  onSubmit
}: {
  message: Message;
  conversations: Conversation[];
  excludeId?: string;
  onClose: () => void;
  onSubmit: (toIds: string[]) => void | Promise<void>;
}) {
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const filtered = conversations.filter((c) => {
    if (excludeId && c.id === excludeId) return false;
    if (!keyword) return true;
    const k = keyword.toLowerCase();
    return (c.name ?? '').toLowerCase().includes(k) || c.id.includes(keyword);
  });
  const preview = message.text
    ? message.text.length > 80 ? `${message.text.slice(0, 80)}…` : message.text
    : message.imageUrls?.length
      ? '[图片]'
      : message.videoUrls?.length
        ? '[视频]'
        : '[消息]';
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900">转发消息</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="mb-3 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600 ring-1 ring-zinc-200">
          <span className="text-zinc-400">原消息：</span>
          {preview}
        </div>
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索联系人 / 会话"
          className="mb-3 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
        />
        <div className="max-h-72 overflow-y-auto rounded-md ring-1 ring-zinc-200">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-zinc-400">没有匹配的会话</p>
          ) : (
            filtered.map((c) => {
              const isSel = selected.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggle(c.id)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50 ${
                    isSel ? 'bg-indigo-50' : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-zinc-900">{c.name || c.id}</p>
                    <p className="truncate text-[11px] text-zinc-400">{c.id}</p>
                  </div>
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded border text-[10px] ${
                      isSel
                        ? 'border-indigo-500 bg-indigo-500 text-white'
                        : 'border-zinc-300 bg-white'
                    }`}
                  >
                    {isSel ? '✓' : ''}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => onSubmit(Array.from(selected))}
            className="rounded-md bg-[#5E6AD2] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            转发到 {selected.size} 个会话
          </button>
        </div>
      </div>
    </div>
  );
}