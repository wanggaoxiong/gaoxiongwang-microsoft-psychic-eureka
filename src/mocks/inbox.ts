export const mockConversations = [
  {
    id: 'conv_1',
    customer: 'Maria · US',
    channel: 'WhatsApp +1 *** 2931',
    stage: '需求挖掘',
    aiMode: 'SUGGEST',
    lastMessage: 'Can you find this bag in brown and send price for 50 pcs?',
    messages: [
      { from: 'customer', text: 'Can you find this bag in brown and send price for 50 pcs?' },
      { from: 'ai', text: '我先确认棕色链条包、50 件、发美国，对吗？我会给你 3 组接近款式。' }
    ]
  },
  {
    id: 'conv_2',
    customer: 'Ahmed · UAE',
    channel: 'WhatsApp +971 *** 0182',
    stage: '报价中',
    aiMode: 'AUTO',
    lastMessage: 'Need smart watch, good battery, Arabic support.',
    messages: [
      { from: 'customer', text: 'Need smart watch, good battery, Arabic support.' },
      { from: 'ai', text: 'I found several smart watches with 7-day battery and multi-language support.' }
    ]
  },
  {
    id: 'conv_3',
    customer: 'Lucia · BR',
    channel: 'WhatsApp +55 *** 7710',
    stage: '待付款',
    aiMode: 'OFF',
    lastMessage: 'Please hold the sneakers order until tomorrow.',
    messages: [
      { from: 'customer', text: 'Please hold the sneakers order until tomorrow.' },
      { from: 'sales', text: '没问题，我先帮你保留这批库存。' }
    ]
  }
];

export type InboxMessage = (typeof mockConversations)[number]['messages'][number] & {
  images?: string[];
  productTitle?: string;
  quoteText?: string;
};

export type InboxConversation = Omit<(typeof mockConversations)[number], 'messages'> & {
  messages: InboxMessage[];
};
