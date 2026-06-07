import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * WhatsApp 个人号「账号 profile」注册表。
 *
 * 设计目标：
 * - 默认 profile id = 'default'。为了零迁移，'default' 的 WA 数据**就地**用
 *   `data/wa-messages.json`、`data/wa-aliases.json`、`data/wa-send-routing.json`，
 *   `.wwebjs_auth/session-default/` 也是 whatsapp-web.js 原生命名，向前兼容。
 * - 非 default profile 的所有 WA 数据收进 `data/profiles/<id>/...` 子目录；
 *   wwebjs 浏览器 session 收进 `data/.wwebjs_auth/session-<id>/`（仍是 LocalAuth 默认布局）。
 * - 「联系人 / 商品 / AI 配置」等非聊天数据保持单文件共享，不随 profile 切换 —— 那些是 CRM 维度数据。
 *
 * 注意：本模块只管「当前激活的是哪个 profile + 这些路径在哪里」。
 * 真正在 profile 间切换由 personal-client 协调（必须先 logout 才能切，避免消息错落）。
 */

const REGISTRY_FILE = path.join(process.cwd(), 'data', 'wa-profiles.json');
const DEFAULT_PROFILE_ID = 'default';

export type ProfileInfo = {
  id: string;
  label: string;
  /** 上次激活的时间戳（毫秒）。仅用于 UI 排序。 */
  lastActivatedAt?: number;
  createdAt: number;
};

type Registry = {
  active: string;
  profiles: ProfileInfo[];
};

let cache: Registry | null = null;
let writeQueue: Promise<void> = Promise.resolve();

/** profile id 必须由 [a-z0-9_-] 组成且 1–32 字符，避免被当作路径片段时越界。 */
const ID_RE = /^[a-z0-9_-]{1,32}$/;

export function isValidProfileId(id: string): boolean {
  return ID_RE.test(id);
}

async function load(): Promise<Registry> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Registry>;
    const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    let active = typeof parsed.active === 'string' ? parsed.active : DEFAULT_PROFILE_ID;
    // 兜底：确保 default 一定存在；active 指向不存在的 profile 时回退到 default
    if (!profiles.find((p) => p.id === DEFAULT_PROFILE_ID)) {
      profiles.unshift({ id: DEFAULT_PROFILE_ID, label: '默认账号', createdAt: Date.now() });
    }
    if (!profiles.find((p) => p.id === active)) active = DEFAULT_PROFILE_ID;
    cache = { active, profiles };
  } catch {
    cache = {
      active: DEFAULT_PROFILE_ID,
      profiles: [{ id: DEFAULT_PROFILE_ID, label: '默认账号', createdAt: Date.now() }]
    };
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const snapshot = JSON.stringify(cache, null, 2);
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(REGISTRY_FILE), { recursive: true });
    await fs.writeFile(REGISTRY_FILE, snapshot, 'utf8');
  });
  return writeQueue;
}

/** 注册表全部 profile + 当前激活 id。 */
export async function listProfiles(): Promise<{ active: string; profiles: ProfileInfo[] }> {
  const r = await load();
  return { active: r.active, profiles: [...r.profiles] };
}

/**
 * 同步取当前激活的 profile id。
 *
 * - 第一次调用前必须有 `load()` 跑过（异步），否则返回 'default'。
 * - 路径解析全部走这个：写盘前一般都会先有一次 store API 调用，
 *   而 store 入口都是 async 的，所以实际使用时不会撞到「未热」窗口。
 */
export function getActiveProfileIdSync(): string {
  return cache?.active ?? DEFAULT_PROFILE_ID;
}

/** 异步版本：保证 registry 已加载。 */
export async function getActiveProfileId(): Promise<string> {
  const r = await load();
  return r.active;
}

/**
 * profile 对应的「WA 聊天数据目录」。default 落到 data/，其余落到 data/profiles/<id>/。
 * 调用方写盘前要 mkdir -p。
 */
