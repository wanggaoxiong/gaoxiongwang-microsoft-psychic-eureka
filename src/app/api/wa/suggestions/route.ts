import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getMessages, listConversations } from '@/lib/wa/store';
import { findContactByPhoneOrLid } from '@/lib/contacts/store';
import { callAzureResponses, resolveAzure } from '@/lib/ai/azure';
import { SUPPORTED_LANGS } from '@/lib/i18n/languages';
import { buildCatalogContextForMessages } from '@/lib/catalog/ai-context';

/**
 * POST /api/wa/suggestions
 * 输入：{ conversationId, count?, lang?, azure }
 *  - conversationId：当前会话 id
 *  - count：候选条数，默认 5
 *  - lang：覆盖目标输出语言；未传则用会话的 outputLang，再否则用客户最近一条消息的语言（AI 自己判断），再否则中文
 *
 * 输出：{ items: string[], lang: string, basedOnTurns: number }
 *
 * 设计要点：
 * - 只取最近 12 条消息作为上下文（含我方与客户）。再长容易让 AI 跑偏。
 * - 图片消息以 `[图片]` / `[图片: 商品标题]` 形式参与上下文，避免 base64 撑爆 prompt。
 * - 销售场景固定 system role：B2B WhatsApp 卖家助手，输出短、可直接发送、不编造价格 / 库存 / 交期。
 * - 强约束输出格式：每行一条、无编号、无引号、长度 ≤ 80 字。
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  conversationId: z.string().min(1),
  count: z.number().int().positive().max(10).optional(),
  lang: z.string().optional(),
  azure: z
    .object({
      endpoint: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional()
    })
    .optional()
});

function langLabel(code: string): string {
  const hit = SUPPORTED_LANGS.find((l) => l.code === code);
  return hit?.englishName ?? code;
}

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const count = body.count ?? 5;
    const cfg = resolveAzure(body.azure);
    if (!cfg) {
      return NextResponse.json(
        { error: '未配置 AI：请先在「设置 → AI 模型」填写 Endpoint / API Key' },
        { status: 400 }
      );
    }

    // 取最近 12 条
    const all = await getMessages(body.conversationId, 12);
    const conv = (await listConversations()).find((c) => c.id === body.conversationId);
    if (all.length === 0) {
      return NextResponse.json({ error: '该会话还没有消息，无法生成建议' }, { status: 400 });
    }

    // 解析目标语言优先级：body.lang > 会话 outputLang > 让 AI 跟随客户语言
    const targetLang =
      body.lang || conv?.outputLang || 'auto';

    // 长期画像注入：从 conversationId 反推 phone/lid，查 contacts，若有 aiProfile 就喂给 AI
    // 这里特意不"按需触发 summarize"，画像更新只发生在用户手动点按钮时；本接口只读 + 注入
    // 会话 id 格式：纯数字 = phone；@lid 后缀 = LID
    const convId = body.conversationId;
    let phone: string | undefined;
    let lid: string | undefined;
    if (convId.endsWith('@lid')) lid = convId;
    else if (/^\d{5,16}$/.test(convId)) phone = convId;
    else if (convId.endsWith('@c.us')) phone = convId.split('@')[0];
    const contact = phone || lid ? await findContactByPhoneOrLid(phone, lid) : null;
    let profileBlock = '';
    if (contact?.aiProfile?.summary) {
      const p = contact.aiProfile;
      const bits: string[] = [`Summary: ${p.summary}`];
      if (p.preferences?.length) bits.push(`Preferences: ${p.preferences.join(' / ')}`);
      if (p.priceBand) bits.push(`Price band: ${p.priceBand}`);
      if (p.interests?.length) bits.push(`Interests: ${p.interests.join(' / ')}`);
      if (p.notes) bits.push(`Notes: ${p.notes}`);
      profileBlock = `\n\nLong-term customer profile (from prior chats, may be stale):\n${bits.join('\n')}\n`;
    }

    // 构造紧凑的 transcript
    const lines = all.map((m) => {
      const who = m.direction === 'in' ? '客户' : '我(销售)';
      let body = '';
      if (m.text) body = m.text;
      else if (m.imageUrls?.length) body = `[图片${m.productTitle ? `: ${m.productTitle}` : ''}]`;
      else if (m.videoUrls?.length) body = '[视频]';
      else body = '[空]';
      // 截断单条避免极端长
      if (body.length > 280) body = body.slice(0, 280) + '…';
      return `${who}: ${body}`;
    });
    const transcript = lines.join('\n');
    const catalogContext = await buildCatalogContextForMessages(all, 5);

    const langInstruction =
      targetLang === 'auto'
        ? 'Output language MUST exactly match the customer\'s last message language. If the customer used Chinese, reply in 简体中文; English → English; etc.'
        : `Output language MUST be ${langLabel(targetLang)} (code: ${targetLang}). If lang=zh use 简体中文.`;

    const prompt = `You are a senior B2B WhatsApp sales assistant helping a Chinese seller close orders with overseas buyers.
Below is the most recent chat transcript with one customer (oldest first). Generate ${count} short, ready-to-send next-reply suggestions the seller can use to keep the conversation moving toward a purchase.

${langInstruction}

Hard rules:
1. Each line is ONE standalone WhatsApp message, no numbering, no quotes, no bullet markers.
2. Each reply ≤ 80 characters (CJK counted as 1 char). Tone: friendly, professional, concise.
3. Cover DIFFERENT useful angles given the context. Typical angles after sending product images:
   - ask which size / color the customer needs
   - ask quantity / shipping destination
   - mention stock availability without inventing a number ("现货充足" 类话术请用模糊表达)
   - invite the customer to send a reference photo if they want similar styles
   - offer a tiered discount hint without committing to a specific price
4. NEVER invent specific prices, stock counts, ship dates, or product SKUs that didn't appear in the transcript. Use placeholders like {价格} / {交期} if needed, OR phrase as a question.
5. If catalog matches are provided and relevant, use them to make suggestions concrete; if not relevant, ignore them.
6. If the customer is close to buying or asking for options, include at least one line that offers to send matching product photos/styles.
7. At most ONE emoji per reply, optional.
8. Output ONLY the ${count} lines. No preamble, no explanation, no markdown.

=== Conversation-style guidance (very important) ===

A. Detect the customer's intent in the LAST message and adapt:
   - "business" (asks about product / price / shipping / size / MOQ / payment) → focus on closing.
   - "small-talk" (greetings, weather, weekend, food, festival wishes, jokes, compliments, "how are you", emoji-only) → warm up first, then ONE gentle business pivot. Do NOT spam product info.
   - "mixed" → ack the small-talk in one short clause, then a soft business hook.

B. Small-talk style (when intent = small-talk or mixed):
   - Mirror the customer's energy & vocabulary; use the same emoji density as them (0–1).
   - Be specific and human: reference what they actually said (e.g. their city's weather, the festival they mentioned, their photo). Vague replies like "haha yes" feel like a bot.
   - Use ONE light personal touch (a tiny preference, a tiny opinion, a tiny local detail) — never a fabricated life event. Examples that are safe: "周一忙完订单才缓过来 😅" / "我也常喝美式" / "今天上海下雨，仓库湿度有点高".
   - End AT MOST 1 of the ${count} small-talk lines with a soft business bridge ("对了，上次看的那款要不要我再发个细节图？"). The other lines should be pure rapport — let the seller pick.

C. Sensitive / privacy / off-track topics — deflect gracefully WITHOUT sounding like a robot or a policy notice:
   Topics to deflect: personal questions about the seller (age, marital status, salary, home address, religion, sexuality), politics, regional/ethnic disputes, war, requests for the customer's personal info beyond shipping needs, drugs, gambling, anything illegal, "are you a bot / AI / real person", asking for free samples in a pushy way, requests to move off-platform to dubious channels, flirting / sexual content.

   Deflection technique (use ANY mix, never all the same):
   - Acknowledge briefly + redirect with humor or a relevant business question. E.g. "哈哈这个话题太大了，咱聊点轻松的——你上次说要的那双鞋码确认了吗？"
   - Use a humble, slightly self-deprecating tone ("我不太懂这块" / "工作日脑子转不动 😅") so the deflection feels natural, not corporate.
   - For "are you a bot / 真人吗 / 是 AI 吗"-type probes: NEVER deny being human in an over-explicit way (that itself reads as AI). Reply naturally and human: a small concrete detail about today + a normal business question. E.g. "我啊，刚发完一批货回来 😄 你那边几点啦？" — keep it short, do not over-protest.
   - For political / religious / regional questions: politely sidestep ("这块我真不在行，怕说不专业 😅"), then steer back to business.
   - For requests to share private info about other clients / prices given to others: refuse softly ("这个不太方便讲，每个客户情况都不太一样"), then offer something concrete you CAN share.
   - NEVER use phrases that out you as AI: "作为一个 AI / As an AI", "I'm just a language model", "I cannot discuss", "according to my guidelines", "出于隐私保护原则", "根据公司规定我无法…". Speak like a busy human salesperson, not a policy bot.

D. Anti-"AI tell" style rules (apply to ALL outputs):
   - Avoid over-polished, symmetric, listy phrasing. Real sellers type fast and a bit casual.
   - Avoid filler openers: "当然可以！" / "Sure thing!" / "Absolutely!" / "Of course," / "I understand that…" — drop them.
   - Avoid generic empathy templates: "I totally understand your concern" / "感谢您的反馈" — too corporate.
   - Prefer contractions, particles, and short clauses: "嗯～" "哈" "～" "啦" "哦" "lol" "haha" when matching the customer's register; skip if the customer is formal.
   - One small typo-style human touch is OK occasionally (an ellipsis, a "嗯…", a "对了"), but do not overdo it.
   - Vary sentence openings across the ${count} lines; do not start two lines the same way.
   - Do not greet again ("Hi!" / "你好") if the conversation is already mid-flow.

E. Priority when small-talk and business co-exist in the LAST customer message:
   - Lead with 1 warm human line acknowledging the small-talk part,
   - then ${Math.max(1, count - 2)} business-oriented suggestions,
   - then 1 soft bridge line. Order does not matter — the seller will pick one.

${profileBlock}
Recent transcript:
${transcript}${catalogContext}`;

    const result = await callAzureResponses(cfg, prompt, { maxOutputTokens: 700 });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    const items = result.text
      .split(/\r?\n/)
      .map((s) => s.replace(/^\s*\d+[.、)]\s*/, '').replace(/^[-*•]\s*/, '').replace(/^["「『]|["」』]$/g, '').trim())
      .filter((s) => s.length > 0 && s.length <= 200)
      .slice(0, count);

    if (items.length === 0) {
      return NextResponse.json({ error: 'AI 返回为空' }, { status: 502 });
    }

    return NextResponse.json({ items, lang: targetLang, basedOnTurns: all.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '生成失败' },
      { status: 400 }
    );
  }
}
