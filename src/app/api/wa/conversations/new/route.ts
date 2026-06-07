import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureEmptyConversations } from '@/lib/wa/store';
import { checkPersonalNumber } from '@/lib/wa/personal-client';
import { resolveAlias, warmAliases } from '@/lib/wa/alias-map';

export const dynamic = 'force-dynamic';

const schema = z.object({
  phone: z.string().min(5),
  name: z.string().optional(),
  /** 是否要求先用 WA isRegisteredUser 校验该号码已注册 WhatsApp，默认 true */
  verify: z.boolean().optional()
});

/**
 * POST /api/wa/conversations/new
 * 手动新建一个会话（输入电话号即可，不需要先把对方加进通讯录）。
 * - 默认会调 WA 的 isRegisteredUser 校验，号码没注册 WA 时拒绝创建
 * - 已存在 canonical 会话时直接返回，不重复创建
 * 返回 { ok, conversationId, alreadyExists, verified }
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid JSON' }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 }
    );
  }
  const phone = parsed.data.phone.replace(/\D/g, '');
  if (phone.length < 5 || phone.length > 16) {
    return NextResponse.json({ ok: false, reason: '电话号格式不对（应为 E.164 数字）' }, { status: 400 });
  }

  const verify = parsed.data.verify !== false;
  let verified = false;
  if (verify) {
    const r = await checkPersonalNumber(phone);
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, reason: `校验失败：${r.reason}（可设 verify=false 跳过）` },
        { status: 400 }
      );
    }
    if (!r.registered) {
      return NextResponse.json(
        { ok: false, reason: '该号码未注册 WhatsApp' },
        { status: 400 }
      );
    }
    verified = true;
  }

  await warmAliases();
  const conversationId = resolveAlias(phone);
  const { added } = await ensureEmptyConversations([
    { id: conversationId, name: parsed.data.name?.trim() || undefined }
  ]);
  return NextResponse.json({
    ok: true,
    conversationId,
    alreadyExists: added === 0,
    verified
  });
}
