/**
 * 90ii.net connector — 纯 SSR 站点，HTTP GET + cheerio 解析。
 * 站点结构：
 *   首页 https://www.90ii.net/                → 列出 ~180 个分类卡片
 *   分类 https://www.90ii.net/categories/<id> → 每页 ~20 个商品卡片
 *   详情 https://www.90ii.net/products/<id>
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import type {
  SearchQuery,
  SessionHandle,
  SupplierConnector,
  SupplierProduct,
  SupplierProductDetail
} from '../base';

const BASE_URL = 'https://www.90ii.net';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class NinetyIiConnector implements SupplierConnector {
  key = '90ii';

  async login(): Promise<SessionHandle> {
    return { connectorKey: this.key };
  }

  async search(_query: SearchQuery, _session: SessionHandle): Promise<SupplierProduct[]> {
    // discover 走 crawler，这里只在直接 search 时被调用，暂返回空
    return [];
  }

  async detail(externalId: string, _session: SessionHandle): Promise<SupplierProductDetail> {
    const url = `${BASE_URL}/products/${encodeURIComponent(externalId)}`;
    const { data: html } = await axios.get<string>(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      timeout: 15000,
      responseType: 'text'
    });
    const $ = cheerio.load(html);

    const title =
      $('h1.product-name').first().text().trim() ||
      $('.product-name').first().text().trim() ||
      $('meta[property="og:title"]').attr('content')?.trim() ||
      '';
    const mainImage =
      $('meta[property="og:image"]').attr('content')?.trim() ||
      $('.product-image img').first().attr('data-src') ||
      $('.product-image img').first().attr('src') ||
      '';
    const gallery: string[] = [];
    $('img').each((_, el) => {
      const src = $(el).attr('data-src') || $(el).attr('src') || '';
      if (src && !src.startsWith('data:') && !src.includes('placeholder') && /\.(jpe?g|png|webp)/i.test(src)) {
        gallery.push(src);
      }
    });
    const priceText = $('.product-price, .price, [class*="price"]').first().text().trim();
    const priceNum = parsePriceToNumber(priceText);
    const description = $('.product-description, #description').first().text().trim().slice(0, 1000);

    return {
      externalId,
      title: title || `90ii product ${externalId}`,
      mainImage,
      images: dedupe(gallery).slice(0, 20),
      attrs: {},
      skus: [],
      minPrice: priceNum,
      sourceUrl: url,
      description: description || undefined,
      rawJson: { priceText }
    };
  }
}

export const ninetyIiConnector = new NinetyIiConnector();

function parsePriceToNumber(text: string): number {
  const m = text.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return 0;
  return Number(m[1].replace(',', '.'));
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
