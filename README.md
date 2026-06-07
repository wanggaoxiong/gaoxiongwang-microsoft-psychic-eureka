# WhatsApp AI Sales Assistant

一个面向独立站、微商和跨境电商的 WhatsApp AI 私域销售助手 MVP 骨架。

## 已实现的 MVP-0 能力

- Next.js 三栏 Inbox 原型：会话列表、聊天流、AI 作战面板
- gxhyapp 供应商连接器接口：登录、搜索、详情，当前带 mock fallback
- 报价引擎：成本加成、阶梯价、地区/客户分层、谈判护栏
- WhatsApp Cloud API webhook/send 路由骨架
- AI 编排入口：需求识别 → 供应商搜索 → 推荐 → 报价 → 建议回复
- Prisma 数据模型：客户、会话、消息、询盘、候选品、报价、订单、物流
- Label-tracker 对接占位：后续接入物流注册与状态回调

## 本地启动

```bash
npm install
cp .env.example .env.local
docker compose up -d
npm run db:generate
npm run db:push
npm run dev
```

打开：

- `http://localhost:3000` 首页
- `http://localhost:3000/inbox` 三栏销售工作台
- `http://localhost:3000/suppliers` 供应商连接器
- `http://localhost:3000/pricing` 报价策略

## Step-by-step 测试建议

### 1. 基础工程验证

```bash
npm install
npm run typecheck
npm test
npm run build
```

预期：

- TypeScript 无错误
- 报价引擎测试通过
- Next.js 可以完成生产构建

### 2. 页面交互验证

1. 启动 `npm run dev`
2. 打开 `/inbox`
3. 检查三栏布局是否正常：左侧客户列表、中间聊天、右侧 AI 作战面板
4. 检查候选商品图片是否显示
5. 打开 `/suppliers`，确认 gxhyapp 连接器已注册
6. 打开 `/pricing`，确认不同数量的阶梯报价不同

### 3. 供应商搜索 API

```bash
curl -X POST http://localhost:3000/api/suppliers/search \
  -H 'content-type: application/json' \
  -d '{"connectorKey":"gxhyapp","query":{"text":"bag","page":1}}'
```

预期：

- 返回 `products`
- 商品字段包含 `externalId/title/images/skus/minPrice`

### 4. AI 推荐 API

```bash
curl -X POST http://localhost:3000/api/ai/run \
  -H 'content-type: application/json' \
  -d '{"conversationId":"demo","customerText":"I need brown chain bag, quote for 50 pcs"}'
```

预期：

- 返回 `detectedNeed`
- 返回 `recommendations`
- 返回 `suggestedReply`
- 推荐结果包含报价 `quote.unitPrice`

### 5. WhatsApp webhook 验证

```bash
curl 'http://localhost:3000/api/wa/webhook?hub.mode=subscribe&hub.verify_token=dev-verify-token&hub.challenge=hello'
```

预期返回：

```text
hello
```

### 6. WhatsApp 入站消息模拟

```bash
curl -X POST http://localhost:3000/api/wa/webhook \
  -H 'content-type: application/json' \
  -d '{
    "entry": [{
      "changes": [{
        "value": {
          "messages": [{
            "from": "15551234567",
            "text": { "body": "Need smart watch with good battery" }
          }]
        }
      }]
    }]
  }'
```

预期：

- 返回 `ok: true`
- `received: 1`
- `aiResults[0].suggestedReply` 包含智能手表推荐和报价

### 7. WhatsApp 发送 dry-run

不配置 `WA_PHONE_NUMBER_ID` / `WA_ACCESS_TOKEN` 时：

```bash
curl -X POST http://localhost:3000/api/wa/send \
  -H 'content-type: application/json' \
  -d '{"to":"15551234567","text":"Hello from AI sales assistant"}'
```

预期：

- 返回 `dryRun: true`
- 不会真实发送 WhatsApp 消息

### 8. 真实 WhatsApp Cloud API 测试

1. 在 Meta Developers 创建 WhatsApp Business App
2. 设置 `.env.local`：
   - `WA_PHONE_NUMBER_ID`
   - `WA_ACCESS_TOKEN`
   - `WA_WEBHOOK_VERIFY_TOKEN`
3. 用 Cloudflare Tunnel / ngrok 暴露本地：
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
4. 在 Meta webhook 配置：
   - Callback URL：`https://你的域名/api/wa/webhook`
   - Verify token：`.env.local` 中的 `WA_WEBHOOK_VERIFY_TOKEN`
5. 订阅 `messages`
6. 用测试号码发消息，检查 `/api/wa/webhook` 返回与日志

## 后续建议

1. 逆向 gxhyapp 的真实 XHR API，替换当前 mock 搜索 mapper
2. 接入对象存储 + sharp，落地真实组图、水印和 EXIF 清理
3. 接入数据库落库 webhook 消息，实现真实 Inbox 数据源
4. 把 AI 编排升级成 LangGraph 状态机，并加入人工审批流
5. 与 Label-tracker 做 webhook 对接，实现物流自动回推 WhatsApp
