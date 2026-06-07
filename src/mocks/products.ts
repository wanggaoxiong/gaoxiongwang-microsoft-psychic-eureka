import type { SupplierProduct } from '@/lib/suppliers/base';

export const mockSupplierProducts: SupplierProduct[] = [
  {
    externalId: 'gx-bag-001',
    title: '轻奢链条斜挎包 多色可选',
    mainImage: 'https://images.unsplash.com/photo-1590874103328-eac38a683ce7?w=900&auto=format&fit=crop',
    images: [
      'https://images.unsplash.com/photo-1590874103328-eac38a683ce7?w=900&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=900&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=900&auto=format&fit=crop'
    ],
    category: 'bags',
    attrs: { material: 'PU', colors: 'black, white, brown', style: 'crossbody' },
    skus: [
      { id: 'black', price: 68, stock: 500, attrs: { color: 'black' } },
      { id: 'brown', price: 68, stock: 320, attrs: { color: 'brown' } }
    ],
    minPrice: 68,
    weightGrams: 620,
    supplierShopName: 'gxhyapp-demo'
  },
  {
    externalId: 'gx-shoe-001',
    title: '女士厚底运动休闲鞋 透气网面',
    mainImage: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=900&auto=format&fit=crop',
    images: [
      'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=900&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1460353581641-37baddab0fa2?w=900&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1560769629-975ec94e6a86?w=900&auto=format&fit=crop'
    ],
    category: 'shoes',
    attrs: { upper: 'mesh', sizes: '35-40', style: 'sport casual' },
    skus: [
      { id: 'white-38', price: 82, stock: 210, attrs: { color: 'white', size: '38' } },
      { id: 'black-39', price: 82, stock: 180, attrs: { color: 'black', size: '39' } }
    ],
    minPrice: 82,
    weightGrams: 850,
    supplierShopName: 'gxhyapp-demo'
  },
  {
    externalId: 'gx-watch-001',
    title: '智能手表 蓝牙通话 多运动模式',
    mainImage: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=900&auto=format&fit=crop',
    images: [
      'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=900&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?w=900&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1434493789847-2f02dc6ca35d?w=900&auto=format&fit=crop'
    ],
    category: 'electronics',
    attrs: { battery: '7 days', waterproof: 'IP68', language: 'multi-language' },
    skus: [
      { id: 'black', price: 125, stock: 90, attrs: { color: 'black' } },
      { id: 'silver', price: 132, stock: 60, attrs: { color: 'silver' } }
    ],
    minPrice: 125,
    weightGrams: 180,
    supplierShopName: 'gxhyapp-demo'
  }
];
