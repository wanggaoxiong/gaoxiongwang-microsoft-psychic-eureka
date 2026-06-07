import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 重点客户跟进（CRM）存储。
 * - JSON 文件落盘，与 wa-messages/wa-aliases 风格保持一致
 * - 原子写：先写 .tmp 再 rename；读到损坏文件时备份不覆盖
 * - 一条 Contact 可只有 phone、只有 lid，或两者都有
 * - 主键 id 是自增的内部 cuid 风格字符串，不依赖 WhatsApp id
 */

export type ContactOrderStatus =
  | 'placed'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded';

export type ContactOrder = {
  /** 内部 id，仅用于增删改 */
  id: string;
  /** 客户/平台订单号，自由文本 */
  orderNo?: string;
  /** 发货跟踪号 */
  trackingNo?: string;
  /** 物流商，例如 DHL / 顺丰 */
  carrier?: string;
  /** 商品/SKU 简述（自由文本，例如「白色运动鞋 42 码 × 2」） */
  items?: string;
  /** 金额（自由文本，例如「1280」「199.50」） */
  amount?: string;
  /** 货币代码，例如 CNY / USD / EUR / JPY 等；UI 用来配符号展示 */
  currency?: string;
  status: ContactOrderStatus;
  /** 备注，例如「客户要求加急」 */
  note?: string;
  /** 下单时间（毫秒），可选 */
  placedAt?: number;
  /** 发货时间 */
  shippedAt?: number;
  /** 送达时间 */
  deliveredAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type Contact = {
  id: string;
  /** E.164 不带 + 的纯数字。可为空（仅 LID 的联系人）。 */
  phone?: string;
  /** WhatsApp LID 形式（含 @lid）。可为空。 */
  lid?: string;
  name?: string;
  company?: string;
  position?: string;
  note?: string;
  tags: string[];
  /** 最近一次 isRegisteredUser 校验结果；undefined = 从未校验 */
  waVerified?: boolean;
  waVerifiedAt?: number;
  /** 自由 CRM 字段 */
  totalOrders?: number;
  /** 来源：manual / inbox / import / ai */
  source?: 'manual' | 'inbox' | 'import' | 'ai';
  /**
   * AI 生成的长期画像。仅在用户手动「总结客户」后写入。
   * 不在每条消息的热路径上调 AI，避免费用失控。
   */
  aiProfile?: {
    summary?: string;
    /** 客户本人姓名（仅当客户自己报过 / WhatsApp 显示名可信时填，绝不能是销售名） */
    customerName?: string;
    /** 推断的客户主语言 */
    language?: string;
    /** 偷好关键词，例如 ['白色运动鞋', '42 码'] */
    preferences?: string[];
    /** 价位，例如 '中高端' / '高端' / '价格敏感' */
    priceBand?: string;
    /** 兴趣品类，例如 ['箱包', '鞋靠'] */
    interests?: string[];
    /** 补充说明 */
    notes?: string;
    lastSummaryAt?: number;
    /** 记录上次用了多少条聊天记录生成画像 */
    basedOnTurns?: number;
  };
  /** 历史订单（手工录入；订单号、物流单号、状态等） */
  orders?: ContactOrder[];
  createdAt: number;
  updatedAt: number;
};

type Store = {
  contacts: Contact[];
};

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'contacts.json');

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  let raw: string;
  try {
    raw = await fs.readFile(FILE, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { contacts: [] };
    }
    throw e;
  }
  try {
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || !Array.isArray(parsed.contacts)) return { contacts: [] };
    return parsed;
  } catch (e) {
    const bak = `${FILE}.corrupt-${Date.now()}.bak`;
    try {
      await fs.writeFile(bak, raw, 'utf8');
    } catch {
      /* ignore */
    }
    throw new Error(
      `contacts.json parse failed, backed up to ${bak}. Refusing to overwrite. Original: ${(e as Error).message}`
    );
  }
}

async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tmp, FILE);
}

