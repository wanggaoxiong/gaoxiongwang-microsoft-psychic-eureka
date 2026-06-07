import { NextResponse } from 'next/server';
import { importAllContacts } from '@/lib/wa/personal-client';

export const dynamic = 'force-dynamic';

/** POST /api/wa/personal/import-contacts —— 把 WhatsApp 通讯录里所有联系人导入侧栏 */
export async function POST() {
  const r = await importAllContacts();
  return NextResponse.json({ ok: !r.reason, ...r });
}
