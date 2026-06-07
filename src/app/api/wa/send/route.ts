import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sendWhatsAppText, sendWhatsAppImage } from '@/lib/wa/cloud-api';
import { sendPersonalText, sendPersonalImage, sendPersonalMedia, isPersonalReady } from '@/lib/wa/personal-client';
import { appendOutgoing, getMessageById, updateMessage } from '@/lib/wa/store';
import { resolveAlias, warmAliases } from '@/lib/wa/alias-map';
import {
  autopilotGate,
  logAiAction,
  type AiSource,
  type AutoMode
} from '@/lib/ai/autopilot';

const schema = z.object({
  to: z.string().min(3),
  /** 会话名称（添加联系人时传入），避免 store 里出现「私密联系人」兑底 */
  name: z.string().optional(),
  text: z.string().optional(),
  // imageUrls 接受 http(s) URL 或 data: base64（用于客户端拼接好的拼图）
  imageUrls: z
    .array(z.string().refine((s) => /^https?:\/\//.test(s) || s.startsWith('data:image/'), 'invalid image url'))
    .optional(),
  // videoUrls 接受 http(s) URL 或 data:video/*（用于粘贴/上传的视频）
  videoUrls: z
    .array(z.string().refine((s) => /^https?:\/\//.test(s) || s.startsWith('data:video/'), 'invalid video url'))
    .optional(),
  mode: z.enum(['personal', 'cloud']).optional(),
  phoneNumberId: z.string().optional(),
  accessToken: z.string().optional(),
  productId: z.string().optional(),
  productTitle: z.string().optional(),
  quoteText: z.string().optional(),
  /**
   * 被引用的源消息 id（本地 store id）。
   * - 入站消息为 `wweb_<_serialized>` 格式，personal-client 会去头后传给 whatsapp-web.js
   *   使对方 WhatsApp 联人看到原生「引用〔某条消息〕」样式。
   * - 不能被 WA 识别的（如本地 out_ 开头的）仅用作 UI 快照，不会发送原生 quoted。
   */
  quotedMessageId: z.string().optional(),
  /** 发送来源：默认 human；AI 建议条 ⚡ 直发传 suggest-click */
  aiSource: z.enum(['human', 'suggest-click', 'auto-safe', 'auto-full']).optional(),
  /** 当前会话档位（用于 gate 判定，前端可传 activeConv.autoMode） */
  aiMode: z.enum(['OFF', 'SUGGEST', 'DRAFT_AUTO', 'AUTO_SAFE', 'AUTO_FULL']).optional(),
  /** AI 触发原因，写入 message + action log，便于复盘 */
  aiReason: z.string().max(200).optional(),
  /**
   * 重试场景：传入失败消息的 id，本接口先把它置为 'sending'，
   * 真正发送完成后再把同一条记录更新为 'sent' / 'failed'，
   * 避免在会话里出现「失败原条 + 重试新条」的重复气泡。
   */
  retryMessageId: z.string().optional()
});

export type SendInput = z.infer<typeof schema>;

/**
 * 真正执行发送逻辑（personal / cloud 都在这里分发）。
 * 抽成函数是为了让 retry 路由也能复用同一套发送 + 间隔 + 错误聚合策略。
 */
async function performSend(input: SendInput): Promise<{
  ok: boolean;
  errors: string[];
  dryRun: boolean;
  /** WhatsApp 返回的「本次发出的第一条」的 _serialized id，用于后续「引用自己」 */
  waMessageId?: string;
}> {
  const rawTo = input.to.trim();
  const hasImages = !!(input.imageUrls && input.imageUrls.length > 0);
  const hasVideos = !!(input.videoUrls && input.videoUrls.length > 0);
  const mode: 'personal' | 'cloud' = input.mode ?? (isPersonalReady() ? 'personal' : 'cloud');
  const errors: string[] = [];
  let anyOk = false;
  let dryRun = false;
  let firstWaMessageId: string | undefined;
  const recordWaId = (id?: string) => {
    if (id && !firstWaMessageId) firstWaMessageId = id;
  };

  const personalTo = rawTo;
  const cloudTo = rawTo.replace(/\D/g, '');

  if (mode === 'personal') {
    // 引用本地「out_*」/「in_*」开头的条目时，查本地 store，
    // 拿到该条当初 WA 返回的 waMessageId（仅 outbound 会拿到）。
    // 这样「引用自己发出的消息」也能在对方手机上看到原生引用样式。
    let resolvedQuotedId = input.quotedMessageId;
    if (resolvedQuotedId && (resolvedQuotedId.startsWith('out_') || resolvedQuotedId.startsWith('in_'))) {
      const src = await getMessageById(resolvedQuotedId);
      resolvedQuotedId = src?.waMessageId ?? undefined;
    }
    const quotedOpts = resolvedQuotedId ? { quotedMessageId: resolvedQuotedId } : undefined;
    if (input.text && (hasImages || hasVideos)) {
      const tr = await sendPersonalText(personalTo, input.text, quotedOpts);
      if (tr.ok) anyOk = true;
      else errors.push(tr.reason ?? 'unknown');
      recordWaId(tr.waMessageId);
      await new Promise((res) => setTimeout(res, 600));
    }
    if (hasImages) {
      for (let i = 0; i < input.imageUrls!.length; i++) {
        const caption = !input.text && i === 0 ? input.productTitle : undefined;
        // 引用只需贴在「第一条」：避免多图重复引用同一条原文。
        const r = await sendPersonalImage(personalTo, input.imageUrls![i], caption, i === 0 && !input.text ? quotedOpts : undefined);
        if (r.ok) anyOk = true;
        else errors.push(r.reason ?? 'unknown');
        recordWaId(r.waMessageId);
        if (i < input.imageUrls!.length - 1) {
          await new Promise((res) => setTimeout(res, 600));
        }
      }
    }
    if (hasVideos) {
      for (let i = 0; i < input.videoUrls!.length; i++) {
        const r = await sendPersonalMedia(personalTo, input.videoUrls![i], undefined, i === 0 && !input.text && !hasImages ? quotedOpts : undefined);
        if (r.ok) anyOk = true;
        else errors.push(r.reason ?? 'unknown');
        recordWaId(r.waMessageId);
        if (i < input.videoUrls!.length - 1) {
          await new Promise((res) => setTimeout(res, 600));
        }
      }
    }
    if (!hasImages && !hasVideos && input.text) {
      const r = await sendPersonalText(personalTo, input.text, quotedOpts);
      if (r.ok) anyOk = true;
      else errors.push(r.reason ?? 'unknown');
      recordWaId(r.waMessageId);
    }
  } else if (hasImages) {
    for (let i = 0; i < input.imageUrls!.length; i++) {
      const caption = i === 0 ? input.text || input.productTitle : undefined;
      const r = await sendWhatsAppImage({
        to: cloudTo,
        imageUrl: input.imageUrls![i],
        caption,
        phoneNumberId: input.phoneNumberId,
        accessToken: input.accessToken
      });
      if (r.ok) anyOk = true;
      else errors.push(r.reason ?? 'unknown');
      if (r.dryRun) dryRun = true;
    }
  } else if (input.text) {
    const r = await sendWhatsAppText({
      to: cloudTo,
      text: input.text,
      phoneNumberId: input.phoneNumberId,
      accessToken: input.accessToken
    });
    if (r.ok) anyOk = true;
    else errors.push(r.reason ?? 'unknown');
    if (r.dryRun) dryRun = true;
  }

  // 去重 + 裁剪，避免多图多段失败时把同一长错误刷满 UI。
  const compactErrors = [...new Set(errors.map((e) => String(e).trim()).filter(Boolean))].map((e) =>
    e.length > 220 ? `${e.slice(0, 220)}...` : e
  );
  return { ok: anyOk, errors: compactErrors, dryRun, waMessageId: firstWaMessageId };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 }
    );
  }

  const input = parsed.data;
  if (!input.text && (!input.imageUrls || input.imageUrls.length === 0) && (!input.videoUrls || input.videoUrls.length === 0)) {
    return NextResponse.json(
      { ok: false, reason: 'text、imageUrls 或 videoUrls 至少需要一个' },
      { status: 400 }
    );
  }

  // 计算 conversationId：@c.us 退化成纯数字以兼容老数据，其它保留完整 id（避免 LID 串号）
  const rawTo = input.to.trim();
  let conversationId: string;
  if (rawTo.includes('@')) {
    conversationId = rawTo.endsWith('@c.us') ? rawTo.split('@')[0]!.replace(/\D/g, '') : rawTo;
  } else {
    conversationId = rawTo.replace(/\D/g, '');
  }
  // 保险：再过一道 alias，避免「用户从 LID 槽点的会话」发出去后又落回 LID 槽，
  // 而 alias 表早已把 LID 合并到了真实电话号 canonical。
  await warmAliases();
  conversationId = resolveAlias(conversationId);

  const aiSource: AiSource = input.aiSource ?? 'human';
  const aiMode: AutoMode | undefined = input.aiMode;
  const aiAuto = aiSource !== 'human';

  // 发送前总闸：kill switch / 会话暂停 / 档位约束 / 风险词降级
  const gate = await autopilotGate({
    conversationId,
    source: aiSource,
    conversationMode: aiMode,
    text: input.text
  });
  if (!gate.allow) {
    await logAiAction({
      conversationId,
      source: aiSource,
      mode: aiMode ?? 'SUGGEST',
      outcome: gate.downgrade === 'NEEDS_HUMAN' ? 'downgraded' : 'blocked',
      reason: gate.reason,
      textPreview: input.text
    });
    return NextResponse.json({ ok: false, reason: gate.reason }, { status: 409 });
  }

  const hasImages = !!(input.imageUrls && input.imageUrls.length > 0);
  const hasVideos = !!(input.videoUrls && input.videoUrls.length > 0);

  // === 重试分支 ===
  if (input.retryMessageId) {
    const existing = await getMessageById(input.retryMessageId);
    if (!existing) {
      return NextResponse.json({ ok: false, reason: '原消息不存在' }, { status: 404 });
    }
    // 先标 sending，前端立刻能看到「重发中」
    await updateMessage(input.retryMessageId, {
      status: 'sending',
      error: undefined,
      aiAuto,
      aiSource,
      aiReason: input.aiReason
    });
    const { ok, errors, dryRun, waMessageId } = await performSend(input);
    await updateMessage(input.retryMessageId, {
      status: ok ? 'sent' : 'failed',
      error: errors.length ? errors.join(' | ') : undefined,
      aiAuto,
      aiSource,
      aiReason: input.aiReason,
      // 重试成功时让消息「跳到底部」，更像新发的
      timestamp: ok ? Date.now() : existing.timestamp,
      waMessageId: waMessageId ?? existing.waMessageId
    });
    if (aiAuto) {
      await logAiAction({
        conversationId,
        source: aiSource,
        mode: aiMode ?? 'SUGGEST',
        outcome: ok ? 'sent' : 'blocked',
        reason: ok ? input.aiReason : errors.join(' | '),
        messageId: input.retryMessageId,
        textPreview: input.text
      });
    }
    return NextResponse.json({
      ok,
      dryRun,
      messageId: input.retryMessageId,
      reason: errors.length ? errors.join(' | ') : undefined
    });
  }

  // === 首发分支 ===
  const { ok: anyOk, errors, dryRun, waMessageId } = await performSend(input);
  const persisted = await appendOutgoing({
    conversationId,
    name: input.name,
    text: input.text,
    imageUrls: input.imageUrls,
    videoUrls: input.videoUrls,
    productId: input.productId,
    productTitle: input.productTitle,
    quoteText: input.quoteText,
    quotedMessageId: input.quotedMessageId,
    type: hasVideos ? 'video' : hasImages ? 'image' : 'text',
    status: anyOk ? 'sent' : 'failed',
    error: errors.length ? errors.join(' | ') : undefined,
    aiAuto,
    aiSource,
    aiReason: input.aiReason,
    waMessageId
  });

  if (aiAuto) {
    await logAiAction({
      conversationId,
      source: aiSource,
      mode: aiMode ?? 'SUGGEST',
      outcome: anyOk ? 'sent' : 'blocked',
      reason: anyOk ? input.aiReason : errors.join(' | '),
      messageId: persisted.id,
      textPreview: input.text
    });
  }

  return NextResponse.json({
    ok: anyOk,
    dryRun,
    messageId: persisted.id,
    reason: errors.length ? errors.join(' | ') : undefined
  });
}
