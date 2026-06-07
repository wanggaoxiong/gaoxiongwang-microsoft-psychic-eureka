import { z } from 'zod';

/**
 * 报价策略 v2：
 * 一个报价由若干部分组合而成：
 *   - 商品成本（supplierCost × 质量分级系数）
 *   - 包装成本（可选包装方案，带额外重量 / 体积）
 *   - 物流成本（按承运商 + 服务等级 + 地区，计费重量 = max(实重, 体积重)）
 *   - 关税、汇率缓冲
 *   - 利润加成（按数量阶梯 / 地区 / 客户分层）
 * 输出含完整 breakdown，便于 UI 与 AI 在话术里说明定价依据。
 */

export const qualityGradeSchema = z.object({
  /** 编码，如 A / AAA / OEM */
  code: z.string().min(1),
  name: z.string().min(1),
  /** 在 supplierCost 之上的倍数。1 = 原价，1.2 = 加价 20% 反映质量更好 */
  costMultiplier: z.number().positive().default(1),
  notes: z.string().optional()
});
export type QualityGrade = z.infer<typeof qualityGradeSchema>;

export const packagingOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 单件包装成本（与策略 currency 同币种） */
  cost: z.number().min(0).default(0),
  /** 包装后增加的重量（克） */
  addWeightGrams: z.number().min(0).default(0),
  /** 包装后增加的体积（立方厘米），用于体积重 */
  addVolumeCm3: z.number().min(0).default(0),
  notes: z.string().optional()
});
export type PackagingOption = z.infer<typeof packagingOptionSchema>;

export const carrierServiceSchema = z.object({
  id: z.string().min(1),
  /** 服务名，如 "DHL Express" / "邮政小包" / "海运拼柜" */
  name: z.string().min(1),
  /** 时效说明，自由文本，如 "3-5 工作日" */
  speedDays: z.string().default(''),
  /** 适用地区 ISO 国家码列表；空数组 = 全球 */
  regions: z.array(z.string()).default([]),
  /** 每公斤运费（策略 currency） */
  pricePerKg: z.number().min(0).default(0),
  /** 固定基础费 */
  baseFee: z.number().min(0).default(0),
  /** 体积重除数（cm³/kg），默认 5000；越小越对体积敏感 */
  volumetricDivisor: z.number().positive().default(5000),
  /** 最低计费重量（kg） */
  minChargeKg: z.number().min(0).default(0),
  notes: z.string().optional()
});
export type CarrierService = z.infer<typeof carrierServiceSchema>;

export const carrierSchema = z.object({
  id: z.string().min(1),
  /** 承运商品牌，如 DHL / FedEx / 邮政 / 顺丰国际 */
  name: z.string().min(1),
  services: z.array(carrierServiceSchema).default([])
});
export type Carrier = z.infer<typeof carrierSchema>;

export const pricingStrategySchema = z.object({
  name: z.string(),
  /** 策略唯一 id（多策略集里用于选择/引用）；单策略文件可不带。 */
  id: z.string().optional(),
  /** 适用条件：销售/AI 按会话上下文自动匹配对应策略。全空 = 通用兜底。 */
  appliesWhen: z
    .object({
      /** 客户分层，如 NEW / VIP / WHOLESALE */
      customerSegments: z.array(z.string()).default([]),
      /** 适用地区 ISO 国家码 */
      regions: z.array(z.string()).default([]),
      /** 适用品牌（小写匹配） */
      brands: z.array(z.string()).default([]),
      /** 最低数量门槛（达到才适用，用于批发策略） */
      minQty: z.number().int().positive().optional()
    })
    .optional(),
  currency: z.string().default('USD'),
  guardrails: z.object({
    minMarginPct: z.number().min(0).max(95).default(20),
    minUnitPrice: z.number().min(0).default(0),
    maxDiscountPct: z.number().min(0).max(95).default(15)
  }),
  /** 商品级别的基础公式（关税、汇率缓冲、默认利润） */
  baseFormula: z.object({
    supplierCostFactor: z.number().positive().default(1),
    dutyPct: z.number().min(0).max(1).default(0),
    fxBufferPct: z.number().min(0).max(1).default(0),
    marginPct: z.number().min(0).max(0.95).default(0.35)
  }),
  /** 质量分级（A / AAA / OEM…），可空 */
  qualityGrades: z.array(qualityGradeSchema).default([]),
  /** 可选包装方案 */
  packagingOptions: z.array(packagingOptionSchema).default([]),
  /** 承运商列表（每个承运商 1..n 个服务等级） */
  carriers: z.array(carrierSchema).default([]),
  /** 按数量阶梯调整 marginPct */
  tiers: z
    .array(z.object({ minQty: z.number().int().positive(), marginPct: z.number().min(0).max(0.95) }))
    .default([]),
  regionAdjust: z
    .record(z.object({ marginPctDelta: z.number(), minMarginPct: z.number().optional() }))
    .default({}),
  customerSegmentAdjust: z.record(z.object({ marginPctDelta: z.number() })).default({}),
  negotiation: z
    .object({
      maxRoundsToConcede: z.number().int().min(0).default(0),
      stepDiscountPct: z.array(z.number().min(0).max(95)).default([])
    })
    .optional()
});
export type PricingStrategy = z.infer<typeof pricingStrategySchema>;

