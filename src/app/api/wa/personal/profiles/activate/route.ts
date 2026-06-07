import { NextResponse } from 'next/server';
import {
  getActiveProfileId,
  setActiveProfileId,
  wipeProfileData
} from '@/lib/wa/profiles';
import { logoutPersonalClient } from '@/lib/wa/personal-client';

export const dynamic = 'force-dynamic';

/**
 * 切换激活账号 profile。
 * Body: { id: string; wipeCurrentSession?: boolean; wipeCurrentData?: boolean }
 * - 先强制 logout 当前 client（避免消息错落到新 profile 文件）
 * - 按选项清理「当前 profile」（即切换前的那个）的本地浏览器 session / 聊天数据
 * - 再切换 active，让下次 store / start 读到新 profile 路径
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid JSON' }, { status: 400 });
  }
  const obj = (body ?? {}) as {
    id?: unknown;
    wipeCurrentSession?: unknown;
    wipeCurrentData?: unknown;
  };
  const nextId = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (!nextId) {
    return NextResponse.json({ ok: false, reason: 'id 必填' }, { status: 400 });
  }
  const wipeCurrentSession = obj.wipeCurrentSession === true;
  const wipeCurrentData = obj.wipeCurrentData === true;

  const currentId = await getActiveProfileId();
  // 同 profile 切换 = 空操作（避免误触把自己 logout）
  if (currentId === nextId) {
    return NextResponse.json({ ok: true, active: nextId, noop: true });
  }

  // 1. 必须先停掉当前 client；不论是否抹 session，destroy 一次让浏览器进程退出
  //    wipeCurrentSession 决定是否同时把 .wwebjs_auth/session-<currentId>/ 删干净
  await logoutPersonalClient({ wipeSession: wipeCurrentSession });

  // 2. 按需清当前 profile 的本地聊天数据（不动手机端 / WA 服务器）
  if (wipeCurrentData) {
    await wipeProfileData(currentId);
  }

  // 3. 切到新 profile（profiles.ts 内部会重置 alias / send-routing 缓存）
  try {
    await setActiveProfileId(nextId);
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true, active: nextId });
}
