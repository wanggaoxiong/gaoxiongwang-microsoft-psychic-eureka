import { NextResponse } from 'next/server';
import { addProfile, listProfiles, isValidProfileId } from '@/lib/wa/profiles';

export const dynamic = 'force-dynamic';

export async function GET() {
  const data = await listProfiles();
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid JSON' }, { status: 400 });
  }
  const obj = (body ?? {}) as { id?: unknown; label?: unknown };
  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  const label = typeof obj.label === 'string' ? obj.label : undefined;
  if (!isValidProfileId(id)) {
    return NextResponse.json(
      { ok: false, reason: 'id 仅支持 1-32 位小写字母 / 数字 / 下划线 / 连字符' },
      { status: 400 }
    );
  }
  try {
    const info = await addProfile({ id, label });
    return NextResponse.json({ ok: true, profile: info });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