export type PriceInput = {
  /** 单件原始供货价（策略 currency 已经统一时这是同币种数字） */
  supplierCost: number;
  /** 商品净重（克），用来算物流计费重量 */
  weightGrams?: number;
  /** 商品体积（立方厘米），用来算物流体积重 */
  volumeCm3?: number;
  qty: number;
  region?: string;
  customerSegment?: string;
  negotiationRound?: number;
  /** 选定的质量分级 code */
  qualityCode?: string;
  /** 选定的包装方案 id */
  packagingId?: string;
  /** 选定的物流服务 id，格式 `${carrierId}:${serviceId}` 或纯 serviceId */
  carrierServiceId?: string;
};

export type PriceBreakdown = {
  /** supplierCost × supplierCostFactor × qualityMultiplier */
  product: number;
  packaging: number;
  logistics: number;
  duty: number;
  fxBuffer: number;
  /** 利润绝对值 = unitPrice − totalCost */
  margin: number;
  totalCost: number;
};

export type PriceResult = {
  currency: string;
  breakdown: PriceBreakdown;
  unitPrice: number;
  total: number;
  marginPct: number;
  hitRules: string[];
  resolved: {
    quality?: QualityGrade;
    packaging?: PackagingOption;
    carrier?: Carrier;
    carrierService?: CarrierService;
    /** 物流计费重量 kg */
    chargeableWeightKg?: number;
  };
};

function findCarrierService(
  strategy: PricingStrategy,
  id?: string
): { carrier: Carrier; service: CarrierService } | undefined {
  if (!id) return undefined;
  const [carrierId, serviceId] = id.includes(':') ? id.split(':', 2) : [undefined, id];
  for (const c of strategy.carriers) {
    if (carrierId && c.id !== carrierId) continue;
    const s = c.services.find((sv) => sv.id === serviceId);
    if (s) return { carrier: c, service: s };
  }
  return undefined;
}

export function calculateLogistics(
  service: CarrierService,
  weightGrams: number,
  volumeCm3: number
): { cost: number; chargeableWeightKg: number } {
  const actualKg = weightGrams / 1000;
  const volumetricKg = service.volumetricDivisor > 0 ? volumeCm3 / service.volumetricDivisor : 0;
  const chargeable = Math.max(actualKg, volumetricKg, service.minChargeKg ?? 0);
  const cost = service.baseFee + chargeable * service.pricePerKg;
  return { cost: roundMoney(cost), chargeableWeightKg: roundWeight(chargeable) };
}

