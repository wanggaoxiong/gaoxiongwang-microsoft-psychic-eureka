import { getContact, updateContact, upsertContact, type Contact } from '@/lib/contacts/store';
import { getMessages, listConversations } from '@/lib/wa/store';
import { callAzureResponses, type AzureCfg } from '@/lib/ai/azure';
import { getPersonalStatus } from '@/lib/wa/personal-client';

/**
 * 共享的「联系人长期画像」生成逻辑。
 * 由 /api/contacts/[id]/summarize 和 /api/wa/conversations/[id]/profile 复用。
 */

export type ProfileResult =
  | { ok: true; contact: Contact }
  | { ok: false; status: number; error: string };

function buildPrompt(
  messages: Awaited<ReturnType<typeof getMessages>>,
  sellerName: string,
  sellerId: string,
  displayName?: string
): string {
  const lines = messages.map((m) => {
    const who = m.direction === 'in' ? '客户' : '我(销售)';
    let txt =
      m.text ||
      (m.imageUrls?.length
        ? `[图片${m.productTitle ? `: ${m.productTitle}` : ''}]`
        : m.videoUrls?.length
          ? '[视频]'
          : '[空]');
    if (txt.length > 220) txt = txt.slice(0, 220) + '…';
    return `${who}: ${txt}`;
  });
  const transcript = lines.join('\n');
  const displayNameHint =
    displayName && displayName.trim() && displayName.trim().toLowerCase() !== sellerName.trim().toLowerCase()
      ? `\n- 该客户的 WhatsApp 显示名（备注名/昵称）是「${displayName.trim()}」。这是一个**有力线索**：若它像人名、且与 "客户:" 发言不矛盾，就当作客户姓名采用；只有当它明显是群名/商家名/销售名时才忽略。`
      : '';
  return `你是 B2B 销售助手。下面是与一位客户的最近 ${messages.length} 条 WhatsApp 聊天记录（旧到新）。请提炼出可供下次回复时参考的长期画像。

【角色识别（最重要）】
- transcript 中以 "我(销售):" 开头的发言全部是销售本人发出的，**绝不能**把这些发言里出现的姓名/公司/号码当作客户信息。
- transcript 中以 "客户:" 开头的发言才是客户本人发出的。
- 销售本人身份：姓名="${sellerName || '(未知)'}"，WhatsApp id="${sellerId || '(未知)'}"。
  → summary / notes / preferences / customerName 里**绝不能**出现 "${sellerName}" 作为客户姓名。
  → 销售「打招呼」「报名字」「自我介绍」都不是客户信息。

【客户姓名识别（重要，别漏判）】
- 只要客户在 "客户:" 发言里报过自己的名字，就要填进 customerName。常见形态：
  · 销售问 "your name / full name / 怎么称呼 / 收货人" 后，客户回复的名字（哪怕和地址、电话写在同一行，例如「Ellen, 600 Bellevue way ne, ...」里的 Ellen 就是客户名）。
  · 客户自我介绍 "I'm Ellen / 我是小王 / This is Ellen"。
  · 下单/收货信息里的收件人姓名。${displayNameHint}
- 只有当上述线索都没有、且 WhatsApp 显示名也不可信时，customerName 才填 ""（空），并在 summary 写「客户尚未报姓名」。
- 不要因为过度谨慎而漏掉客户明明已经给出的名字。

只返回严格 JSON（不要 \`\`\` 包裹）：
{
  "customerName": "客户本人姓名；没有可靠来源就填 ''（绝不能是销售名）",
  "summary": "1-2 句中文概览：客户是谁（有名字就带上）、关心什么、当前阶段（不要写销售本人姓名）",
  "language": "客户主要使用的语言代码（zh / en / de / fr / it / ja / ko / 其它）",
  "preferences": ["3-6 条具体偏好关键词，如 '白色运动鞋' / '42 码' / '货到付款'"],
  "priceBand": "价位估计，如 '价格敏感' / '中端' / '中高端' / '高端'；不确定填 ''",
  "interests": ["1-4 条品类关键词，如 '箱包' / '手表'"],
  "notes": "1 句中文补充，例如沟通风格、决策周期、特别要求（不要写销售本人姓名）"
}

聊天记录：
${transcript}`;
}

function parseProfile(raw: string): NonNullable<Contact['aiProfile']> | { error: string } {
  let parsed: Record<string, unknown> = {};
  try {
    const clean = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    return { error: `AI 返回非 JSON：${err instanceof Error ? err.message : String(err)}` };
  }
  const asStr = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
  const asArr = (v: unknown, max: number) =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : undefined;
  return {
    summary: asStr(parsed.summary),
    customerName: asStr(parsed.customerName),
    language: asStr(parsed.language),
    preferences: asArr(parsed.preferences, 8),
    priceBand: asStr(parsed.priceBand),
    interests: asArr(parsed.interests, 6),
    notes: asStr(parsed.notes)
  };
}

