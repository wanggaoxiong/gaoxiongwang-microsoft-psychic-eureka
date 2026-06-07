import { NextResponse } from 'next/server';
import { z } from 'zod';
import { searchCatalogByImage } from '@/lib/catalog/image-search';

/**
 * POST /api/catalog/ai-search-image
 * Body:
 *   { imageUrl?: string; imageDataUrl?: string; hint?: string; limit?: number;
 *     azure?: { endpoint?, apiKey?, model? } }
 *
 * 行为：见 lib/catalog/image-search.ts；本 route 只是一层 HTTP wrapper，
 * inbound 自动化路径直接 import `searchCatalogByImage` 调用同一实现。
 */

const bodySchema = z
  .object({
    imageUrl: z.string().url().optional(),
    imageDataUrl: z.string().regex(/^data:image\//).optional(),
    hint: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    azure: z
      .object({
        endpoint: z.string().optional(),
        apiKey: z.string().optional(),
        model: z.string().optional()
      })
      .optional()
  })
  .refine((b) => !!b.imageUrl || !!b.imageDataUrl, {
    message: '必须提供 imageUrl 或 imageDataUrl 之一'
  });

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const out = await searchCatalogByImage({
      imageUrl: body.imageUrl,
      imageDataUrl: body.imageDataUrl,
      hint: body.hint,
      limit: body.limit,
      azure: body.azure
    });
    if (!out.ok) {
      return NextResponse.json({ error: out.error }, { status: out.status || 502 });
    }
    return NextResponse.json(out.result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '以图搜图失败' },
      { status: 400 }
    );
  }
}
