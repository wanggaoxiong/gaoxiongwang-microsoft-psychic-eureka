import { NextResponse } from 'next/server';
import { z } from 'zod';
import { writeServerAzureConfig, clearServerAzureConfig } from '@/lib/ai/server-config';
import { normalizeAzureEndpoint } from '@/lib/ai/azure';

/**
 * 把前端 localStorage 里的 Azure 配置同步一份到服务端 data/ai-config.json，
 * 让后端自动响应（DRAFT_AUTO / AUTO_*）也能调 AI。
 *
 *   POST   → 写入（三个字段必填）
 *   DELETE → 清除
 *
 * 注意：apiKey 是机密，但本应用本来就是单机本地工具，data/ 同样存了 WhatsApp
 * 对话 / 联系人等机密；用同样的隔离级别即可。
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  endpoint: z.string().min(1, 'endpoint 必填'),
  apiKey: z.string().min(1, 'apiKey 必填'),
  model: z.string().min(1, 'model 必填')
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const endpoint = normalizeAzureEndpoint(body.endpoint);
    if (!endpoint) {
      return NextResponse.json({ error: 'endpoint 无效' }, { status: 400 });
    }
    await writeServerAzureConfig({ endpoint, apiKey: body.apiKey.trim(), model: body.model.trim() });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '保存失败';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE() {
  try {
    await clearServerAzureConfig();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : '清除失败' },
      { status: 500 }
    );
  }
}
