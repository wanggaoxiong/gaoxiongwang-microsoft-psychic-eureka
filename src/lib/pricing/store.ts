import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultPricingStrategy, pricingStrategySchema, type PricingStrategy } from './engine';

const STORE_PATH = path.join(process.cwd(), 'data', 'pricing-strategy.json');

let writeQueue: Promise<void> = Promise.resolve();

async function ensureFile(): Promise<void> {
  try {
    await fs.access(STORE_PATH);
  } catch {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.writeFile(STORE_PATH, JSON.stringify(defaultPricingStrategy, null, 2), 'utf-8');
  }
}

export async function loadPricingStrategy(): Promise<PricingStrategy> {
  await ensureFile();
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return pricingStrategySchema.parse(parsed);
  } catch {
    return pricingStrategySchema.parse(defaultPricingStrategy);
  }
}

export async function savePricingStrategy(next: PricingStrategy): Promise<PricingStrategy> {
  const safe = pricingStrategySchema.parse(next);
  writeQueue = writeQueue.then(async () => {
    await ensureFile();
    const tmp = `${STORE_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(safe, null, 2), 'utf-8');
    await fs.rename(tmp, STORE_PATH);
  });
  await writeQueue;
  return safe;
}
