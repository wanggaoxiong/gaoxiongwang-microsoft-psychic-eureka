import { NextResponse } from 'next/server';
import {
  getMessages,
  markRead,
  deleteConversation,
  renameConversation,
  mergeConversations,
  setConversationOutputLang,
  setConversationAutoMode
} from '@/lib/wa/store';

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const messages = await getMessages(params.id);
  await markRead(params.id);
  return NextResponse.json({ messages });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  await deleteConversation(params.id);
  return NextResponse.json({ ok: true });
}

/**
 * PATCH /api/wa/conversations/[id]
 * Body 三选一：
 * - { name: string }                  改名
 * - { mergeInto: string }             把当前会话合并到目标会话（消息全部迁移过去，自身被删除）
 * - { outputLang: string | null }     设定 / 清空发出语言锁（null 或空串 = 清空）
 * - { autoMode: string | null }       设定 / 清空该会话 AI 自动化档位（null = 跟随全局）
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  let body: {
    name?: string;
    mergeInto?: string;
    outputLang?: string | null;
    autoMode?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }
  if (typeof body.name === 'string') {
    await renameConversation(params.id, body.name);
    return NextResponse.json({ ok: true });
  }
  if (typeof body.mergeInto === 'string' && body.mergeInto && body.mergeInto !== params.id) {
    await mergeConversations(params.id, body.mergeInto);
    return NextResponse.json({ ok: true, mergedInto: body.mergeInto });
  }
  if ('outputLang' in body) {
    const next = body.outputLang;
    await setConversationOutputLang(params.id, typeof next === 'string' && next ? next : null);
    return NextResponse.json({ ok: true, outputLang: next || null });
  }
  if ('autoMode' in body) {
    const next = body.autoMode;
    await setConversationAutoMode(params.id, typeof next === 'string' && next ? next : null);
    return NextResponse.json({ ok: true, autoMode: next || null });
  }
  return NextResponse.json({ ok: false, error: 'no-op' }, { status: 400 });
}
