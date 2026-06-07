import { NextResponse } from 'next/server';
import { z } from 'zod';
import axios from 'axios';
import { getMessages, listConversations } from '@/lib/wa/store';
import { normalizePhone } from '@/lib/contacts/store';
import { getPersonalStatus } from '@/lib/wa/personal-client';
import { httpsAgentWithCustomDns } from '@/lib/net/dns-agent';

export const dynamic = 'force-dynamic';

/**
 * 从指定会话的最近 N 条消息中，调用 Azure OpenAI 提取潜在的联系人信息草稿。
 * 不直接落库 —— 返回结构化 JSON 给前端，确认后再 POST /api/contacts 创建。
 *
 * 输入：
 *   {
 *     conversationId: string,
 *     limit?: number,            // 默认 60 条
 *     azure: { endpoint, apiKey, model }  // 透传 localStorage 里的 AI 配置
 *   }
 * 输出：{ ok, draft: { name?, company?, position?, phone?, tags? }, raw }
 */

const bodySchema = z.object({
  conversationId: z.string().min(1),
  limit: z.number().int().positive().max(500).optional(),
  azure: z
    .object({
      endpoint: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional()
    })
    .optional()
});

function normalizeAzureEndpoint(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/openai\/responses$/i, '')
    .replace(/\/openai\/v1\/responses$/i, '')
    .replace(/\/openai\/deployments\/[^/]+\/responses$/i, '')
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '');
}

function resolveAzure(override?: { endpoint?: string; apiKey?: string; model?: string }) {
  const endpoint = normalizeAzureEndpoint(
    override?.endpoint || process.env.AZURE_OPENAI_ENDPOINT || ''
  );
  const apiKey = (override?.apiKey || process.env.AZURE_OPENAI_API_KEY || '').trim();
  const model = (
    override?.model ||
    process.env.AZURE_OPENAI_DEPLOYMENT ||
    process.env.AZURE_OPENAI_MODEL ||
    'gpt-5.4'
  ).trim();
  if (!endpoint || !apiKey || !model) return null;
  return { endpoint, apiKey, model };
}

