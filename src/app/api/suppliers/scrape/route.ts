import { NextResponse } from 'next/server';
import { z } from 'zod';
import { scrapeGxhyappDetail, parseDetailUrl } from '@/lib/suppliers/gxhyapp/scraper';
import { normalizeToProductCard } from '@/lib/suppliers/gxhyapp/normalizer';
import { scrapeNinetyIiDetail, parseNinetyIiDetailUrl } from '@/lib/suppliers/ninetyii/scraper';

const azureSchema = z
  .object({
    endpoint: z.string().trim().optional(),
    apiKey: z.string().trim().optional(),
    model: z.string().trim().optional()
  })
  .optional();

const bodySchema = z
  .object({
    /** 货源 ID，默认 gxhyapp。'90ii' 走 90ii.net */
    source: z.enum(['gxhyapp', '90ii']).optional(),
    url: z.string().url().optional(),
    code: z.string().min(1).optional(),
    marketCode: z.string().optional(),
    mainImageUrl: z.string().url().optional(),
    /** 用户从真实页面复制的补充文本（价格、商家、描述等），直接当信号送 LLM */
    extraText: z.string().max(4000).optional(),
    /** 是否用 Playwright 渲染 SPA + 整页截图（默认 true；可关闭以加速调试） */
    useRenderer: z.boolean().optional(),
    azure: azureSchema
  })
  .refine((v) => v.url || v.code, { message: '至少需要提供 url 或 code' });

function detectSource(input: { source?: string; url?: string }): 'gxhyapp' | '90ii' {
  if (input.source === '90ii' || input.source === 'gxhyapp') return input.source;
  if (input.url && /www\.90ii\.net/.test(input.url)) return '90ii';
  return 'gxhyapp';
}

export async function POST(request: Request) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '参数错误' },
      { status: 400 }
    );
  }

  const source = detectSource(parsed);

  const raw =
    source === '90ii'
      ? await scrapeNinetyIiDetail({
          url: parsed.url,
          code: parsed.code ?? parseNinetyIiDetailUrl(parsed.url ?? '').code,
          mainImageUrl: parsed.mainImageUrl,
          extraText: parsed.extraText
        })
      : await (async () => {
          const fromUrl = parsed.url ? parseDetailUrl(parsed.url) : {};
          return scrapeGxhyappDetail({
            url: parsed.url,
            code: parsed.code ?? fromUrl.code,
            marketCode: parsed.marketCode ?? fromUrl.marketCode,
            mainImageUrl: parsed.mainImageUrl,
            extraText: parsed.extraText,
            useRenderer: parsed.useRenderer
          });
        })();

  const card = await normalizeToProductCard(raw, parsed.azure);

  return NextResponse.json({
    source,
    card,
    raw: {
      sourceUrl: raw.sourceUrl,
      code: raw.code,
      marketCode: raw.marketCode,
      titleCandidates: raw.titleCandidates,
      priceCandidates: raw.priceCandidates,
      merchantCandidates: raw.merchantCandidates,
      brandCandidates: raw.brandCandidates,
      modelCandidates: raw.modelCandidates,
      descriptionBlocks: raw.descriptionBlocks.slice(0, 8),
      imageCount: raw.images.length,
      images: raw.images.slice(0, 12),
      renderedBodyText: raw.renderedBodyText?.slice(0, 1200),
      screenshotPresent: Boolean(raw.screenshotDataUrl)
    }
  });
}
