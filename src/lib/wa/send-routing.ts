/**
 * 发送路由表：记录某个「纯数字 id」实际应该用 @c.us 还是 @lid 才能成功送达。
 *
 * 背景：WhatsApp 把 LID 联系人也可能以 `<lid>@c.us` 推入站，被我们归一化成纯数字
 * conversationId。回发时如果再补 @c.us 会报 "No LID for user"；必须用 @lid。
 *
 * 流程：
 * - sendPersonal* 先 resolveSendChatId(to) 拿到最可能成功的 chatId
 * - 实际发送失败后调 markSendFailure(to, triedChatId) → 切换后缀重试
 * - 成功后 markSendSuccess(to, chatId) → 持久化，未来直接命中
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getProfileDataDir } from './profiles';

/**
 * 路径随当前 profile 变化：default 仍是 data/wa-send-routing.json，
 * 其他落在 data/profiles/<id>/下。profile 切换时 profiles.ts 会调 resetSendRoutingCache。
 */
function filePath(): string {
  return path.resolve(getProfileDataDir(), 'wa-send-routing.json');
}
let cache: Record<string, string> | null = null;
let warming: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

export function resetSendRoutingCache(): void {
  cache = null;
  warming = null;
}

async function warm(): Promise<void> {
  if (cache) return;
  if (warming) return warming;
  warming = (async () => {
    try {
      const raw = await fs.readFile(filePath(), 'utf8');
      cache = JSON.parse(raw) as Record<string, string>;
    } catch {
      cache = {};
    }
  })();
  return warming;
}

async function persist(): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const FILE = filePath();
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(cache ?? {}, null, 2), 'utf8');
  });
  return writeQueue;
}

/**
 * 给定外部传入的 `to`（可能是纯数字 / `<id>@c.us` / `<id>@lid` / 群），
 * 返回应当**首选**的 chatId 字符串。
 */
export async function resolveSendChatId(to: string): Promise<string> {
  await warm();
  if (to.includes('@')) return to;
  const digits = to.replace(/\D/g, '');
  if (!digits) return to;
  const override = cache![digits];
  if (override) return override;
  // 没有历史经验：电话号一般是 @c.us，先按 @c.us 试
  return `${digits}@c.us`;
}

/** 当前 chatId 发送失败后，给出另一个候选；用完即止，不再换 */
export function altChatId(triedChatId: string): string | null {
  if (triedChatId.endsWith('@c.us')) {
    return `${triedChatId.slice(0, -'@c.us'.length)}@lid`;
  }
  if (triedChatId.endsWith('@lid')) {
    return `${triedChatId.slice(0, -'@lid'.length)}@c.us`;
  }
  return null;
}

/** 成功送达后记下「这个数字 id 用什么后缀」，下次直接命中 */
export async function markSendSuccess(to: string, chatId: string): Promise<void> {
  await warm();
  if (to.includes('@')) return; // 调用方已显式指定后缀，无需记忆
  const digits = to.replace(/\D/g, '');
  if (!digits) return;
  if (cache![digits] === chatId) return;
  cache![digits] = chatId;
  await persist();
}
