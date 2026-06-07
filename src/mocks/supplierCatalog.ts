import type { ProductCatalogItem, ProductSyncStep, SupplierSource } from '@/lib/suppliers/base';

export const mockSupplierSources: SupplierSource[] = [
  {
    id: 'gxhyapp',
    name: '共享货源 gxhyapp',
    sourceType: '网站采集',
    websiteUrl: 'https://mall.gxhyapp.com',
    ingestionMode: '网站采集模式',
    connectionStatus: '已接入',
    syncMethods: ['手动同步', '定时同步'],
    productCount: 870,
    merchantCount: 35,
    lastSyncedAt: '今天 01:30',
    imageStrategy: '保存外链 URL，按需缓存主图'
  },
  {
    id: '90ii',
    name: '90ii 全球货源',
    sourceType: '网站采集',
    websiteUrl: 'https://www.90ii.net',
    ingestionMode: '网站采集模式',
    connectionStatus: '已接入',
    syncMethods: ['手动同步', '定时同步'],
    productCount: 0,
    merchantCount: 0,
    lastSyncedAt: '未同步',
    imageStrategy: '保存外链 URL，按需缓存主图'
  }
];

export const mockSyncPipelineSteps: ProductSyncStep[] = [
  {
    id: 'discover-links',
    title: '发现商品链接',
    count: 1280,
    description: '从商家页、系列页和搜索结果页识别可采集商品链接'
  },
  {
    id: 'fetch-details',
    title: '抓取详情页',
    count: 932,
    description: '抓取详情、价格、商家、规格和商品图片外链'
  },
  {
    id: 'extract-gallery',
    title: '提取规格/组图',
    count: 900,
    description: '提取尺寸、材质、颜色、型号和系列组图'
  },
  {
    id: 'normalize-category',
    title: '标准化分类',
    count: 870,
    description: '归一化品牌、系列、型号和多级分类'
  },
  {
    id: 'human-review',
    title: '待人工确认',
    count: 62,
    description: '低置信度字段进入人工确认队列'
  },
  {
    id: 'search-index',
    title: '已建立搜索索引',
    count: 870,
    description: '写入商品库后建立可供 AI 推荐检索的索引'
  }
];

export const mockProductCatalogItems: ProductCatalogItem[] = [
  {
    id: 'lv-saumur-bb-m46740',
    title: 'LV SAUMUR BB 老花拼皮革斜挎包',
    brand: 'LV',
    series: 'SAUMUR BB',
    model: 'M46740',
    categoryPath: ['箱包', '手袋', '斜挎包'],
    price: '¥18,900',
    merchant: '奢品优选档口 A12',
    galleryImageCount: 12,
    extractedAttributes: ['尺寸', '材质', '颜色'],
    sourceUrl: 'https://mall.gxhyapp.com/products/lv-saumur-bb-m46740',
    primaryImage: {
      id: 'lv-saumur-bb-primary',
      url: 'https://images.unsplash.com/photo-1594223274512-ad4803739b7c?w=900&auto=format&fit=crop',
      alt: 'LV SAUMUR BB 老花拼皮革斜挎包',
      isPrimary: true,
      cachePolicy: '主图按需缓存'
    }
  },
  {
    id: 'chanel-classic-flap-a01112',
    title: 'Chanel Classic Flap 羊皮链条包',
    brand: 'Chanel',
    series: 'Classic Flap',
    model: 'A01112',
    categoryPath: ['箱包', '手袋', '链条包'],
    price: '¥42,800',
    merchant: '港仓精品馆',
    galleryImageCount: 15,
    extractedAttributes: ['尺寸', '材质', '颜色'],
    sourceUrl: 'https://mall.gxhyapp.com/products/chanel-classic-flap-a01112',
    primaryImage: {
      id: 'chanel-classic-flap-primary',
      url: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=900&auto=format&fit=crop',
      alt: 'Chanel Classic Flap 羊皮链条包',
      isPrimary: true,
      cachePolicy: '主图按需缓存'
    }
  },
  {
    id: 'dior-book-tote-m1296',
    title: 'Dior Book Tote Oblique 刺绣托特包',
    brand: 'Dior',
    series: 'Book Tote',
    model: 'M1296',
    categoryPath: ['箱包', '托特包', '大号托特'],
    price: '¥24,500',
    merchant: '欧线现货集合店',
    galleryImageCount: 10,
    extractedAttributes: ['尺寸', '材质', '颜色'],
    sourceUrl: 'https://mall.gxhyapp.com/products/dior-book-tote-m1296',
    primaryImage: {
      id: 'dior-book-tote-primary',
      url: 'https://images.unsplash.com/photo-1614179689702-355944cd0918?w=900&auto=format&fit=crop',
      alt: 'Dior Book Tote Oblique 刺绣托特包',
      isPrimary: true,
      cachePolicy: '主图按需缓存'
    }
  }
];
