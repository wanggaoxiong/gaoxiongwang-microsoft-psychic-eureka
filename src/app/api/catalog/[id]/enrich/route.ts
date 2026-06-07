import { NextResponse } from 'next/server';
import { getProduct, patchProductMetadata } from '@/lib/catalog/repo';
import { callAzureResponses, resolveAzure } from '@/lib/ai/azure';

export const runtime = 'nodejs';

/**
 * POST /api/catalog/[id]/enrich
 * 用纯文本 AI 调用为已存在的商品补全 searchKeywords / useCase / bestForCustomerType。
 * 不重抓页面、不下图，速度快；用于批量回填。
 * Body: { azure?: { endpoint, apiKey, model } }
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      azure?: { endpoint?: string; apiKey?: string; model?: string };
    };
    const cfg = resolveAzure(body.azure);
    if (!cfg) {
      return NextResponse.json({ error: 'Azure 未配置' }, { status: 400 });
    }
    const product = await getProduct(params.id);
    if (!product) {
      return NextResponse.json({ error: '商品不存在' }, { status: 404 });
    }
    // 组合提示：只给文字信息，不下载图片
    const context = [
      `标题: ${product.title}`,
      product.brand ? `品牌: ${product.brand}` : '',
      product.series ? `系列: ${product.series}` : '',
      product.model ? `型号: ${product.model}` : '',
      product.categoryPath?.length ? `分类: ${product.categoryPath.join(' > ')}` : '',
      product.gender ? `性别: ${product.gender}` : '',
      product.colors?.length ? `颜色: ${product.colors.join(', ')}` : '',
      product.materials?.length ? `材质: ${product.materials.join(', ')}` : '',
      product.targetAudience ? `场景: ${product.targetAudience}` : '',
      product.descriptionBullets?.length
        ? `卖点:\n- ${product.descriptionBullets.join('\n- ')}`
        : ''
    ]
      .filter(Boolean)
      .join('\n');

    const prompt = `你是奢侈品 B2B 销售助手。根据下面商品信息，生成三组元数据，只返回严格 JSON（不要 \`\`\` 包裹）：

【商品信息】
${context}

【输出 JSON 结构】
{
  "searchKeywords": ["8-15 个中英混合短词，覆盖品牌别名/品类/工艺/客户可能搜索的词"],
  "useCase": ["2-4 个汉语场景词，如 通勤、商务出差、日常街拍、约会"],
  "bestForCustomerType": ["2-4 个汉语客户画像标签，如 白领女性、25-35、中端价位、礼品送人"]
}

要求：不要重复信息、不编造规格、保持简洁。`;

    const result = await callAzureResponses(cfg, prompt, {
      maxOutputTokens: 600,
      timeoutMs: 45_000
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    const text = result.text.trim();
    let parsed: {
      searchKeywords?: unknown;
      useCase?: unknown;
      bestForCustomerType?: unknown;
    } = {};
    try {
      // 容忍 AI 偶尔包裹 ``` 的情况
      const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (err) {
      return NextResponse.json(
        { error: `AI 返回非 JSON：${err instanceof Error ? err.message : String(err)}`, raw: text },
        { status: 502 }
      );
    }
    const asStringArr = (v: unknown, max: number) =>
      Array.isArray(v)
        ? (v.map((x) => String(x).trim()).filter(Boolean).slice(0, max) as string[])
        : undefined;
    const updated = await patchProductMetadata(params.id, {
      searchKeywords: asStringArr(parsed.searchKeywords, 20),
      useCase: asStringArr(parsed.useCase, 6),
      bestForCustomerType: asStringArr(parsed.bestForCustomerType, 6)
    });
    return NextResponse.json({ ok: true, product: updated });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