/** 给定 contactId，找会话并写入画像。 */
export async function summarizeContactById(
  contactId: string,
  cfg: AzureCfg
): Promise<ProfileResult> {
  const contact = await getContact(contactId);
  if (!contact) return { ok: false, status: 404, error: '联系人不存在' };
  // 本项目会话 id 格式：phone 会话是纯 E.164 数字（不带 @c.us），LID 会话带 @lid
  const candidates: string[] = [];
  if (contact.phone) candidates.push(contact.phone);
  if (contact.lid) {
    candidates.push(contact.lid);
    if (!contact.lid.includes('@')) candidates.push(`${contact.lid}@lid`);
  }
  if (candidates.length === 0) {
    return { ok: false, status: 400, error: '联系人未关联 WhatsApp 号' };
  }
  const conv = (await listConversations()).find((c) => candidates.includes(c.id));
  if (!conv) return { ok: false, status: 404, error: '未找到匹配的 WhatsApp 会话' };
  return runForConvId(contact.id, conv.id, cfg);
}

/**
 * 给定 WA conversationId 直接生成画像。
 * 如果 CRM 里还没这个联系人，会自动 upsert 一条 source='inbox' 的占位记录。
 */
export async function summarizeByConversationId(
  conversationId: string,
  cfg: AzureCfg,
  fallbackName?: string
): Promise<ProfileResult> {
  // 会话 id 两种格式：
  //  - 手机号会话：纯 E.164 数字（例 8618071282867）
  //  - LID 会话：带 @lid 后缀（例 1234567890@lid）
  let phone: string | undefined;
  let lid: string | undefined;
  if (conversationId.endsWith('@lid')) {
    lid = conversationId;
  } else if (/^\d{5,16}$/.test(conversationId)) {
    phone = conversationId;
  } else if (conversationId.endsWith('@c.us')) {
    // 兼容：万一哪天换成 @c.us 也能走
    phone = conversationId.split('@')[0];
  } else {
    return { ok: false, status: 400, error: `无法识别会话 id 类型: ${conversationId}` };
  }
  // 找 / 建 contact
  const { contact } = await upsertContact({
    phone,
    lid,
    name: fallbackName,
    source: 'inbox'
  });
  return runForConvId(contact.id, conversationId, cfg);
}

async function runForConvId(
  contactId: string,
  conversationId: string,
  cfg: AzureCfg
): Promise<ProfileResult> {
  const messages = await getMessages(conversationId, 50);
  if (messages.length === 0) return { ok: false, status: 400, error: '该会话没有消息' };
  // 销售本人身份——告诉 AI 哪些名字绝不能当客户名。避免出现 "客户名为 Eric" 之类倒错。
  const me = getPersonalStatus().me;
  const sellerName = me?.name ?? '';
  const sellerId = me?.id ?? '';
  // WhatsApp 会话显示名（备注名/昵称）——作为客户姓名的有力线索传给 AI。
  const convDisplayName = (await listConversations()).find((c) => c.id === conversationId)?.name;
  const prompt = buildPrompt(messages, sellerName, sellerId, convDisplayName);
  const result = await callAzureResponses(cfg, prompt, {
    maxOutputTokens: 700,
    timeoutMs: 45_000
  });
  if (!result.ok) return { ok: false, status: 502, error: result.error };
  const parsed = parseProfile(result.text);
  if ('error' in parsed) return { ok: false, status: 502, error: parsed.error };

  // 后处理绚线：如果 AI 仍然把销售名写进画像里，取掉或该殊。
  const sellerNameLow = sellerName.trim().toLowerCase();
  const containsSeller = (s?: string) =>
    !!s && !!sellerNameLow && s.toLowerCase().includes(sellerNameLow);
  // customerName 如果误填了销售名，清空；否则保留客户名。
  if (containsSeller(parsed.customerName)) {
    parsed.customerName = undefined;
  }
  // summary / notes 如果提到销售名为客户，足迹词过滤
  if (containsSeller(parsed.summary)) {
    parsed.summary = `客户尚未报姓名（原 AI 推断含销售本人名字，已过滤）。`;
  }
  if (containsSeller(parsed.notes)) {
    parsed.notes = undefined;
  }
  // preferences 里如果丢进了销售名，给刪掉
  if (parsed.preferences?.length && sellerNameLow) {
    parsed.preferences = parsed.preferences.filter(
      (p) => !p.toLowerCase().includes(sellerNameLow)
    );
    if (parsed.preferences.length === 0) parsed.preferences = undefined;
  }

  const aiProfile = {
    ...parsed,
    lastSummaryAt: Date.now(),
    basedOnTurns: messages.length
  };
  // 若识别到客户姓名、且联系人当前没有名字（或名字就是手机号占位），顺手回填 contact.name。
  const existing = await getContact(contactId);
  const namePatch: { name?: string } = {};
  if (
    parsed.customerName &&
    (!existing?.name || existing.name === existing.phone || existing.name === existing.lid)
  ) {
    namePatch.name = parsed.customerName;
  }
  const updated = await updateContact(contactId, { aiProfile, ...namePatch });
  if (!updated) return { ok: false, status: 500, error: '写入画像失败' };
  return { ok: true, contact: updated };
}
