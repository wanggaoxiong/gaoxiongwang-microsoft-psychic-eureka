import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getContact, setVerified } from '@/lib/contacts/store';
import { checkPersonalNumber } from '@/lib/wa/personal-client';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500)
});

/**
 * 批量校验联系人手机号是否注册了 WhatsApp。
 * - 串行 + 600ms 间隔，避免触发个人号限流
 * - 没有 phone 的联系人（仅 LID）跳过
 * - 任何错误都返回到对应 id 的结果里，整体不中断
 */
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
  const results: Array<{
    id: string;
    ok: boolean;
    registered?: boolean;
    skipped?: boolean;
    reason?: string;
  }> = [];
  for (const id of parsed.data.ids) {
    const c = await getContact(id);
    if (!c) {
      results.push({ id, ok: false, reason: 'not found' });
      continue;
    }
    if (!c.phone) {
      results.push({ id, ok: false, skipped: true, reason: '无 phone（只有 LID 无法校验）' });
      continue;
    }
    const r = await checkPersonalNumber(c.phone);
    if (r.ok && typeof r.registered === 'boolean') {
      await setVerified(id, r.registered);
      results.push({ id, ok: true, registered: r.registered });
    } else {
      results.push({ id, ok: false, reason: r.reason ?? 'unknown' });
    }
    await new Promise((res) => setTimeout(res, 600));
  }
  return NextResponse.json({ ok: true, results });
}
