/**
 * AI Autopilot 核心模块
 * ====================================================================
 * 一切让 AI "替员工自动说话 / 自动发送" 的能力，都要过这个文件。
 * 它做三件事：
 *   1. 维护「自动化档位」类型与判定（OFF / SUGGEST / DRAFT_AUTO / AUTO_SAFE / AUTO_FULL）
 *   2. 维护「全局 Kill Switch」与「按会话暂停」状态（落盘 data/ai-autopilot.json）
 *   3. 提供 autopilotGate(): 在 send 入口前做风险/频控/护栏判定
 *
 * 设计原则：
 *   - 任何 AI 触发的发送，最终都要经过 autopilotGate；人工发送也建议过，但只检查 killSwitch
 *   - 任何拦截 / 降级都要落 action log，方便事后复盘
 *   - 这个模块 server-only，不允许浏览器直接 import
 */
import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveAlias, warmAliases } from '@/lib/wa/alias-map';

/* ============================ 类型 ============================ */

/** AI 自动化档位（per-conversation 或全局默认） */
export type AutoMode =
  | 'OFF' // 完全禁用 AI
  | 'SUGGEST' // 只生成建议，不自动填入、不自动发
  | 'DRAFT_AUTO' // AI 起草并自动填到输入框（员工按发送）
  | 'AUTO_SAFE' // 仅允许安全场景自动发（破冰/闲聊/跟进/唤醒）
  | 'AUTO_FULL'; // 全自动；命中风险词自动降级到 SUGGEST

export const AUTO_MODES: AutoMode[] = ['OFF', 'SUGGEST', 'DRAFT_AUTO', 'AUTO_SAFE', 'AUTO_FULL'];

export const AUTO_MODE_LABEL: Record<AutoMode, string> = {
  OFF: '关闭',
  SUGGEST: '仅建议',
  DRAFT_AUTO: '半自动起草',
  AUTO_SAFE: '安全自动',
  AUTO_FULL: '全自动'
};

/** AI 触发来源 - 用于审计、风控、UI 标识 */
export type AiSource =
  | 'human' // 员工手动输入并发送
  | 'suggest-click' // 点了 AI 建议条的 ⚡ 直发
  | 'auto-safe' // 在 AUTO_SAFE 档位由策略自动触发
  | 'auto-full'; // 在 AUTO_FULL 档位由策略自动触发

/** Gate 判定结果 */
export type GateDecision =
  | { allow: true; downgrade?: never; reason?: string }
  | { allow: false; downgrade: 'BLOCKED' | 'NEEDS_HUMAN'; reason: string };

/* ============================ 风险词 ============================ */

/**
 * 风险词：命中则 AUTO_FULL 自动降级到「需要人工确认」，员工手动发不受影响。
 * 这是兜底，不是唯一防线：销售剧本和 prompt 那一层也要规避。
 * 注意：尽量保守，宁错拦不错放。
 */
const RISK_PATTERNS: { pattern: RegExp; label: string }[] = [
  // 价格 / 折扣 / 议价相关
  { pattern: /(便宜|cheap(er)?|discount|折扣|降价|包邮|包税|刀|美金|人民币|usd|cny|\$\d|￥\d)/i, label: '价格议价' },
  // 库存 / 交期承诺
  { pattern: /(现货|in\s*stock|交期|发货时间|多久能到|when.*ship|delivery\s*time|多久到货)/i, label: '库存/交期' },
  // 售后 / 投诉 / 退款
  { pattern: /(退款|refund|赔偿|投诉|complain|claim|破损|破了|烂了|不退不换|质量问题|假货|fake|counterfeit)/i, label: '售后/投诉' },
  // 客户怀疑是否真人 / AI
  { pattern: /(真人|是不是\s*ai|是不是机器|机器人|chatbot|are you (a )?(bot|robot|ai|human|real)|are you real)/i, label: '身份试探' },
  // 个人隐私
  { pattern: /(几岁|多大年纪|结婚|男朋友|女朋友|住哪|家在哪|月薪|工资|宗教|信仰|政治|党|总统|主席)/i, label: '隐私/敏感' },
  // 转移到其他平台 / 灰产
  { pattern: /(微信|wechat|telegram|line\s|signal|加我|私聊|私下|off[\s-]?platform|paypal|crypto|btc|eth|usdt)/i, label: '转移平台' }
];

