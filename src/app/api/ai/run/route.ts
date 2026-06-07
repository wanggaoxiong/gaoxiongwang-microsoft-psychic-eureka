import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runAiSalesAssistant } from '@/lib/ai/orchestrator';

const schema = z.object({
  conversationId: z.string(),
  customerText: z.string().min(1),
  imageUrls: z.array(z.string().url()).optional(),
  aiMode: z.enum(['OFF', 'SUGGEST', 'AUTO']).optional()
});

export async function POST(request: Request) {
  const input = schema.parse(await request.json());
  const result = await runAiSalesAssistant(input);

  return NextResponse.json(result);
}
