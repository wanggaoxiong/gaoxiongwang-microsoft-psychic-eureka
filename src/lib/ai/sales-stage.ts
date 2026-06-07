/**
 * 销售漏斗 7 阶段状态机（autopilot 用）。
 *
 *   S1 破冰    — 寒暄、首次问候、闲聊
 *   S2 探询    — 客户在表达需求；AI 收槽
 *   S3 推介    — 选品 + 发图
 *   S4 反馈    — 客户对推荐有反应（喜欢 / 换 / 具体追问）
 *   S5 报价    — 任何价格相关话题（必须人工或半自动审核）
 *   S6 物流    — 物流 / 交期 / 跟踪号
 *   S7 成交    — 下单 / PI / 付款 / 收款 / 收货
 *
 * 设计原则：
 * - 纯规则；不依赖 LLM。LLM 留给「生成回复」那一层，分类必须快、可解释、可回归测试。
 * - 仅看「最后一条 inbound 消息」+ 当前 stage，向前转移；不主动回退（除非 S5+ 触发明显闲聊）。
 * - 命中多个阶段时按优先级取最右（S7 > S6 > S5 > S4 > S3 > S2 > S1）。
 */
import 'server-only';
import type { WaConversation, WaMessage } from '@/lib/wa/store';

export type SalesStage = NonNullable<WaConversation['salesStage']>;
export type LeadTemperature = NonNullable<WaConversation['leadTemperature']>;
export type Slots = NonNullable<WaConversation['slots']>;