export function detectRisks(text: string): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (const r of RISK_PATTERNS) if (r.pattern.test(text)) hits.add(r.label);
  return [...hits];
}

/* ============================ 落盘存储 ============================ */

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'ai-autopilot.json');
const ACTIONS_FILE = path.join(DATA_DIR, 'ai-actions.json');

/** 全局状态：kill switch + 每会话暂停时间 */
type AutopilotState = {
  /** 全局急停：true = 一切 AI 自动发送（auto-safe / auto-full）都禁掉；suggest-click 也会被阻止 */
  killSwitch: boolean;
  killSwitchAt?: number;
  /** 全局默认档位（新会话采用此值） */
  defaultMode: AutoMode;
  /** 按会话暂停：conversationId -> 暂停截止时间戳（ms） */
  pausedUntil: Record<string, number>;
};

const DEFAULT_STATE: AutopilotState = {
  killSwitch: false,
  defaultMode: 'SUGGEST',
  pausedUntil: {}
};

let writeQueue: Promise<void> = Promise.resolve();

async function readState(): Promise<AutopilotState> {
  await warmAliases();
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AutopilotState>;
    return {
      killSwitch: !!parsed.killSwitch,
      killSwitchAt: parsed.killSwitchAt,
      defaultMode: (parsed.defaultMode as AutoMode) ?? 'SUGGEST',
      pausedUntil: canonicalizePausedUntil(parsed.pausedUntil ?? {})
    };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ...DEFAULT_STATE };
    throw e;
  }
}

function canonicalizePausedUntil(pausedUntil: Record<string, number>): Record<string, number> {
  const now = Date.now();
  const next: Record<string, number> = {};
  for (const [id, until] of Object.entries(pausedUntil)) {
    if (!until || until <= now) continue;
    const canonical = resolveAlias(id);
    next[canonical] = Math.max(next[canonical] ?? 0, until);
  }
  return next;
}

async function writeState(next: AutopilotState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
}

function enqueueState<T>(mutator: (s: AutopilotState) => T | Promise<T>): Promise<T> {
  let result: T;
  const next = writeQueue.then(async () => {
    const s = await readState();
    result = await mutator(s);
    await writeState(s);
  });
  writeQueue = next.catch(() => undefined);
  return next.then(() => result);
}

/* ============================ Kill Switch / Pause API ============================ */

export async function getAutopilotState(): Promise<AutopilotState> {
  return readState();
}

export async function setKillSwitch(on: boolean): Promise<AutopilotState> {
  return enqueueState((s) => {
    s.killSwitch = on;
    s.killSwitchAt = on ? Date.now() : undefined;
    return s;
  });
}

export async function setDefaultAutoMode(mode: AutoMode): Promise<AutopilotState> {
  return enqueueState((s) => {
    s.defaultMode = mode;
    return s;
  });
}

/** 暂停某会话的自动发送 ms 毫秒。0 = 清除暂停。 */
export async function pauseConversationAutopilot(
  conversationId: string,
  ms: number
): Promise<AutopilotState> {
  return enqueueState((s) => {
    const canonical = resolveAlias(conversationId);
    if (ms <= 0) delete s.pausedUntil[canonical];
    else s.pausedUntil[canonical] = Date.now() + ms;
    return s;
  });
}

export function isConversationPaused(state: AutopilotState, conversationId: string): boolean {
  const until = state.pausedUntil[resolveAlias(conversationId)];
  return !!until && until > Date.now();
}

/* ============================ Action Log ============================ */

export type AiActionEvent = {
  id: string;
  timestamp: number;
  conversationId: string;
  source: AiSource;
  mode: AutoMode;
  /** 'sent' = 实发；'blocked' = kill switch / 暂停拦截；'downgraded' = 命中风险词转人工；'drafted' = DRAFT_AUTO 起草到输入框 */
  outcome: 'sent' | 'blocked' | 'downgraded' | 'drafted';
  reason?: string;
  risks?: string[];
  messageId?: string;
  textPreview?: string;
};