export function calculatePrice(strategyInput: PricingStrategy, input: PriceInput): PriceResult {
  const strategy = pricingStrategySchema.parse(strategyInput);
  const hitRules: string[] = [];

  // 1) 质量分级
  const quality =
    input.qualityCode != null
      ? strategy.qualityGrades.find((q) => q.code === input.qualityCode)
      : undefined;
  if (quality) hitRules.push(`quality:${quality.code}`);

  // 2) 包装
  const packaging =
    input.packagingId != null
      ? strategy.packagingOptions.find((p) => p.id === input.packagingId)
      : undefined;
  if (packaging) hitRules.push(`packaging:${packaging.id}`);

  const qualityMultiplier = quality?.costMultiplier ?? 1;
  const productCost = input.supplierCost * strategy.baseFormula.supplierCostFactor * qualityMultiplier;
  const packagingCost = packaging?.cost ?? 0;

  // 3) 物流（按计费重量）
  const weightGrams = (input.weightGrams ?? 0) + (packaging?.addWeightGrams ?? 0);
  const volumeCm3 = (input.volumeCm3 ?? 0) + (packaging?.addVolumeCm3 ?? 0);
  const resolvedService = findCarrierService(strategy, input.carrierServiceId);
  let logisticsCost = 0;
  let chargeableWeightKg: number | undefined;
  if (resolvedService) {
    const out = calculateLogistics(resolvedService.service, weightGrams, volumeCm3);
    logisticsCost = out.cost;
    chargeableWeightKg = out.chargeableWeightKg;
    hitRules.push(`carrier:${resolvedService.carrier.id}/${resolvedService.service.id}`);
  }

  // 4) 关税 / 汇率缓冲（按 productCost + packaging 计提）
  const taxBase = productCost + packagingCost;
  const duty = taxBase * strategy.baseFormula.dutyPct;
  const fxBuffer = taxBase * strategy.baseFormula.fxBufferPct;

  const totalCost = productCost + packagingCost + logisticsCost + duty + fxBuffer;

  // 5) 利润 margin
  const tier = [...strategy.tiers]
    .sort((a, b) => b.minQty - a.minQty)
    .find((c) => input.qty >= c.minQty);
  let marginPct = tier?.marginPct ?? strategy.baseFormula.marginPct;
  hitRules.push(tier ? `tier:${tier.minQty}+` : 'base-margin');

  const regionRule = input.region ? strategy.regionAdjust[input.region] : undefined;
  if (regionRule) {
    marginPct += regionRule.marginPctDelta;
    hitRules.push(`region:${input.region}`);
  }

  const segmentRule = input.customerSegment ? strategy.customerSegmentAdjust[input.customerSegment] : undefined;
  if (segmentRule) {
    marginPct += segmentRule.marginPctDelta;
    hitRules.push(`segment:${input.customerSegment}`);
  }

  if (input.negotiationRound && strategy.negotiation && input.negotiationRound > 0) {
    const allowedRound = Math.min(input.negotiationRound, strategy.negotiation.maxRoundsToConcede);
    const discount = strategy.negotiation.stepDiscountPct.slice(0, allowedRound).reduce((s, p) => s + p, 0);
    const capped = Math.min(discount, strategy.guardrails.maxDiscountPct);
    marginPct -= capped / 100;
    hitRules.push(`negotiation:${allowedRound}`);
  }

  // 6) 护栏
  const minMarginPct = Math.max(strategy.guardrails.minMarginPct / 100, (regionRule?.minMarginPct ?? 0) / 100);
  const safeMarginPct = Math.max(Math.min(marginPct, 0.95), minMarginPct);
  if (safeMarginPct !== marginPct) hitRules.push('guardrail:min-margin');

  const rawUnitPrice = totalCost / (1 - safeMarginPct);
  const unitPrice = roundMoney(Math.max(rawUnitPrice, strategy.guardrails.minUnitPrice));
  const actualMarginPct = unitPrice > 0 ? roundPct((unitPrice - totalCost) / unitPrice) : 0;
  const marginAbs = roundMoney(unitPrice - totalCost);

  return {
    currency: strategy.currency,
    breakdown: {
      product: roundMoney(productCost),
      packaging: roundMoney(packagingCost),
      logistics: roundMoney(logisticsCost),
      duty: roundMoney(duty),
      fxBuffer: roundMoney(fxBuffer),
      margin: marginAbs,
      totalCost: roundMoney(totalCost)
    },
    unitPrice,
    total: roundMoney(unitPrice * input.qty),
    marginPct: actualMarginPct,
    hitRules,
    resolved: {
      quality,
      packaging,
      carrier: resolvedService?.carrier,
      carrierService: resolvedService?.service,
      chargeableWeightKg
    }
  };
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function roundPct(value: number) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
function roundWeight(value: number) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/**
 * 默认策略基于 2026-05 月份武汉陈路2 实际发货账单（221 票，221 件包裹）汇总：
 *   英国皇邮 84 / 欧洲 DHL 65 / 美国 UPS 18 / 加拿大 ETK 14 / HX 欧洲专线 11 / FedEx HK 10
 *   美国 USPS 7 / 澳洲集运 4 / DHL 带电 4 / 中东 2 / 其他 2
 * 单价 = 应收单价(中位 ¥/kg)，基础费 = 应收杂费 平均值；体积重除数 = 体积÷材积重 中位
 */
export const defaultPricingStrategy: PricingStrategy = {
  name: '默认策略-跨境 B2C 小货',
  currency: 'CNY',
  guardrails: { minMarginPct: 20, minUnitPrice: 10, maxDiscountPct: 15 },
  baseFormula: {
    supplierCostFactor: 1,
    dutyPct: 0,
    fxBufferPct: 0.02,
    marginPct: 0.35
  },
  qualityGrades: [
    { code: 'A', name: '通货 A 级', costMultiplier: 1, notes: '常规出货品质' },
    { code: 'AAA', name: '精品 AAA', costMultiplier: 1.25, notes: '面料/做工更好' },
    { code: 'OEM', name: 'OEM 定制', costMultiplier: 1.6, notes: '客户提供 LOGO / 改款' }
  ],
  packagingOptions: [
    { id: 'std', name: '通用 OPP 袋', cost: 5, addWeightGrams: 20, addVolumeCm3: 50, notes: '账单默认打包费 ¥5' },
    { id: 'box-s', name: '小礼盒', cost: 12, addWeightGrams: 180, addVolumeCm3: 1200 },
    { id: 'export-carton', name: '出口纸箱（5 件/箱）', cost: 8, addWeightGrams: 300, addVolumeCm3: 8000 }
  ],
  carriers: [
    {
      id: 'uk-royal',
      name: '英国皇邮',
      services: [
        {
          id: 'c-line',
          name: '英国皇邮快线-C价',
          speedDays: '7-12 天',
          regions: ['GB'],
          pricePerKg: 63,
          baseFee: 25,
          volumetricDivisor: 8000,
          minChargeKg: 0,
          notes: '2026-05 走货 84 票 · 主力线路'
        }
      ]
    },
    {
      id: 'dhl-eu',
      name: '欧洲 DHL',
      services: [
        {
          id: 'c-line',
          name: '欧洲DHL快线-C价',
          speedDays: '3-6 工作日',
          regions: ['DE', 'FR', 'NL', 'BE', 'DK', 'ES', 'IT', 'PL', 'SE'],
          pricePerKg: 71,
          baseFee: 68,
          volumetricDivisor: 8000,
          minChargeKg: 0,
          notes: '账单 65 票，欧盟主力'
        },
        {
          id: 'c-battery',
          name: '欧洲DHL快线-C带电',
          speedDays: '3-6 工作日',
          regions: ['DE', 'FR', 'NL'],
          pricePerKg: 79,
          baseFee: 78,
          volumetricDivisor: 8000,
          minChargeKg: 0,
          notes: '含锂电池'
        }
      ]
    },
    {
      id: 'us-ups',
      name: '美国 UPS',
      services: [
        {
          id: 'small-c',
          name: '美国UPS空派小货-C价',
          speedDays: '5-8 工作日',
          regions: ['US'],
          pricePerKg: 158,
          baseFee: 5,
          volumetricDivisor: 6000,
          minChargeKg: 0
        },
        {
          id: 'small-battery',
          name: '美国UPS空派小货-C带电',
          speedDays: '5-8 工作日',
          regions: ['US'],
          pricePerKg: 225,
          baseFee: 35,
          volumetricDivisor: 6000,
          minChargeKg: 0
        }
      ]
    },
    {
      id: 'us-usps',
      name: '美国 USPS',
      services: [
        {
          id: 'small',
          name: '美国USPS专线小包-C价',
          speedDays: '8-15 天',
          regions: ['US'],
          pricePerKg: 106,
          baseFee: 32,
          volumetricDivisor: 8000,
          minChargeKg: 0
        }
      ]
    },
    {
      id: 'ca-etk',
      name: '加拿大 ETK',
      services: [
        {
          id: 'etk',
          name: '广州 ETK',
          speedDays: '7-15 天',
          regions: ['CA'],
          pricePerKg: 154,
          baseFee: 5,
          volumetricDivisor: 6000,
          minChargeKg: 0
        }
      ]
    },
    {
      id: 'fedex-hk',
      name: '香港联邦 (FedEx HK)',
      services: [
        {
          id: 'pak',
          name: '香港联邦(2.5KG以内)-PAK',
          speedDays: '5-10 工作日',
          regions: ['GB', 'FR', 'BE', 'CH'],
          pricePerKg: 156,
          baseFee: 6,
          volumetricDivisor: 5000,
          minChargeKg: 0,
          notes: '2.5 kg 以内 PAK 袋'
        },
        {
          id: 'ip-battery',
          name: '香港联邦IP-C带电',
          speedDays: '5-10 工作日',
          regions: ['GB'],
          pricePerKg: 192,
          baseFee: 5,
          volumetricDivisor: 5000,
          minChargeKg: 0
        }
      ]
    },
    {
      id: 'hx-eu',
      name: 'HX 欧洲专线',
      services: [
        {
          id: 'small',
          name: 'HX-欧洲专线小包-C价',
          speedDays: '10-20 天',
          regions: ['CH', 'NO'],
          pricePerKg: 85,
          baseFee: 41,
          volumetricDivisor: 8000,
          minChargeKg: 0,
          notes: '欧洲非欧盟（瑞士 / 挪威）'
        }
      ]
    },
    {
      id: 'au-line',
      name: '澳洲专线',
      services: [
        {
          id: 'c-line',
          name: '澳大利亚集运专线-C价',
          speedDays: '10-20 天',
          regions: ['AU'],
          pricePerKg: 115,
          baseFee: 5,
          volumetricDivisor: 8000,
          minChargeKg: 0
        }
      ]
    },
    {
      id: 'me-line',
      name: '中东专线',
      services: [
        {
          id: 'c-line',
          name: '中东专线-C价',
          speedDays: '10-15 天',
          regions: ['AE'],
          pricePerKg: 52,
          baseFee: 65,
          volumetricDivisor: 6000,
          minChargeKg: 0
        }
      ]
    },
    {
      id: 'nl-mg',
      name: '荷兰小包 MG',
      services: [
        {
          id: 'mg',
          name: '荷兰小包-MG',
          speedDays: '10-20 天',
          regions: ['CH', 'NL'],
          pricePerKg: 129,
          baseFee: 42,
          volumetricDivisor: 6000,
          minChargeKg: 0
        }
      ]
    }
  ],
  tiers: [
    { minQty: 1, marginPct: 0.55 },
    { minQty: 10, marginPct: 0.45 },
    { minQty: 50, marginPct: 0.35 },
    { minQty: 200, marginPct: 0.28 },
    { minQty: 1000, marginPct: 0.22 }
  ],
  regionAdjust: {
    // 基于 5 月走货量的地区策略：英国/欧盟主力，美国 USPS 利润空间较小
    GB: { marginPctDelta: 0 },
    DE: { marginPctDelta: 0 },
    FR: { marginPctDelta: 0 },
    NL: { marginPctDelta: 0 },
    DK: { marginPctDelta: 0 },
    BE: { marginPctDelta: 0 },
    CH: { marginPctDelta: 0.02 },
    NO: { marginPctDelta: 0.02 },
    US: { marginPctDelta: -0.02 },
    CA: { marginPctDelta: 0 },
    AU: { marginPctDelta: 0 },
    AE: { marginPctDelta: 0.03, minMarginPct: 25 }
  },
  customerSegmentAdjust: {
    NEW: { marginPctDelta: 0.03 },
    VIP: { marginPctDelta: -0.05 },
    WHOLESALE: { marginPctDelta: -0.08 }
  },
  negotiation: {
    maxRoundsToConcede: 3,
    stepDiscountPct: [3, 2, 1]
  }
};
