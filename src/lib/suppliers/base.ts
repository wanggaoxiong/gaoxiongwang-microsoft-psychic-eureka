import { z } from 'zod';

export const searchQuerySchema = z.object({
  text: z.string().optional(),
  imageUrl: z.string().url().optional(),
  category: z.string().optional(),
  priceRange: z.tuple([z.number(), z.number()]).optional(),
  page: z.number().int().positive().optional()
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

export type SessionHandle = {
  connectorKey: string;
  token?: string;
  cookies?: string;
};

export type SupplierSku = {
  id: string;
  price: number;
  stock: number;
  attrs: Record<string, string>;
};

export type SupplierProduct = {
  externalId: string;
  title: string;
  mainImage: string;
  images: string[];
  category?: string;
  attrs: Record<string, string>;
  skus: SupplierSku[];
  minPrice: number;
  weightGrams?: number;
  supplierShopName?: string;
  rawJson?: unknown;
};

export type SupplierProductDetail = SupplierProduct & {
  description?: string;
  sourceUrl?: string;
};

export type SupplierSource = {
  id: string;
  name: string;
  sourceType: '网站采集';
  websiteUrl: string;
  ingestionMode: '网站采集模式';
  connectionStatus: '已接入';
  syncMethods: string[];
  productCount: number;
  merchantCount: number;
  lastSyncedAt: string;
  imageStrategy: string;
};

export type ProductImage = {
  id: string;
  url: string;
  alt: string;
  isPrimary?: boolean;
  cachePolicy: '保存外链 URL' | '主图按需缓存';
};

export type ProductCatalogItem = {
  id: string;
  title: string;
  brand: string;
  series: string;
  model: string;
  categoryPath: string[];
  price: string;
  merchant: string;
  galleryImageCount: number;
  extractedAttributes: string[];
  sourceUrl: string;
  primaryImage: ProductImage;
};

export type ProductSyncStep = {
  id: string;
  title: string;
  count: number;
  description: string;
};

export type OrderItem = {
  skuId: string;
  quantity: number;
};

export type Shipping = {
  name: string;
  phone: string;
  country: string;
  address1: string;
  address2?: string;
  city?: string;
  postalCode?: string;
};

export type TrackingInfo = {
  carrier: string;
  trackingNo: string;
  status: string;
  events: Array<{ time: string; text: string }>;
};

export interface SupplierConnector {
  key: string;
  login(creds: Record<string, string>): Promise<SessionHandle>;
  search(query: SearchQuery, session: SessionHandle): Promise<SupplierProduct[]>;
  detail(externalId: string, session: SessionHandle): Promise<SupplierProductDetail>;
  placeOrder?(
    items: OrderItem[],
    shipping: Shipping,
    session: SessionHandle
  ): Promise<{ externalOrderId: string }>;
  trackOrder?(externalOrderId: string, session: SessionHandle): Promise<TrackingInfo>;
}