function enqueue<T>(fn: (store: Store) => Promise<T> | T): Promise<T> {
  const next = writeQueue.then(async () => {
    const store = await readStore();
    const result = await fn(store);
    await writeStore(store);
    return result;
  });
  writeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function newId(): string {
  return `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 把任意输入收敛成纯数字的 phone（E.164 无 +）。返回 undefined 表示无效。 */
export function normalizePhone(input?: string): string | undefined {
  if (!input) return undefined;
  const digits = String(input).replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 16) return undefined;
  return digits;
}

/** LID 形式：保留原值，去掉 @c.us 后缀等噪声。 */
export function normalizeLid(input?: string): string | undefined {
  if (!input) return undefined;
  const s = String(input).trim();
  if (!s) return undefined;
  if (s.endsWith('@lid')) return s;
  // 纯 LID 数字可能也允许，但调用方多半已经带后缀
  if (/^\d+@lid$/.test(s)) return s;
  return undefined;
}

export async function listContacts(opts?: {
  q?: string;
  tag?: string;
  verified?: 'yes' | 'no' | 'unknown';
}): Promise<Contact[]> {
  const store = await readStore();
  let list = [...store.contacts];
  const q = opts?.q?.trim().toLowerCase();
  if (q) {
    list = list.filter((c) => {
      return (
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.phone && c.phone.includes(q)) ||
        (c.lid && c.lid.toLowerCase().includes(q)) ||
        (c.company && c.company.toLowerCase().includes(q)) ||
        (c.note && c.note.toLowerCase().includes(q)) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }
  if (opts?.tag) {
    const tag = opts.tag;
    list = list.filter((c) => c.tags.includes(tag));
  }
  if (opts?.verified === 'yes') list = list.filter((c) => c.waVerified === true);
  if (opts?.verified === 'no') list = list.filter((c) => c.waVerified === false);
  if (opts?.verified === 'unknown') list = list.filter((c) => c.waVerified === undefined);
  return list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function getContact(id: string): Promise<Contact | null> {
  const store = await readStore();
  return store.contacts.find((c) => c.id === id) ?? null;
}

/** 按 phone 或 lid 查重；二者均提供时任一命中即视为同一条。 */
export async function findContactByPhoneOrLid(
  phone?: string,
  lid?: string
): Promise<Contact | null> {
  if (!phone && !lid) return null;
  const store = await readStore();
  return (
    store.contacts.find((c) => {
      if (phone && c.phone === phone) return true;
      if (lid && c.lid === lid) return true;
      return false;
    }) ?? null
  );
}

export type ContactInput = {
  phone?: string;
  lid?: string;
  name?: string;
  company?: string;
  position?: string;
  note?: string;
  tags?: string[];
  source?: Contact['source'];
};

/** 创建或合并：如果 phone/lid 已存在，合并（不空覆盖），否则插入新。 */
export async function upsertContact(
  input: ContactInput
): Promise<{ contact: Contact; created: boolean }> {
  const phone = normalizePhone(input.phone);
  const lid = normalizeLid(input.lid);
  if (!phone && !lid) {
    throw new Error('phone 或 lid 至少需要一个');
  }
  return enqueue((store) => {
    const existing = store.contacts.find((c) => {
      if (phone && c.phone === phone) return true;
      if (lid && c.lid === lid) return true;
      return false;
    });
    const now = Date.now();
    if (existing) {
      if (phone && !existing.phone) existing.phone = phone;
      if (lid && !existing.lid) existing.lid = lid;
      if (input.name && !existing.name) existing.name = input.name;
      if (input.company && !existing.company) existing.company = input.company;
      if (input.position && !existing.position) existing.position = input.position;
      if (input.note && !existing.note) existing.note = input.note;
      if (input.tags?.length) {
        const set = new Set([...existing.tags, ...input.tags.map((t) => t.trim()).filter(Boolean)]);
        existing.tags = [...set];
      }
      existing.updatedAt = now;
      return { contact: existing, created: false };
    }
    const contact: Contact = {
      id: newId(),
      phone,
      lid,
      name: input.name?.trim() || undefined,
      company: input.company?.trim() || undefined,
      position: input.position?.trim() || undefined,
      note: input.note?.trim() || undefined,
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      source: input.source ?? 'manual',
      createdAt: now,
      updatedAt: now
    };
    store.contacts.push(contact);
    return { contact, created: true };
  });
}

export type ContactPatch = Partial<{
  phone: string | null;
  lid: string | null;
  name: string | null;
  company: string | null;
  position: string | null;
  note: string | null;
  tags: string[];
  totalOrders: number;
  /** null = 清除画像；部分对象 = 浅合并 */
  aiProfile: Contact['aiProfile'] | null;
}>;

export async function updateContact(id: string, patch: ContactPatch): Promise<Contact | null> {
  return enqueue((store) => {
    const c = store.contacts.find((x) => x.id === id);
    if (!c) return null;
    if (patch.phone !== undefined) {
      c.phone = patch.phone === null ? undefined : normalizePhone(patch.phone);
    }
    if (patch.lid !== undefined) {
      c.lid = patch.lid === null ? undefined : normalizeLid(patch.lid);
    }
    if (patch.name !== undefined) c.name = patch.name?.toString().trim() || undefined;
    if (patch.company !== undefined) c.company = patch.company?.toString().trim() || undefined;
    if (patch.position !== undefined) c.position = patch.position?.toString().trim() || undefined;
    if (patch.note !== undefined) c.note = patch.note?.toString().trim() || undefined;
    if (patch.tags !== undefined) {
      c.tags = patch.tags.map((t) => t.trim()).filter(Boolean);
    }
    if (patch.totalOrders !== undefined) c.totalOrders = Number(patch.totalOrders) || 0;
    if (patch.aiProfile !== undefined) {
      if (patch.aiProfile === null) {
        delete c.aiProfile;
      } else {
        c.aiProfile = { ...(c.aiProfile ?? {}), ...patch.aiProfile };
      }
    }
    c.updatedAt = Date.now();
    return c;
  });
}

export async function deleteContact(id: string): Promise<boolean> {
  return enqueue((store) => {
    const i = store.contacts.findIndex((x) => x.id === id);
    if (i < 0) return false;
    store.contacts.splice(i, 1);
    return true;
  });
}

export async function setVerified(id: string, registered: boolean): Promise<Contact | null> {
  return enqueue((store) => {
    const c = store.contacts.find((x) => x.id === id);
    if (!c) return null;
    c.waVerified = registered;
    c.waVerifiedAt = Date.now();
    c.updatedAt = c.waVerifiedAt;
    return c;
  });
}

/** 批量导入：返回 created/merged/skipped 统计 */
export async function importContacts(
  rows: ContactInput[]
): Promise<{ created: number; merged: number; skipped: number; total: number }> {
  let created = 0;
  let merged = 0;
  let skipped = 0;
  for (const row of rows) {
    const phone = normalizePhone(row.phone);
    const lid = normalizeLid(row.lid);
    if (!phone && !lid) {
      skipped++;
      continue;
    }
    const r = await upsertContact({ ...row, phone, lid, source: row.source ?? 'import' });
    if (r.created) created++;
    else merged++;
  }
  return { created, merged, skipped, total: rows.length };
}

/** 列出所有出现过的标签（去重，按出现频次倒序） */
export async function listTags(): Promise<Array<{ name: string; count: number }>> {
  const store = await readStore();
  const map = new Map<string, number>();
  for (const c of store.contacts) {
    for (const t of c.tags) map.set(t, (map.get(t) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/* ===================== 订单跟踪 ===================== */

export type ContactOrderInput = Partial<Omit<ContactOrder, 'id' | 'createdAt' | 'updatedAt'>>;

function newOrderId(): string {
  return `od_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeOrderPatch(input: ContactOrderInput): Partial<ContactOrder> {
  const out: Partial<ContactOrder> = {};
  if (input.orderNo !== undefined) out.orderNo = String(input.orderNo).trim() || undefined;
  if (input.trackingNo !== undefined) out.trackingNo = String(input.trackingNo).trim() || undefined;
  if (input.carrier !== undefined) out.carrier = String(input.carrier).trim() || undefined;
  if (input.items !== undefined) out.items = String(input.items).trim() || undefined;
  if (input.amount !== undefined) out.amount = String(input.amount).trim() || undefined;
  if (input.currency !== undefined) out.currency = String(input.currency).trim().toUpperCase() || undefined;
  if (input.note !== undefined) out.note = String(input.note).trim() || undefined;
  if (input.status !== undefined) out.status = input.status;
  if (input.placedAt !== undefined) out.placedAt = input.placedAt ?? undefined;
  if (input.shippedAt !== undefined) out.shippedAt = input.shippedAt ?? undefined;
  if (input.deliveredAt !== undefined) out.deliveredAt = input.deliveredAt ?? undefined;
  return out;
}

export async function addContactOrder(
  contactId: string,
  input: ContactOrderInput
): Promise<Contact | null> {
  return enqueue((store) => {
    const c = store.contacts.find((x) => x.id === contactId);
    if (!c) return null;
    const now = Date.now();
    const order: ContactOrder = {
      id: newOrderId(),
      status: input.status ?? 'placed',
      ...normalizeOrderPatch(input),
      createdAt: now,
      updatedAt: now
    };
    if (!order.placedAt) order.placedAt = now;
    c.orders = [order, ...(c.orders ?? [])];
    c.totalOrders = (c.totalOrders ?? 0) + 1;
    c.updatedAt = now;
    return c;
  });
}

export async function updateContactOrder(
  contactId: string,
  orderId: string,
  patch: ContactOrderInput
): Promise<Contact | null> {
  return enqueue((store) => {
    const c = store.contacts.find((x) => x.id === contactId);
    if (!c?.orders) return null;
    const o = c.orders.find((x) => x.id === orderId);
    if (!o) return null;
    Object.assign(o, normalizeOrderPatch(patch));
    o.updatedAt = Date.now();
    c.updatedAt = o.updatedAt;
    return c;
  });
}

export async function deleteContactOrder(
  contactId: string,
  orderId: string
): Promise<Contact | null> {
  return enqueue((store) => {
    const c = store.contacts.find((x) => x.id === contactId);
    if (!c?.orders) return null;
    const i = c.orders.findIndex((x) => x.id === orderId);
    if (i < 0) return null;
    c.orders.splice(i, 1);
    c.totalOrders = Math.max(0, (c.totalOrders ?? 1) - 1);
    c.updatedAt = Date.now();
    return c;
  });
}