export function getProfileDataDir(profileId?: string): string {
  const id = profileId ?? getActiveProfileIdSync();
  if (id === DEFAULT_PROFILE_ID) return path.join(process.cwd(), 'data');
  return path.join(process.cwd(), 'data', 'profiles', id);
}

/** profile 对应的 wwebjs LocalAuth 子目录路径（用于「清除磁盘 session」）。 */
export function getProfileSessionDir(profileId?: string): string {
  const id = profileId ?? getActiveProfileIdSync();
  return path.join(process.cwd(), 'data', '.wwebjs_auth', `session-${id}`);
}

/** 传给 `new LocalAuth({ clientId })` 的值。 */
export function getProfileClientId(profileId?: string): string {
  return profileId ?? getActiveProfileIdSync();
}

export async function addProfile(input: { id: string; label?: string }): Promise<ProfileInfo> {
  if (!isValidProfileId(input.id)) {
    throw new Error('id 只能是 1-32 位小写字母 / 数字 / 下划线 / 连字符');
  }
  const r = await load();
  if (r.profiles.find((p) => p.id === input.id)) {
    throw new Error(`profile "${input.id}" 已存在`);
  }
  const info: ProfileInfo = {
    id: input.id,
    label: (input.label ?? input.id).trim() || input.id,
    createdAt: Date.now()
  };
  r.profiles.push(info);
  await persist();
  return info;
}

/**
 * 把激活的 profile 切到 nextId。**调用方**有责任在调用前已 logoutPersonalClient
 * 并停掉所有正在写当前 profile 文件的后台任务，否则会消息错落到新 profile。
 *
 * 切换后会清空 alias / send-routing 模块级缓存，让它们下次按新 profile 重新加载。
 */
export async function setActiveProfileId(nextId: string): Promise<void> {
  const r = await load();
  if (!r.profiles.find((p) => p.id === nextId)) {
    throw new Error(`profile "${nextId}" 不存在`);
  }
  if (r.active === nextId) return;
  const info = r.profiles.find((p) => p.id === nextId)!;
  info.lastActivatedAt = Date.now();
  r.active = nextId;
  await persist();
  // 让其他 store 模块在下次访问时重新热缓存
  const { resetAliasCache } = await import('./alias-map');
  const { resetSendRoutingCache } = await import('./send-routing');
  resetAliasCache();
  resetSendRoutingCache();
}

/** 把 profile 的「本地聊天数据」连根删除（不动手机端 / WA 服务器）。 */
export async function wipeProfileData(profileId: string): Promise<void> {
  if (profileId === DEFAULT_PROFILE_ID) {
    // default 的数据是「就地」的，逐个文件删，避免误伤 data/ 下其它共享文件
    const dir = getProfileDataDir(profileId);
    for (const f of ['wa-messages.json', 'wa-aliases.json', 'wa-send-routing.json']) {
      await fs.rm(path.join(dir, f), { force: true }).catch(() => undefined);
    }
  } else {
    await fs.rm(getProfileDataDir(profileId), { recursive: true, force: true }).catch(() => undefined);
  }
  // 清模块级缓存，避免下次读还拿到旧的
  const { resetAliasCache } = await import('./alias-map');
  const { resetSendRoutingCache } = await import('./send-routing');
  resetAliasCache();
  resetSendRoutingCache();
}

/** 把 profile 的 wwebjs 浏览器 session 删掉（下次启动必须重新扫码）。 */
export async function wipeProfileSession(profileId: string): Promise<void> {
  const dir = getProfileSessionDir(profileId);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** 删除一个 profile（不能删 default；不能删当前激活的）。同时清盘上数据与 session。 */
export async function removeProfile(profileId: string): Promise<void> {
  if (profileId === DEFAULT_PROFILE_ID) throw new Error('默认账号不可删除');
  const r = await load();
  if (r.active === profileId) throw new Error('请先切换到其他账号再删除');
  const idx = r.profiles.findIndex((p) => p.id === profileId);
  if (idx < 0) return;
  r.profiles.splice(idx, 1);
  await persist();
  await wipeProfileData(profileId);
  await wipeProfileSession(profileId);
}