/** 各阶段触发关键词（中英文并存；保守宽松，宁多判勿漏判）。 */
const STAGE_PATTERNS: Record<Exclude<SalesStage, 'S1'>, RegExp> = {
  // S2：模糊的需求表达；这里也兼顾「想要 / 看款 / 有没有」
  S2: /(想看|看款|看一下|有没有|有没|什么款|什么样|哪种|哪款|哪个|偏好|颜色|尺寸|材质|风格|场景|平时|日常|送(人|礼)|预算|多少钱左右|大概多少|looking for|any (style|model|color|size)|do you have)/i,
  // S3：明确要发图 / 看货 / 推荐
  S3: /(发(我|给我|过来|过去|一下|个|款|两款|几款|一个|一款)?.*?(看看|包|鞋|裙|衣|表|链条|手提|新款|款式|图|图片|实拍|视频)|帮我发|给我发|看看(包|鞋|款|图)|想看(看|下)?|推荐|推介|有没有(图|新款|款式|样式)|show me|send (me )?(a |the |some )?(pic|photo|image|bag|shoe|style|model|design)|any (pic|photo|style|model|design))/i,
  // S4：对已发商品的反馈
  S4: /(这款|那款|这个|这只|那个|喜欢|不错|挺好|可以|不要|不喜欢|换一(个|款|批)|再看(看|一下)|还有(吗|没|什么)|更(好|多)|别的|其他|like (this|that|it)|love (it|this)|change|another|other (one|style|color)|more|don'?t (like|want))/i,
  // S5：价格 / 议价 / 数量 / MOQ / 折扣
  S5: /(价(钱|格)|多少钱|怎么卖|多少|折扣|打折|便宜(点|些|一点)?|批发|moq|起订|起批|min(imum)?\s*(order|qty)|wholesale|discount|cheaper|best price|lowest|how much|price (list|sheet)|usd|cny|rmb|\$\d|¥\d|￥\d|€\d)/i,
  // S6：物流 / 交期 / 发货 / 跟踪
  S6: /(发(货|什么|哪家|顺丰|dhl|fedex|ups|ems)|物流|运费|海运|空运|快递|多久(能|可以)?(到|发)|交期|发货时间|when.*ship|shipping|delivery|tracking|跟踪号|track(ing)?\s*(no|number)|到货时间|多少天到)/i,
  // S7：成交动作
  S7: /(我要了|要这(个|款)|下(订)?单|下单了|订(单|了)|确认订单|开pi|pi单|proforma|invoice|付款|打款|转账|paypal|swift|t\/t|wire|怎么(付|付款|支付|给你|转钱)|如何(付款|支付|付钱)|how (can|do|should|to)\s*i?\s*pay|how to pay|payment (method|way)?|pay (you|now|for)|confirm (order|deal)|i'?ll take|deal|let'?s (do|go)|going to (buy|order))/i
};

/** S1 兜底信号：纯问候 / 表情 / 短闲聊。命中且无更高阶段时维持 S1。 */
const S1_GREETING = /^(hi+|hello|hey|你好|您好|在(吗|嘛)?|嗨|喂|有人(吗|嘛)?|good\s*(morning|afternoon|evening)|哈喽|👋|早|晚上好|周末好)\s*[!?.~。！？]?$/i;

export type ClassifyInput = {
  /** 最后一条客户消息（必填；direction 应为 in） */
  lastInbound: WaMessage;
  /** 上一条销售/AI 出站消息（用于 S2→S3 短答兜底） */
  prevOutbound?: WaMessage;
  /** 当前 stage；无则视为 S1 */
  currentStage?: SalesStage;
};

export type ClassifyResult = {
  stage: SalesStage;
  /** 触发该阶段的判定理由（用于审计/日志） */
  reason: string;
  /** 命中 S5/S7 时建议升温到 hot */
  suggestedTemperature?: LeadTemperature;
};

/**
 * 给一条 inbound 消息分类阶段。
 * 转移规则：
 *   - 命中显式 pattern → 取最高阶段
 *   - 否则若 currentStage = S3 且短回应 → 留在 S4（等价"客户在看图后回应"）
 *   - 否则若 currentStage = S2 且短回应（偏好词）→ 跳 S3（你已有 contextual short-answer hit）
 *   - 否则保留 currentStage（不轻易下沉）
 */
export function classifyStage(input: ClassifyInput): ClassifyResult {
  const text = (input.lastInbound.text || '').trim();
  const current = input.currentStage ?? 'S1';
  if (!text) {
    return { stage: current, reason: 'empty-or-media-only' };
  }

  // 高优先级：S7 > S6 > S5（一旦命中商务话题，直接进入）
  if (STAGE_PATTERNS.S7.test(text))
    return { stage: 'S7', reason: 'pattern:S7', suggestedTemperature: 'hot' };
  if (STAGE_PATTERNS.S5.test(text))
    return { stage: 'S5', reason: 'pattern:S5', suggestedTemperature: 'hot' };
  if (STAGE_PATTERNS.S6.test(text))
    return { stage: 'S6', reason: 'pattern:S6', suggestedTemperature: 'hot' };
  if (STAGE_PATTERNS.S4.test(text) && (current === 'S3' || current === 'S4'))
    return { stage: 'S4', reason: 'pattern:S4-after-show', suggestedTemperature: 'warm' };
  if (STAGE_PATTERNS.S3.test(text))
    return { stage: 'S3', reason: 'pattern:S3', suggestedTemperature: 'warm' };
  if (STAGE_PATTERNS.S2.test(text))
    return { stage: 'S2', reason: 'pattern:S2', suggestedTemperature: 'warm' };

  // 上下文兜底：在 S2 阶段，销售刚问偏好，客户用极短答 → 视为已选定，进入 S3
  if (current === 'S2' && text.length <= 12) {
    const prev = input.prevOutbound?.text || '';
    const sellerAskedPref =
      /(日常|经典|百搭|链条|手提|斜挎|单肩|颜色|什么款|哪款|偏好|风格|喜欢什么|想看|发你|发给你|哪种|哪个)/.test(
        prev
      );
    if (
      sellerAskedPref &&
      /(日常|经典|百搭|链条|手提|斜挎|单肩|黑|白|棕|红|蓝|皮|帆布|尼龙|大|小|中|高端|便宜|这款|那款|这个|那个|对|嗯|要|可以|好|ok|yes|都行|都可以|随便|看你的|你看|你定|没所谓|无所谓|哪个都行)/i.test(
        text
      )
    ) {
      return { stage: 'S3', reason: 'context:S2-short-answer-to-pref' };
    }
  }

  // 在 S3 阶段，客户给短答（"都行/好的/对"）→ 通常是想看更多 → 留 S3 让流程继续发款
  if (current === 'S3' && text.length <= 8 && /(都行|好|ok|可以|对|嗯|yes|sure)/i.test(text)) {
    return { stage: 'S3', reason: 'context:S3-short-affirm' };
  }

  // S1 显式问候 / 短闲聊 → 仍是 S1
  if (S1_GREETING.test(text)) {
    return { stage: current === 'S1' ? 'S1' : current, reason: 'pattern:S1-greeting' };
  }

  return { stage: current, reason: 'no-trigger-keep-current' };
}

/**
 * 从客户消息里抽取 5 个偏好槽位。纯规则；命中即填，未命中保持原值（不清除）。
 * 后续 P1 可以接 LLM 兜底；现在以规则为主，避免无谓 token 消耗。
 */
export function extractSlots(text: string, prior?: Slots): Slots {
  const slots: Slots = { ...(prior ?? {}) };
  if (!text) return slots;
  const t = text.toLowerCase();

  // category
  const categoryMap: Array<[RegExp, string]> = [
    [/(包|手提|链条|斜挎|单肩|背包|bag|handbag|tote|crossbody|shoulder|backpack)/i, '包'],
    [/(鞋|靴|sneaker|shoe|boot|高跟|凉鞋|休闲鞋|跑鞋)/i, '鞋'],
    [/(裙|连衣裙|dress|skirt)/i, '裙'],
    [/(衣|外套|jacket|coat|衬衫|shirt|t恤|tee)/i, '上装'],
    [/(裤|trousers|pants|jeans|牛仔)/i, '下装'],
    [/(表|手表|watch)/i, '表']
  ];
  for (const [re, v] of categoryMap) {
    if (re.test(t)) {
      slots.category = v;
      break;
    }
  }

  // occasion / scene
  const occasionMap: Array<[RegExp, string]> = [
    [/(通勤|上班|商务|business|work|office)/i, '通勤'],
    [/(日常|百搭|平时|daily|casual|everyday)/i, '日常'],
    [/(约会|赴约|date|dinner)/i, '约会'],
    [/(出差|trip|travel|出行)/i, '出差'],
    [/(party|宴会|聚会|婚礼|wedding)/i, '宴会'],
    [/(送礼|送(人|朋友|妈|爸|老婆|男友|女友)|gift|present)/i, '送礼']
  ];
  for (const [re, v] of occasionMap) {
    if (re.test(t)) {
      slots.occasion = v;
      break;
    }
  }

  // color preference
  const colorMap: Array<[RegExp, string]> = [
    [/(黑|black)/i, '黑'],
    [/(白|white|奶白)/i, '白'],
    [/(棕|咖啡|brown|coffee)/i, '棕'],
    [/(米|beige|nude|裸|奶茶)/i, '米/裸'],
    [/(红|burgundy|酒红|red)/i, '红'],
    [/(蓝|blue|navy)/i, '蓝'],
    [/(灰|grey|gray)/i, '灰'],
    [/(粉|pink)/i, '粉']
  ];
  for (const [re, v] of colorMap) {
    if (re.test(t)) {
      slots.colorPref = v;
      break;
    }
  }

  // price band
  if (/(便宜|实惠|cheap|budget|低价|入门)/i.test(t)) slots.priceBand = 'low';
  else if (/(中端|性价比|midd?le)/i.test(t)) slots.priceBand = 'mid';
  else if (/(高端|奢侈|luxury|premium|高级|质量好|顶级)/i.test(t)) slots.priceBand = 'high';

  // audience
  if (/(自用|自己用|for me|myself)/i.test(t)) slots.audience = '自用';
  else if (/(送(妈|妈妈|母亲|爸|爸爸|父亲|老婆|男友|女友|朋友|同事|领导|客户)|gift|present)/i.test(t))
    slots.audience = '送礼';
  else if (/(批发|wholesale|代理|分销|店里卖|店铺用)/i.test(t)) slots.audience = '批发';

  return slots;
}

export const STAGE_LABEL: Record<SalesStage, string> = {
  S1: '破冰',
  S2: '探询',
  S3: '推介',
  S4: '反馈',
  S5: '报价',
  S6: '物流',
  S7: '成交'
};

export const SLOT_LABEL: Record<keyof Slots, string> = {
  category: '品类',
  occasion: '场景',
  colorPref: '颜色',
  priceBand: '价位',
  audience: '受众'
};
