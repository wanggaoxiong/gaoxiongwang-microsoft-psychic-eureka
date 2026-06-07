import axios from 'axios';
import type {
  SearchQuery,
  SessionHandle,
  SupplierConnector,
  SupplierProduct,
  SupplierProductDetail
} from '../base';
import { mockSupplierProducts } from '@/mocks/products';
import { scrapeGxhyappDetail } from './scraper';
import { normalizeToProductCard } from './normalizer';

const BASE_URL = 'http://mall.gxhyapp.com';

export class GxhyappConnector implements SupplierConnector {
  key = 'gxhyapp';

  async login(creds: Record<string, string>): Promise<SessionHandle> {
    if (!creds.username || !creds.password) {
      return { connectorKey: this.key };
    }

    return {
      connectorKey: this.key,
      token: Buffer.from(`${creds.username}:${Date.now()}`).toString('base64url')
    };
  }

  async search(query: SearchQuery, session: SessionHandle): Promise<SupplierProduct[]> {
    const text = query.text?.toLowerCase().trim();

    if (!session.token) {
      return this.searchMock(text, query.category);
    }

    try {
      await axios.get(BASE_URL, { timeout: 5000 });
    } catch {
      return this.searchMock(text, query.category);
    }

    return this.searchMock(text, query.category);
  }

  async detail(externalId: string, session: SessionHandle): Promise<SupplierProductDetail> {
    // externalId 可能是真实的 gxhyapp code（纯数字），也可能是 mock 的占位 id。
    if (/^\d{6,}$/.test(externalId)) {
      const raw = await scrapeGxhyappDetail({ code: externalId });
      const card = await normalizeToProductCard(raw);
      return {
        externalId,
        title: card.title,
        mainImage: card.mainImage,
        images: card.galleryImages,
        category: card.categoryPath.join(' / '),
        attrs: {
          brand: card.brand,
          series: card.series,
          model: card.model,
          merchant: card.merchant,
          extractedAttributes: card.extractedAttributes.join('、')
        },
        skus: [],
        minPrice: parsePriceToNumber(card.price),
        supplierShopName: card.merchant,
        sourceUrl: card.sourceUrl,
        description: raw.descriptionBlocks.slice(0, 3).join('\n'),
        rawJson: { card, descriptionBlocks: raw.descriptionBlocks.slice(0, 8) }
      };
    }

    const item = (await this.search({}, session)).find((product) => product.externalId === externalId);

    if (!item) {
      throw new Error(`gxhyapp product not found: ${externalId}`);
    }

    return {
      ...item,
      sourceUrl: `${BASE_URL}/#/goods/${externalId}`,
      description: '来自 gxhyapp 连接器的标准化商品详情。真实接口逆向后可替换当前 mock mapper。'
    };
  }

  private searchMock(text?: string, category?: string): SupplierProduct[] {
    return mockSupplierProducts.filter((product) => {
      const categoryMatched = !category || product.category?.toLowerCase() === category.toLowerCase();
      const normalizedText = normalizeKeyword(text);
      const textMatched =
        !normalizedText ||
        product.title.toLowerCase().includes(normalizedText) ||
        product.category?.toLowerCase().includes(normalizedText) ||
        Object.values(product.attrs).some((value) => value.toLowerCase().includes(normalizedText));

      return categoryMatched && textMatched;
    });
  }
}

export const gxhyappConnector = new GxhyappConnector();

function parsePriceToNumber(price: string): number {
  const m = price.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

function normalizeKeyword(text?: string) {
  if (!text) {
    return undefined;
  }

  const keyword = text.toLowerCase();
  const aliases: Record<string, string> = {
    bag: 'bags',
    bags: 'bags',
    shoe: 'shoes',
    shoes: 'shoes',
    watch: 'electronics',
    watches: 'electronics'
  };

  return aliases[keyword] ?? keyword;
}
