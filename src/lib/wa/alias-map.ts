import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 会话别名表：永久映射 `aliasId -> canonicalId`。
 * 用户在 Inbox 里把会话 A「合并到」B 后，把 A.id -> B.id 写进这里；
 * 此后任何落到 A.id 的消息（包括对方下次再发来的消息）都会自动改写为 B.id，
 * 真正实现「一次合并，长期一个窗口」。
 *
 * 注意：本表只解决「我们已经知道是同一个人」的稳态映射，不做自动猜测。
 * WhatsApp 同时维护 @c.us / @lid 两套 id，应用层无法自动 100% 关联，
 * 所以「第一次出现」仍然按原 id 入库；用户合并一次后就稳定了。
 */

type AliasMap = Record<string, string>;

import { getProfileDataDir } from './profiles';
/**
 * 路径随当前 profile 变化：default 仍是 data/wa-aliases.json，其他落在 data/profiles/<id>/下。
 * profile 切换后 profiles.ts 会主动调 resetAliasCache() 清下面这个模块缓存。
 */
function filePath(): string {
  return path.join(getProfileDataDir(), 'wa-aliases.json');
}

let cache: AliasMap | null = null;
let writeQueue: Promise<void> = Promise.resolve();

/** profile 切换时调；其他场景别用。 */
export function resetAliasCache(): void {
  cache = null;
}

async function load(): Promise<AliasMap> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(filePath(), 'utf8');
    cache = JSON.parse(raw) as AliasMap;
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(map: AliasMap): Promise<void> {
  const dir = getProfileDataDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath(), JSON.stringify(map, null, 2), 'utf8');
}

/** 解析任意 id 到最终 canonical id（按链路最多 10 跳，防环）。同步版本：要求先调 warm()。 */
export function resolveAlias(id: string): string {
  if (!cache) return id; // 未加载时直接原样返回（仅在 store 启动时短暂）
  let cur = id;
  for (let i = 0; i < 10; i++) {
    const next = cache[cur];
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** 异步加载缓存（首次调用 store 读写前可主动 warm 一下） */
export async function warmAliases(): Promise<void> {
  await load();
}

/**
 * 添加一条别名 from -> to（永久）。
 * - 若 to 本身已有别名链，会自动跳到链尾，避免间接环
 * - 若 from === to 直接忽略
 * - 若已有 from 映射到别处，覆盖（用户最新的合并意图为准）
 */
export async function addAlias(from: string, to: string): Promise<void> {
  if (!from || !to || from === to) return;
  await load();
  const next = writeQueue.then(async () => {
    const map = cache ?? {};
    // 跳到 to 的链尾；若链路回到 from，说明用户在做“反向合并”
    // （例如历史已有 lid->phone，现在想要 phone->lid）。
    // 这时以 to 为准并断开 to 的旧映射，避免被判成自环 no-op。
    let target = to;
    const seen = new Set<string>();
    let cycleToFrom = false;
    while (map[target] && !seen.has(target)) {
      seen.add(target);
      target = map[target]!;
      if (target === from) {
        cycleToFrom = true;
        break;
      }
    }
    if (cycleToFrom) {
      delete map[to];
      target = to;
    }
    if (target === from) return; // 防自环
    map[from] = target;
    // 顺便把所有「映射到 from」的旧条目也指向新 target（拍平）
    for (const [k, v] of Object.entries(map)) {
      if (k !== target && v === from) map[k] = target;
    }
    cache = map;
    await persist(map);
  });
  writeQueue = next.then(
    () => undefined,
    () => undefined
  );
  await next;
}