function extractText(data: unknown): string {
  const root = data as
    | { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }
    | undefined;
  if (typeof root?.output_text === 'string' && root.output_text.trim()) {
    return root.output_text.trim();
  }
  const parts: string[] = [];
  if (Array.isArray(root?.output)) {
    for (const item of root.output) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string') parts.push(part.text);
        }
      }
    }
  }
  return parts.join('\n').trim();
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const cfg = resolveAzure(parsed.data.azure);
  if (!cfg) {
    return NextResponse.json(
      { error: '未配置 AI：请先在「设置 → AI 模型」填写 Endpoint / API Key' },
      { status: 400 }
    );
  }

  const conversationId = parsed.data.conversationId;
  const [conv, msgs] = await Promise.all([
    listConversations().then((cs) => cs.find((c) => c.id === conversationId) ?? null),
    getMessages(conversationId, parsed.data.limit ?? 60)
  ]);

  // 销售本人信息：用来告诉 AI「我」是谁，防止把 transcript 里的『我自报姓名/号码』当成客户。
  const me = getPersonalStatus().me;
  const meName = me?.name ?? '';
  const meId = me?.id ?? '';

  // 会话类型：@lid 表示 WA 隐私 ID，没有可暴露的电话号；@g.us 是群聊
  const isLid = conversationId.endsWith('@lid');
  const isGroup = conversationId.endsWith('@g.us');
  const convPhoneCandidate = isLid || isGroup ? '' : conversationId.replace(/@.*/, '');

  // 拼一个对话脚本：方向 + 文本，便于模型识别"我"是销售、对方是客户
  const transcript = msgs
    .map((m) => {
      const who = m.direction === 'in' ? '客户' : '我(销售)';
      const text = m.text?.trim() || (m.imageUrls?.length ? '[图片]' : '');
      if (!text) return '';
      return `${who}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');

  // 会话 id 提示
  const idHint = isLid
    ? `当前会话 id 是 LID 形式 "${conversationId}"，**不要**给客户随便填写电话号码（除非客户在对话中明确说出了自己的号码）。`
    : isGroup
      ? `当前会话是群聊 "${conversationId}"，本次抽取无意义，请所有字段返回空字符串/空数组。`
      : `当前会话 id 是电话号 "${convPhoneCandidate}"（已是 E.164 数字，无 +）。如果客户没主动报新号码，phone 字段直接用这个值。`;

  const prompt = `你是销售助理。从下面这段 WhatsApp 对话里抽取「对方（客户）」的联系人信息，输出严格的 JSON。

【角色识别（最重要）】
- transcript 中以 "我(销售):" 开头的发言全部是销售本人发出的，**绝不能**把这些发言里出现的姓名 / 公司 / 电话号当作客户信息抽取。
- transcript 中以 "客户:" 开头的发言才是客户本人发出的。
- 我（销售）的身份：姓名="${meName || '(未知)'}"，wa_id="${meId || '(未知)'}"。
  → 如果在 transcript 里出现 "${meName}" 这个名字，那是销售自己，不要写到 name 字段。
  → 如果 transcript 里某个手机号等于 "${meId}" 或 "${meName}" 名下的号码，不要写到 phone 字段。

【字段规则】
- name：仅当客户在自己（"客户:"）的发言里报过姓名/昵称时填写；否则留空字符串。
- company：客户提到自己所在的公司；没有则空。
- position：客户的职位 / 角色；没有则空。
- phone：客户在自己的发言里明确说出的、属于"他自己"的手机号（E.164 数字，**只保留数字**，不要 +、空格、横线）。
  → ${idHint}
- tags：从对话主题里推断的 1-3 个短中文标签（如「鞋类」「批发」「美国客户」）；信息不足就返回空数组 []。
- summary：用一句话（≤40 字）概括客户画像，给销售当备注用；信息不足返回空字符串。

【输出】
只输出 JSON，不要 markdown 代码块、不要解释、不要前后缀。结构：
{"name":"","company":"","position":"","phone":"","tags":[],"summary":""}

会话备注名（销售自定义）：${conv?.name ?? '(无)'}

对话（最近 ${msgs.length} 条）：
${transcript || '(无文本消息)'}`;

  const url = `${cfg.endpoint}/openai/v1/responses`;
  let raw = '';
  try {
    const response = await axios.post(
      url,
      {
        model: cfg.model,
        max_output_tokens: 600,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
      },
      {
        timeout: 45_000,
        headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
        validateStatus: (s) => s >= 200 && s < 500,
        // 绕开 macOS mDNSResponder 卡住的 getaddrinfo；详见 src/lib/net/dns-agent.ts
        httpsAgent: httpsAgentWithCustomDns
      }
    );
    if (response.status >= 400 || response.data?.error) {
      const detail =
        response.data?.error?.message ?? JSON.stringify(response.data).slice(0, 300);
      return NextResponse.json({ error: `AI ${response.status}: ${detail}` }, { status: 502 });
    }
    raw = extractText(response.data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }

  const cleaned = raw.replace(/```json|```/g, '').trim();
  let draft: {
    name?: string;
    company?: string;
    position?: string;
    phone?: string;
    tags?: string[];
    summary?: string;
  } = {};
  try {
    draft = JSON.parse(cleaned);
  } catch {
    return NextResponse.json(
      { error: `AI 返回不是合法 JSON：${cleaned.slice(0, 200)}` },
      { status: 502 }
    );
  }

  // 规整 phone / lid：
  // - LID 会话：phone 留空（除非 AI 从对话里抽到客户自己报的号码）；lid 用 conversationId 本身。
  // - phone 会话：AI 没抽出时回退到 conv id 里的数字。
  // - 群聊：什么都不填。
  let phone: string | undefined;
  let lid: string | undefined;
  if (isGroup) {
    phone = undefined;
    lid = undefined;
  } else if (isLid) {
    lid = conversationId;
    phone = normalizePhone(draft.phone);
  } else {
    phone = normalizePhone(draft.phone) ?? normalizePhone(convPhoneCandidate);
    lid = undefined;
  }

  // 销售本人的号码绝不写进客户 phone（兜底防 prompt 越狱）
  if (phone && meId) {
    const meDigits = meId.replace(/\D/g, '');
    if (meDigits && phone === meDigits) phone = undefined;
  }
  // 销售本人的名字也不当客户姓名
  let name = draft.name?.trim() || undefined;
  if (name && meName && name.toLowerCase() === meName.toLowerCase()) {
    name = undefined;
  }

  return NextResponse.json({
    ok: true,
    draft: {
      name,
      company: draft.company?.trim() || undefined,
      position: draft.position?.trim() || undefined,
      phone,
      lid,
      tags: Array.isArray(draft.tags) ? draft.tags.filter((t) => typeof t === 'string') : [],
      note: draft.summary?.trim() || undefined
    },
    meta: {
      conversationId,
      kind: isGroup ? 'group' : isLid ? 'lid' : 'phone',
      me: { name: meName || undefined, id: meId || undefined }
    },
    raw
  });
}
