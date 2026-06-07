import 'server-only';
import axios from 'axios';
import { listProducts, type CatalogProduct } from './repo';
import { resolveAzure, extractResponseText, type AzureCfg } from '@/lib/ai/azure';

/**
 * 以图搜图共享内核：被 /api/catalog/ai-search-image 和 lib/ai/auto-respond 复用。
 * 走 Azure Responses API + input_image：让视觉模型看一张图，吐出 {description, keywords[]}，
 * 再把关键词喂回 catalog 排序。
 *
 * 选型理由（不用 image-embedding）：
 *   - 当前 catalog 没存任何 embedding，全库重建+维护成本高
 *   - 用户量级 < 几百件商品，关键词召回已足够
 *   - 多模态可以拿到人类可读的"我看到一只棕色帆布手提包"做审计
 */

export type ImageSearchResult = {
  ids: string[];
  keywords: string[];
  description: string;
  total: number;
  matched: number;
  elapsedMs: number;
};

function normalizeTokens(s: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[【】《》（）()\[\]{}<>"'`!?！？。，,.;:、|/\\\-_]+/g, ' ')
    .split(/\s+/)
    .filter((x) => x && x.length >= 1)
    .slice(0, 32);
}

function productSearchable(p: CatalogProduct): string {
  return [
    p.brand,
    p.model,
    p.series,
    p.title,
    p.categoryPath?.join(' '),
    p.gender,
    p.colors?.join(' '),
    p.materials?.join(' '),
    p.targetAudience,
    p.attributes?.join(' ')
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function scoreProduct(p: CatalogProduct, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const text = productSearchable(p);
  let score = 0;
  for (const t of tokens) {
    if (!t) continue;
    if (text.includes(t)) score += 1;
  }
  return score;
}

export async function searchCatalogByImage(opts: {
  /** 公网可访问 URL */
  imageUrl?: string;
  /** data:image/...;base64,xxx */
  imageDataUrl?: string;
  /** 文字提示，附加给视觉模型 */
  hint?: string;
  /** 返回上限 */
  limit?: number;
  /** Azure 覆盖配置；不传则用环境变量 */
  azure?: { endpoint?: string; apiKey?: string; model?: string };
}): Promise<
  | { ok: true; result: ImageSearchResult }
  | { ok: false; status: number; error: string }
> {
  const limit = opts.limit ?? 12;
  if (!opts.imageUrl && !opts.imageDataUrl) {
    return { ok: false, status: 400, error: '必须提供 imageUrl 或 imageDataUrl 之一' };
  }
  const cfg: AzureCfg | null = resolveAzure(opts.azure);
  if (!cfg) {
    return { ok: false, status: 400, error: '未配置 Azure' };
  }

  const { items } = await listProducts({});
  if (items.length === 0) {
    return {
      ok: true,
      result: { ids: [], keywords: [], description: '', total: 0, matched: 0, elapsedMs: 0 }
    };
  }

  const visionInstruction = `You are a product image analyzer for a luxury-goods reseller catalog.

Look at the image and return STRICT JSON only:
{
  "description": "1 句话描述（≤ 30 字，中文）",
  "keywords": ["8 个最有区分度的检索词，覆盖：品类 / 子品类 / 颜色 / 材质 / 风格 / 性别 / 场景 / 形态。词要短，不要带「这是」「一个」等冗余字。"]
}

${opts.hint ? `User hint: ${opts.hint}\n` : ''}If the image is clearly not a product (人物自拍 / 风景 / 文档), return {"description":"非商品图","keywords":[]}.`;

  const imagePart: Record<string, unknown> = opts.imageDataUrl
    ? { type: 'input_image', image_url: opts.imageDataUrl }
    : { type: 'input_image', image_url: opts.imageUrl };

  const started = Date.now();
  const url = `${cfg.endpoint}/openai/v1/responses`;

  try {
    const response = await axios.post(
      url,
      {
        model: cfg.model,
        max_output_tokens: 400,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: visionInstruction }, imagePart]
          }
        ]
      },
      {
        timeout: 60_000,
        headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
        validateStatus: (s) => s >= 200 && s < 500
      }
    );

    if (response.status >= 400 || response.data?.error) {
      const detail = response.data?.error?.message ?? JSON.stringify(response.data).slice(0, 300);
      return { ok: false, status: 502, error: `Azure ${response.status}: ${detail}` };
    }

    const text = extractResponseText(response.data);
    if (!text) return { ok: false, status: 502, error: 'Azure 返回为空' };

    const cleaned = text.replace(/```json|```/g, '').trim();
    let parsed: { description?: unknown; keywords?: unknown };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return { ok: false, status: 502, error: `视觉模型返回非 JSON：${cleaned.slice(0, 200)}` };
    }

    const description = typeof parsed.description === 'string' ? parsed.description : '';
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords
          .filter((x): x is string => typeof x === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    if (keywords.length === 0) {
      return {
        ok: true,
        result: {
          ids: [],
          keywords,
          description,
          total: items.length,
          matched: 0,
          elapsedMs: Date.now() - started
        }
      };
    }

    const tokens = keywords.flatMap(normalizeTokens);
    const ranked = items
      .map((p) => ({ p, s: scoreProduct(p, tokens) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.p.updatedAt.localeCompare(a.p.updatedAt))
      .slice(0, limit);

    return {
      ok: true,
      result: {
        ids: ranked.map((x) => x.p.id),
        keywords,
        description,
        total: items.length,
        matched: ranked.length,
        elapsedMs: Date.now() - started
      }
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : '以图搜图失败'
    };
  }
}
