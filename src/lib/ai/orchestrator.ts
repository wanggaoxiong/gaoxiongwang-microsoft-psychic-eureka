import { calculatePrice } from '@/lib/pricing/engine';
import { loadPricingStrategy } from '@/lib/pricing/store';
import { findSimilarShipments, type Shipment } from '@/lib/shipments/store';
import { getSupplierConnector } from '@/lib/suppliers';
import type { SupplierProduct } from '@/lib/suppliers/base';

export type AiRunInput = {
  conversationId: string;
  customerText: string;
  imageUrls?: string[];
  aiMode?: 'OFF' | 'SUGGEST' | 'AUTO';
};

export type AiRecommendation = {
  product: SupplierProduct;
  score: number;
  customerImages: string[];
  quote: ReturnType<typeof calculatePrice>;
  /** 相似历史发货：同国家 / 同线路 / 接近重量的真实票据，作为报价依据 */
  similarShipments?: Array<Pick<Shipment, 'id' | 'date' | 'country' | 'service' | 'chargeableWeightKg' | 'pricePerKg' | 'totalAmount' | 'itemDescription'>>;
};

export type AiRunResult = {
  detectedNeed: {
    category?: string;
    keywords: string[];
    missingQuestions: string[];
  };
  recommendations: AiRecommendation[];
  suggestedReply: string;
};

export async function runAiSalesAssistant(input: AiRunInput): Promise<AiRunResult> {
  const detectedNeed = detectNeed(input.customerText);
  const connector = getSupplierConnector('gxhyapp');
  const session = await connector.login({
    username: process.env.GXHYAPP_USERNAME ?? '',
    password: process.env.GXHYAPP_PASSWORD ?? ''
  });

  const products = await connector.search(
    { text: detectedNeed.keywords[0], category: detectedNeed.category, page: 1 },
    session
  );

  const strategy = await loadPricingStrategy();

  const recommendations = await Promise.all(
    products.slice(0, 3).map(async (product, index) => {
      const quote = calculatePrice(strategy, {
        supplierCost: product.minPrice,
        weightGrams: product.weightGrams,
        qty: 10,
        region: 'US',
        customerSegment: 'NEW'
      });

      // 拉同国家 / 相近重量的真实历史票，给 AI 一个真实价格锚点
      const similar = await findSimilarShipments({
        country: 'US',
        weightKg: (product.weightGrams ?? 0) / 1000,
        keyword: detectedNeed.keywords[0],
        limit: 3
      });

      return {
        product,
        score: 0.92 - index * 0.08,
        customerImages: product.images.slice(0, 6),
        quote,
        similarShipments: similar.map((s) => ({
          id: s.id,
          date: s.date,
          country: s.country,
          service: s.service,
          chargeableWeightKg: s.chargeableWeightKg,
          pricePerKg: s.pricePerKg,
          totalAmount: s.totalAmount,
          itemDescription: s.itemDescription
        }))
      };
    })
  );

  const suggestedReply = buildSuggestedReply(detectedNeed, recommendations);

  return {
    detectedNeed,
    recommendations,
    suggestedReply
  };
}

function detectNeed(text: string) {
  const lower = text.toLowerCase();
  const category = lower.includes('shoe') || lower.includes('鞋')
    ? 'shoes'
    : lower.includes('watch') || lower.includes('手表')
      ? 'electronics'
      : lower.includes('bag') || lower.includes('包')
        ? 'bags'
        : undefined;

  const keywords = [
    category === 'shoes' ? 'shoe' : category === 'electronics' ? 'watch' : category === 'bags' ? 'bag' : text
  ].filter(Boolean);

  return {
    category,
    keywords,
    missingQuestions: ['目标数量是多少？', '希望发往哪个国家？', '是否有目标价或预算？']
  };
}

function buildSuggestedReply(need: AiRunResult['detectedNeed'], recommendations: AiRecommendation[]) {
  if (recommendations.length === 0) {
    return `我先确认一下需求：${need.missingQuestions.join(' ')} 我会根据你的描述继续找更接近的款。`;
  }

  const first = recommendations[0];
  return [
    `我先给你挑了 ${recommendations.length} 组接近需求的款式。`,
    `第一组是 ${first.product.title}，10 件试单参考价约 ${first.quote.unitPrice} ${first.quote.currency}/件。`,
    '如果你要更低价位、不同颜色或更接近参考图的款，我可以继续换一组。'
  ].join(' ');
}
