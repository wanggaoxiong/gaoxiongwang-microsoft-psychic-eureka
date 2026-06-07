import { NextResponse } from 'next/server';
import { z } from 'zod';
import axios from 'axios';

/**
 * POST /api/ai/quick-replies
 * 输入：{ topic, lang?, count?, azure? }
 *  - topic：例如「回复客户砍价」「催客户付款」「介绍交期」
 *  - lang：目标语言（zh/en/...），默认 zh
 *  - count：候选数量，默认 6
 * 输出：{ items: string[] }
 *
 * 模型策略与 polish 一致：调 Azure OpenAI Responses API，要求严格输出
 * "每行一条" 的纯文本列表（不带编号），避免再二次清洗。
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  topic: z.string().min(1).max(200),
  lang: z.string().optional(),
  count: z.number().int().positive().max(20).optional(),
  azure: z
    .object({
      endpoint: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional()
    })
    .optional()
});

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

function resolveAzure(override?: { endpoint?: string; apiKey?: string; model?: string }) {
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
  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const lang = body.lang || 'zh';
    const count = body.count ?? 6;
    const cfg = resolveAzure(body.azure);
    if (!cfg) {
      return NextResponse.json(
        { error: '未配置 AI：请先在「设置 → AI 模型」填写 Endpoint / API Key' },
        { status: 400 }
      );
    }

    const prompt = `You are a senior WhatsApp B2B sales assistant.
Generate ${count} short, ready-to-send quick reply templates for the topic below, in language code "${lang}".

Hard rules:
1. Output language MUST match "${lang}". If lang=zh use 简体中文.
2. Each line is ONE standalone WhatsApp reply, no numbering, no quotes, no bullet markers.
3. Each reply ≤ 60 characters (CJK counted as 1 char).
4. Tone: friendly, professional, concise. Use at most 1 emoji per reply (optional).
5. Do NOT invent prices, dates, or specific product names. Use placeholders like {价格}/{交期}/{客户名} where useful.
6. Output ONLY the ${count} lines. No preamble, no explanation.

Topic: ${body.topic}`;

    const url = `${cfg.endpoint}/openai/v1/responses`;
    const response = await axios.post(
      url,
      {
        model: cfg.model,
        max_output_tokens: 800,
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

    const text = extractResponseText(response.data);
    const items = text
      .split(/\r?\n/)
      .map((s) => s.replace(/^\s*[\d]+[.、)]\s*/, '').replace(/^[-*•]\s*/, '').trim())
      .filter((s) => s.length > 0)
      .slice(0, count);

    if (items.length === 0) {
      return NextResponse.json({ error: 'AI 返回为空' }, { status: 502 });
    }

    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '生成失败' },
      { status: 400 }
    );
  }
}
