import { NextResponse } from 'next/server';
import { z } from 'zod';
import axios from 'axios';
import { SUPPORTED_LANGS, isLangCode } from '@/lib/i18n/languages';

/**
 * POST /api/ai/translate-quick-replies
 * 把若干条中文（或任意语言）快捷话术翻译到目标语言。
 *
 * 输入：{ texts: string[], lang: LangCode, azure? }
 * 输出：{ items: string[] }（与 texts 长度 / 顺序一一对应；翻译失败时回退原文）
 *
 * 策略：一次性把所有条目按 "\n---\n" 拼成 prompt 让模型整体翻译，
 * 节省调用次数；返回时按相同分隔符拆。
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  texts: z.array(z.string().min(1)).min(1).max(50),
  lang: z.string().refine(isLangCode, '不支持的语言'),
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

const SEP = '\n@@@SPLIT@@@\n';

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const langMeta = SUPPORTED_LANGS.find((l) => l.code === body.lang)!;
    const cfg = resolveAzure(body.azure);
    if (!cfg) {
      return NextResponse.json(
        { error: '未配置 AI：请先在「设置 → AI 模型」填写 Endpoint / API Key' },
        { status: 400 }
      );
    }

    const joined = body.texts.join(SEP);
    const prompt = `Translate the following WhatsApp quick-reply templates to ${langMeta.englishName}.

Hard rules:
1. Preserve the order strictly. Keep the exact separator "@@@SPLIT@@@" between items.
2. Translate ONE item per segment. Do NOT merge or split items.
3. Keep meaning, tone (friendly / concise), and any emojis or placeholders like {价格}/{交期}/{客户名} intact (translate the placeholder names too if natural).
4. Output ONLY the translated segments joined by "@@@SPLIT@@@". No preamble, no numbering, no markdown.
5. Each translated line ≤ 80 characters.

Items:
${joined}`;

    const url = `${cfg.endpoint}/openai/v1/responses`;
    const response = await axios.post(
      url,
      {
        model: cfg.model,
        max_output_tokens: 1500,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
      },
      {
        timeout: 60_000,
        headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
        validateStatus: (s) => s >= 200 && s < 500
      }
    );

    if (response.status >= 400 || response.data?.error) {
      const detail = response.data?.error?.message ?? JSON.stringify(response.data).slice(0, 300);
      return NextResponse.json({ error: `AI ${response.status}: ${detail}` }, { status: 502 });
    }

    const text = extractResponseText(response.data);
    const parts = text
      .split(/@@@SPLIT@@@/g)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // 长度对齐失败时退化为原文，避免错位
    const items =
      parts.length === body.texts.length ? parts : body.texts.map((t, i) => parts[i] ?? t);

    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '翻译失败' },
      { status: 400 }
    );
  }
}
