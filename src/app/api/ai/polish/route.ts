import { NextResponse } from 'next/server';
import { z } from 'zod';
import axios from 'axios';
import { isLangCode, SUPPORTED_LANGS, type LangCode } from '@/lib/i18n/languages';

/**
 * POST /api/ai/polish
 * 把「基础卖点文案」+「补充描述」合并成一段适合 WhatsApp 的销售话术。
 * - lang：目标语言（最终输出语言；中文以 zh 表示）
 * - audience：客户类型（决定语气和侧重，如批发/VIP/价格敏感/品质优先）
 * - base：商品营销卖点（来自 catalog 模板）
 * - extra：销售员临时补充（手写）
 *
 * 输出：单段连贯文案（保留 emoji 与 bullet），适合直接通过 WhatsApp 发送。
 */

const AUDIENCES: Record<string, { label: string; promptHint: string }> = {
  standard: {
    label: '标准客户',
    promptHint:
      'Tone: friendly, clear, professional. Highlight design, material, and practicality.'
  },
  wholesale: {
    label: '批发客户',
    promptHint:
      'Tone: concise, business-oriented. Emphasize stock availability, MOQ readiness, and consistent supply. Avoid retail fluff.'
  },
  vip: {
    label: 'VIP / 高净值',
    promptHint:
      'Tone: elegant, restrained, slightly aspirational. Emphasize craftsmanship, exclusivity, and brand heritage. Skip price-driven language.'
  },
  priceSensitive: {
    label: '价格敏感',
    promptHint:
      'Tone: warm and helpful. Lead with value-for-money, available sizes, and stock. Mention practical wearability over heritage.'
  },
  qualityFirst: {
    label: '品质优先',
    promptHint:
      'Tone: detail-oriented. Lead with material specifics, construction quality, durability, and care notes.'
  }
};

const bodySchema = z.object({
  base: z.string().default(''),
  extra: z.string().default(''),
  lang: z.string(),
  audience: z.string().default('standard'),
  azure: z
    .object({
      endpoint: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional()
    })
    .optional()
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

export async function POST(request: Request) {
  const started = Date.now();
  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    if (!isLangCode(body.lang)) {
      return NextResponse.json({ error: `不支持的语言：${body.lang}` }, { status: 400 });
    }
    const lang = body.lang as LangCode;
    const targetLangName = SUPPORTED_LANGS.find((l) => l.code === lang)?.englishName ?? lang;
    const aud = AUDIENCES[body.audience] ?? AUDIENCES.standard;

    const base = body.base.trim();
    const extra = body.extra.trim();
    if (!base && !extra) {
      return NextResponse.json({ error: '没有可润色的文案' }, { status: 400 });
    }

    const cfg = resolveAzure(body.azure);
    if (!cfg) {
      return NextResponse.json(
        { error: '未配置 AI：请先在「设置 → AI 模型」填写 Endpoint / API Key' },
        { status: 400 }
      );
    }

    const prompt = `You are a senior WhatsApp private-domain sales copywriter for luxury / fashion goods.
Task: rewrite the following product pitch into ONE polished WhatsApp message in ${targetLangName}.

Audience: ${aud.label}. ${aud.promptHint}

Hard rules:
1. Output language MUST be ${targetLangName}. Do not mix languages.
2. KEEP UNTRANSLATED: brand names (LV, Chanel, Dior, Gucci, Hermès, Prada, YSL, MCM, Burberry…), series names, model codes, SKU codes, size codes, material trademarks.
3. Merge the BASE selling points and the EXTRA notes naturally. Do NOT drop information that the seller explicitly wrote in EXTRA. You may reorder / re-summarize the BASE bullets, but never invent facts (no fabricated prices, no fabricated stock).
4. Keep WhatsApp friendly: short paragraphs, optional emoji at most 1-2 places, bullets allowed but ≤ 6 bullets, each bullet ≤ 30 ${targetLangName} chars/words.
5. Do NOT output anything except the final message text. No prefixes like "Here is", no JSON, no commentary, no quotes wrapping.

BASE (product selling points, may be empty):
"""
${base}
"""

EXTRA (seller's personal note, may be empty):
"""
${extra}
"""

Final WhatsApp message in ${targetLangName}:`;

    const url = `${cfg.endpoint}/openai/v1/responses`;
    const response = await axios.post(
      url,
      {
        model: cfg.model,
        max_output_tokens: 900,
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
      return NextResponse.json({ error: `AI ${response.status}: ${detail}` }, { status: 502 });
    }

    const text = extractResponseText(response.data).replace(/^["'\s]+|["'\s]+$/g, '');
    if (!text) return NextResponse.json({ error: 'AI 返回为空' }, { status: 502 });

    return NextResponse.json({
      polished: text,
      lang,
      audience: body.audience,
      elapsedMs: Date.now() - started,
      modelEcho: cfg.model
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '润色失败' },
      { status: 400 }
    );
  }
}
