import { NextResponse } from 'next/server';
import { openLoginSession } from '@/lib/sources/crawler';
import { mockSupplierSources } from '@/mocks/supplierCatalog';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

/**
 * POST /api/sources/[id]/login
 *
 * 打开 headed Chromium 让用户手动登录，关闭窗口后把 session 持久化到
 * data/playwright-state/<sourceId>.json。下次 /discover 时自动复用。
 *
 * Body 可选: { loginUrl?: string }
 *
 * 注意：仅适用于本地开发环境（需要图形界面）。生产/Docker 环境无效。
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const sourceId = params.id;
  const source = mockSupplierSources.find((s) => s.id === sourceId);
  if (!source) {
    return NextResponse.json({ error: '未知 source' }, { status: 404 });
  }

  let body: { loginUrl?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* noop */
  }

  const loginUrl = body.loginUrl?.trim() || source.websiteUrl;
  const startedAt = Date.now();

  try {
    const result = await openLoginSession(sourceId, loginUrl);
    return NextResponse.json({
      ok: true,
      saved: result.saved,
      stateFile: result.stateFile,
      loginUrl,
      elapsedMs: Date.now() - startedAt
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        error: '登录窗口启动失败',
        reason: err?.message ?? String(err),
        loginUrl,
        hint: '仅在本地有图形界面的环境可用'
      },
      { status: 500 }
    );
  }
}
