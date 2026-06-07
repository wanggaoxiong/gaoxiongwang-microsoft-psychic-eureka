import { NextResponse } from 'next/server';
import { logoutPersonalClient } from '@/lib/wa/personal-client';

export const dynamic = 'force-dynamic';

/**
 * 退出当前账号登录。
 * Body 可选：{ wipeSession?: boolean }
 *  - wipeSession=false（默认）：保留 data/.wwebjs_auth/session-<id>/，下次启动可免扫码
 *  - wipeSession=true：连本地浏览器 session 一起抹掉，下次必须重新扫码
 *
 * 不论选项如何，都**不会**动手机端 / WhatsApp 服务器，
 * 也**不会**动本地聊天数据（wa-messages.json 等）。
 */
export async function POST(request: Request) {
  let wipeSession = false;
  try {
    const body = (await request.json()) as { wipeSession?: unknown };
    wipeSession = body?.wipeSession === true;
  } catch {
    /* 允许空 body：保持默认 */
  }
  await logoutPersonalClient({ wipeSession });
  return NextResponse.json({ ok: true, wipeSession });
}
