import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  listProducts,
  upsertProduct,
  deleteMany,
  type ListFilters
} from '@/lib/catalog/repo';
import { markPromoted } from '@/lib/sources/discovery';

const upsertSchema = z.object({
  source: z.string().min(1),
  sourceCode: z.string().min(1),
  sourceUrl: z.string().url(),
  mainImage: z.string(),
  galleryImages: z.array(z.string()).default([]),
  title: z.string(),
  brand: z.string().default(''),
  series: z.string().default(''),
  model: z.string().default(''),
  skuCode: z.string().optional(),
  categoryPath: z.array(z.string()).default([]),
  price: z.string().default(''),
  merchant: z.string().default(''),
  attributes: z.array(z.string()).default([]),
  gender: z.string().optional(),
  colors: z.array(z.string()).optional(),
  sizes: z.array(z.string()).optional(),
  materials: z.array(z.string()).optional(),
  targetAudience: z.string().optional(),
  descriptionBullets: z.array(z.string()).optional(),
  searchKeywords: z.array(z.string()).optional(),
  useCase: z.array(z.string()).optional(),
  bestForCustomerType: z.array(z.string()).optional(),
  currency: z.string().optional(),
  inStock: z.boolean().optional(),
  stockText: z.string().optional(),
  localizations: z.record(z.string(), z.any()).optional(),
  confidence: z.number().min(0).max(1).default(0),
  confidenceSource: z.enum(['llm', 'heuristic']).default('heuristic'),
  confidenceNotes: z.string().optional(),
  /** 如果是从发现池 promote 过来的，传上原记录 id，以便在 discovery store 里回填 catalogProductId / catalogAddedAt */
  discoveryId: z.string().optional()
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const filters: ListFilters = {
    q: url.searchParams.get('q') ?? undefined,
    brand: url.searchParams.get('brand') ?? undefined,
    source: url.searchParams.get('source') ?? undefined,
    minPrice: url.searchParams.get('minPrice')
      ? Number(url.searchParams.get('minPrice'))
      : undefined,
    maxPrice: url.searchParams.get('maxPrice')
      ? Number(url.searchParams.get('maxPrice'))
      : undefined,
    sort:
      (url.searchParams.get('sort') as 'newest' | 'price-asc' | 'price-desc' | null) ?? undefined
  };
  const result = await listProducts(filters);
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  try {
    const parsed = upsertSchema.parse(await request.json());
    const { discoveryId, ...body } = parsed;
    const created = await upsertProduct(body);
    if (discoveryId) {
      await markPromoted(discoveryId, created.id);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '参数错误' },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const ids = z.array(z.string()).parse(body?.ids ?? []);
    const removed = await deleteMany(ids);
    return NextResponse.json({ removed });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '参数错误' },
      { status: 400 }
    );
  }
}
