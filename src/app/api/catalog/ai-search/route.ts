import { NextResponse } from 'next/server';
import { z } from 'zod';
import axios from 'axios';
import { listProducts, type CatalogProduct } from '@/lib/catalog/repo';

/**
 * POST /api/catalog/ai-search
 * Body: { query: string, azure?: { endpoint, apiKey, model }, limit?: number }
 *
 * 行为：
 *   1) 拉全量 catalog → 每件商品压成一行可读摘要（id + 关键可检索字段）
 *   2) 让 LLM 基于 user query 输出 {ids: string[], reasoning: string}
 *   3) 与 catalog 实际 id 做交集去脏
 *
 * 设计权衡：
 *   - Catalog 量级不大（用户场景 < 几百件），单 prompt 全量塞入即可，无需 embedding
 *   - 控制 max_output_tokens 1200，足够返 ~50 个 id + 一段说明
 *   - 模型可单独配置（detail 在 src/lib/ai/config.ts 的 searchModelPreset）
 */

const bodySchema = z.object({
  query: z.string().min(1).max(500),
  azure: z
    .object({
      endpoint: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional()
    })
    .optional(),
  limit: z.number().int().min(1).max(100).optional()
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

function summarizeProduct(p: CatalogProduct): string {
  const parts = [
    `[${p.id}]`,
    p.brand && p.brand !== '未确认' ? p.brand : '',
    p.model || '',
    p.series || '',
    p.title,
    p.categoryPath?.length ? `分类:${p.categoryPath.join('/')}` : '',
    p.gender ? `性别:${p.gender}` : '',
    p.colors?.length ? `颜色:${p.colors.join(',')}` : '',
    p.materials?.length ? `材质:${p.materials.join(',')}` : '',
    p.sizes?.length ? `尺寸:${p.sizes.slice(0, 4).join(',')}` : '',
    p.targetAudience ? `场景:${p.targetAudience}` : '',
    p.price && p.price !== '价格待确认' ? `价格:${p.price}` : '',
    p.attributes?.length ? `属性:${p.attributes.slice(0, 5).join(',')}` : ''
  ].filter(Boolean);
  return parts.join(' | ');
}

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const limit = body.limit ?? 30;

    const cfg = resolveAzure(body.azure);
    if (!cfg) {
      return NextResponse.json(
        { error: '未配置 Azure（请在 设置 → AI 模型 中填写 Endpoint / API Key）' },
        { status: 400 }
      );
    }

    const { items } = await listProducts({});
    if (items.length === 0) {
      return NextResponse.json({ ids: [], reasoning: 'Catalog 为空', total: 0, elapsedMs: 0 });
    }

    const catalogLines = items.map(summarizeProduct).join('\n');
    const validIds = new Set(items.map((p) => p.id));

    const prompt = `You are a smart product search assistant for a luxury-goods catalog.
The catalog is provided as one line per product with format:
  [id] brand | model | series | title | 分类:... | 性别:... | 颜色:... | 材质:... | 尺寸:... | 场景:... | 价格:... | 属性:...

User query (Chinese or any language; interpret intent loosely — brand, model, gender, color, category, use-case, price band, occasion, etc.):
"""${body.query}"""

Task:
- Return at most ${limit} product ids that best match the query, ordered by relevance (best first).
- If the query mentions multiple constraints (e.g. "男士 黑色 乐福鞋"), require ALL to match strongly when possible; otherwise fall back to best partial match.
- If nothing matches, return an empty ids array and explain why in reasoning.
- The reasoning must be ≤ 60 Chinese chars, one sentence.

Output STRICT JSON only (no \`\`\` fences):
{"ids": ["...","..."], "reasoning": "..."}

Catalog (${items.length} items):
${catalogLines}`;

    const started = Date.now();
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
    let parsed: { ids?: unknown; reasoning?: unknown };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return NextResponse.json(
        { error: `AI 返回不是合法 JSON：${cleaned.slice(0, 200)}` },
        { status: 502 }
      );
    }

    const rawIds = Array.isArray(parsed.ids) ? parsed.ids : [];
    const ids = rawIds
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter((s) => validIds.has(s))
      .slice(0, limit);
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

    return NextResponse.json({
      ids,
      reasoning,
      total: items.length,
      matched: ids.length,
      modelEcho: cfg.model,
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'AI 检索失败' },
      { status: 400 }
    );
  }
}
