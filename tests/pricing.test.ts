import { describe, expect, it } from 'vitest';
import { calculatePrice, defaultPricingStrategy } from '@/lib/pricing/engine';

describe('pricing engine v2', () => {
  it('calculates tiered cost-plus with breakdown', () => {
    const result = calculatePrice(defaultPricingStrategy, {
      supplierCost: 68,
      weightGrams: 620,
      volumeCm3: 3000,
      qty: 50,
      region: 'US',
      customerSegment: 'NEW',
      qualityCode: 'A',
      packagingId: 'std',
      carrierServiceId: 'uk-royal:c-line'
    });

    expect(result.currency).toBe('CNY');
    expect(result.unitPrice).toBeGreaterThan(68);
    expect(result.marginPct).toBeGreaterThanOrEqual(0.2);
    expect(result.hitRules).toContain('tier:50+');
    expect(result.hitRules).toContain('carrier:uk-royal/c-line');
    expect(result.resolved.chargeableWeightKg).toBeGreaterThan(0);
    expect(result.breakdown.logistics).toBeGreaterThan(0);
    expect(result.breakdown.product).toBeGreaterThan(0);
  });

  it('applies quality multiplier on product cost', () => {
    const cheap = calculatePrice(defaultPricingStrategy, {
      supplierCost: 100,
      weightGrams: 500,
      qty: 10,
      qualityCode: 'A'
    });
    const premium = calculatePrice(defaultPricingStrategy, {
      supplierCost: 100,
      weightGrams: 500,
      qty: 10,
      qualityCode: 'AAA'
    });
    expect(premium.breakdown.product).toBeGreaterThan(cheap.breakdown.product);
  });

  it('does not negotiate below minimum margin', () => {
    const result = calculatePrice(defaultPricingStrategy, {
      supplierCost: 125,
      weightGrams: 180,
      qty: 1000,
      region: 'BR',
      customerSegment: 'VIP',
      negotiationRound: 3
    });

    expect(result.marginPct).toBeGreaterThanOrEqual(0.2);
    expect(result.hitRules).toContain('guardrail:min-margin');
  });
});