const MAX_ACTIONS = 2000;

export async function logAiAction(ev: Omit<AiActionEvent, 'id' | 'timestamp'>): Promise<void> {
  const full: AiActionEvent = {
    ...ev,
    id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    textPreview: ev.textPreview ? ev.textPreview.slice(0, 200) : undefined
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  let list: AiActionEvent[] = [];
  try {
    const raw = await fs.readFile(ACTIONS_FILE, 'utf8');
    list = JSON.parse(raw) as AiActionEvent[];
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
  }
  list.push(full);
  // 仅保留最近 N 条，防止无限增长
  if (list.length > MAX_ACTIONS) list = list.slice(-MAX_ACTIONS);
  await fs.writeFile(ACTIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

export async function listAiActions(limit = 200): Promise<AiActionEvent[]> {
  try {
    const raw = await fs.readFile(ACTIONS_FILE, 'utf8');
    const all = JSON.parse(raw) as AiActionEvent[];
    return all.slice(-limit).reverse();
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
}

/* ============================ Gate ============================ */

export type GateInput = {
  conversationId: string;
  source: AiSource;
  /** 该会话当前档位；未设传 undefined 走全局默认 */
  conversationMode?: AutoMode;
  /** 即将发送的文本（用于风险词检测） */
  text?: string;
};

/**
 * 在 performSend 之前调用。
 * 返回值：
 *   - { allow: true } 放行
 *   - { allow: false, downgrade: 'BLOCKED', reason } 全局急停或会话暂停
 *   - { allow: false, downgrade: 'NEEDS_HUMAN', reason } 命中风险词，需要降级转人工
 *
 * 注意：human 来源始终允许（员工自己负责），仅检查 killSwitch 是否禁止人工兜底 → 不禁止。
 */
export async function autopilotGate(input: GateInput): Promise<GateDecision> {
  const state = await readState();
  const mode = input.conversationMode ?? state.defaultMode;

  // 人工发送：唯一不挡的来源
  if (input.source === 'human') {
    return { allow: true };
  }

  // 全局急停：所有 AI 来源都拒
  if (state.killSwitch) {
    return {
      allow: false,
      downgrade: 'BLOCKED',
      reason: '全局急停已开启，所有 AI 自动发送被拦截'
    };
  }

  // 会话级暂停
  if (isConversationPaused(state, input.conversationId)) {
    const minutesLeft = Math.ceil(
      (state.pausedUntil[resolveAlias(input.conversationId)]! - Date.now()) / 60000
    );
    return {
      allow: false,
      downgrade: 'BLOCKED',
      reason: `该会话已暂停 AI 自动发送（还剩约 ${minutesLeft} 分钟）`
    };
  }

  // 档位约束
  if (mode === 'OFF') {
    return { allow: false, downgrade: 'BLOCKED', reason: '该会话档位为「关闭」' };
  }
  if (mode === 'SUGGEST' || mode === 'DRAFT_AUTO') {
    // 这两档不允许 auto-* 自动触发；suggest-click 是员工点了 ⚡，按"半人工"放行
    if (input.source === 'auto-safe' || input.source === 'auto-full') {
      return {
        allow: false,
        downgrade: 'BLOCKED',
        reason: `当前档位「${AUTO_MODE_LABEL[mode]}」不允许 AI 自动发送`
      };
    }
  }

  // 风险词：AUTO_FULL 命中也强制转人工；AUTO_SAFE 任何风险都转人工
  const risks = detectRisks(input.text ?? '');
  if (risks.length > 0) {
    if (mode === 'AUTO_SAFE' || mode === 'AUTO_FULL') {
      return {
        allow: false,
        downgrade: 'NEEDS_HUMAN',
        reason: `命中风险话题（${risks.join(' / ')}），已转人工确认`
      };
    }
  }

  return { allow: true };
}
