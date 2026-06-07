import { NextResponse } from 'next/server';
import { z } from 'zod';
import axios from 'axios';
import { getProduct, setProductLocalization } from '@/lib/catalog/repo';
import { isLangCode, SUPPORTED_LANGS, type LangCode, type LocalizedFields } from '@/lib/i18n/languages';

/**
 * POST /api/catalog/[id]/translate
 * Body: { lang: 'en'|'de'|..., azure?: { endpoint, apiKey, model }, force?: boolean }
 *
 * 行为：
 *   - lang === 'zh' → 直接返回原商品（zh 即原始语言）
 *   - 已缓存且未 force → 直接返回原商品
 *   - 否则调 Azure Responses API 翻译可本地化字段并落盘缓存
 */

const bodySchema = z.object({
  lang: z.string(),
  azure: z
    .object({
      endpoint: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional()
    })
    .optional(),
  force: z.boolean().optional()
});

type AzureCfg = { endpoint: string; apiKey: string; model: string };

function normalizeAzureEndpoint(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/openai\/responses$/i, '')
    .replace(/\/openai\/v1\/responses$/i, '')
    .replace(/\/openai\/deployments\/[^/]+\/responses$/i, '')
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '');
}

function resolveAzure(override?: { endpoint?: string; apiKey?: string; model?: string }): AzureCfg | null {
  const endpoint = normalizeAzureEndpoint(override?.endpoint || process.env.AZURE_OPENAI_ENDPOINT || '');
  const apiKey = (override?.apiKey || process.env.AZURE_OPENAI_API_KEY || '').trim();
  const model = (
    override?.model ||
    process.env.AZURE_OPENAI_DEPLOYMENT ||
    process.env.AZURE_OPENAI_MODEL ||
    'gpt-5.4'
  ).trim();
  if (!endpoint || !apiKey || !model) return null;
  return { endpoint, apiKey, model };
}

function extractResponseText(data: unknown): string {
  const root = data as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> } | undefined;
  if (typeof root?.output_text === 'string' && root.output_text.trim()) return root.output_text.trim();
  const parts: string[] = [];
  if (Array.isArray(root?.output)) {
    for (const item of root.output) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string') parts.push(part.text);
        }
      }
    }
  }
  return parts.join('\n').trim();
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    if (!isLangCode(body.lang)) {
      return NextResponse.json({ error: `不支持的语言：${body.lang}` }, { status: 400 });
    }
    const lang = body.lang as LangCode;

    const product = await getProduct(params.id);
    if (!product) return NextResponse.json({ error: '商品不存在' }, { status: 404 });

    // zh = 原始语言，无需调 LLM
    if (lang === 'zh') return NextResponse.json(product);

    // 已缓存且没强制刷新
    if (!body.force && product.localizations?.[lang]) {
      return NextResponse.json(product);
    }

    const cfg = resolveAzure(body.azure);
    if (!cfg) {
      return NextResponse.json(
        { error: '未配置 Azure（请在 设置 中填写 AZURE_OPENAI_ENDPOINT/API_KEY）' },
        { status: 400 }
      );
    }

    const targetLangName = SUPPORTED_LANGS.find((l) => l.code === lang)?.englishName ?? lang;

    const sourceFields = {
      title: product.title,
      series: product.series,
      categoryPath: product.categoryPath,
      gender: product.gender,
      colors: product.colors,
      sizes: product.sizes,
      materials: product.materials,
      targetAudience: product.targetAudience,
      descriptionBullets: product.descriptionBullets,
      attributes: product.attributes,
      stockText: product.stockText
    };

    const prompt = `You are a luxury-goods marketing translator. Translate the following Chinese product fields into ${targetLangName}.

Hard rules:
1. KEEP UNTRANSLATED: brand names (LV, Chanel, Dior, Gucci, Hermès, Prada, YSL, MCM, Burberry…), series names (Nano Diane, SAUMUR, Capucines, Book Tote, Classic Flap, etc.), model codes (M83566, AS3219), SKU codes, size codes (22x15x9cm, M, L, 38), and material trademarks (Monogram, Damier, Epi).
2. Preserve marketing tone, brevity, and bullet structure. Each bullet ≤ 30 ${targetLangName} chars/words.
3. If a field is empty, missing, or '价格待确认' / '商家待确认' / '未确认' / '未分类', leave as English placeholder ('Price TBD' / 'Merchant TBD' / 'Unspecified' / 'Uncategorized'), or empty array.
4. Return STRICT JSON only (no \`\`\` fences, no commentary). Same keys as input.

Input (Chinese):
${JSON.stringify(sourceFields, null, 2)}

Output (${targetLangName} JSON, same keys):`;

    const url = `${cfg.endpoint}/openai/v1/responses`;
    const response = await axios.post(
      url,
      {
        model: cfg.model,
        max_output_tokens: 1200,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
      },
      {
        timeout: 45_000,
        headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
        validateStatus: (s) => s >= 200 && s < 500
      }
    );

    if (response.status >= 400 || response.data?.error) {
      const detail = response.data?.error?.message ?? JSON.stringify(response.data).slice(0, 300);
      return NextResponse.json({ error: `Azure ${response.status}: ${detail}` }, { status: 502 });
    }

    const text = extractResponseText(response.data);
    if (!text) return NextResponse.json({ error: 'Azure 返回为空' }, { status: 502 });

    const cleaned = text.replace(/```json|```/g, '').trim();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return NextResponse.json({ error: `翻译结果不是合法 JSON：${cleaned.slice(0, 200)}` }, { status: 502 });
    }

    const asArray = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
    const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

    const localized: LocalizedFields = {
      title: asString(parsed.title),
      series: asString(parsed.series),
      categoryPath: asArray(parsed.categoryPath),
      gender: asString(parsed.gender),
      colors: asArray(parsed.colors),
      sizes: asArray(parsed.sizes),
      materials: asArray(parsed.materials),
      targetAudience: asString(parsed.targetAudience),
      descriptionBullets: asArray(parsed.descriptionBullets),
      attributes: asArray(parsed.attributes),
      stockText: asString(parsed.stockText)
    };

    const updated = await setProductLocalization(product.id, lang, localized);
    return NextResponse.json(updated);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '翻译失败' },
      { status: 400 }
    );
  }
}
