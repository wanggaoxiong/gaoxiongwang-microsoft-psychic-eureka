import { NextResponse } from 'next/server';
import { z } from 'zod';
import { callAzureResponses, resolveAzure } from '@/lib/ai/azure';
import { SUPPORTED_LANGS } from '@/lib/i18n/languages';

/**
 * POST /api/ai/translate
 * 输入：{ text, lang, azure }
 * 输出：{ text: string, lang: string }
 *
 * 用法：发送前把任意语言的输入翻译到对端「冻结语言」。
 * - 已经是目标语言：服务端不二次翻（实际仍调一遍 AI，但用 prompt 让它在确认是同语言时原样回吐）。
 * - 翻译失败：调用方应回退为原文发出，由 UI 给出非阻塞提示。
 */
export const dynamic = 'force-dynamic';

const schema = z.object({
  text: z.string().min(1).max(4000),
  lang: z.string().min(2),
  azure: z
    .object({
      endpoint: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional()
    })
    .optional()
});

function langLabel(code: string): string {
  return SUPPORTED_LANGS.find((l) => l.code === code)?.englishName ?? code;
}

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json().catch(() => ({})));
    const cfg = resolveAzure(body.azure);
    if (!cfg) {
      return NextResponse.json(
        { error: '未配置 AI：请先在「设置 → AI 模型」填写 Endpoint / API Key' },
        { status: 400 }
      );
    }

    const prompt = `You are a professional WhatsApp B2B sales translator.
Translate the following message to ${langLabel(body.lang)} (code: ${body.lang}).

Hard rules:
1. Preserve the meaning, tone, emojis, line breaks, numbers, URLs, @mentions, and any placeholders like {价格} / {交期} VERBATIM.
2. If the source is already in the target language, return it unchanged.
3. Output ONLY the translated text. No quotes, no preamble, no explanation, no notes.
4. Keep it natural and concise — this will be sent as-is into a WhatsApp chat with a real customer.
5. If lang=zh use 简体中文.

Source:
${body.text}`;

    const result = await callAzureResponses(cfg, prompt, { maxOutputTokens: 600 });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    // 简单去掉模型偶尔自带的「" "」/「```」
    const text = result.text
      .replace(/^```[\w-]*\s*/m, '')
      .replace(/\s*```$/m, '')
      .replace(/^["「『]/, '')
      .replace(/["」』]$/, '')
      .trim();
    return NextResponse.json({ text, lang: body.lang });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '翻译失败' },
      { status: 400 }
    );
  }
}
