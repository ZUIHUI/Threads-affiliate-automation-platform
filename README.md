# Threads Affiliate Content Publisher

這個系統只專注完成一件事：

> 根據真實聯盟商品資料，由 AI 產生自然、不誇大、可追蹤的 Threads 貼文，經人工審核後發布。

## 主要流程

1. **讀取商品資料**：從資料庫選擇真實 HTTPS 聯盟連結，安全追蹤轉址並擷取商品頁標題、說明、價格與結構化資料。
2. **AI 產生文案**：把已驗證的商品欄位與網頁證據交給 OpenAI，產生 5 則繁體中文 Threads 草稿。網頁內容只當資料，不會被當成 AI 指令。
3. **人工審核**：檢查商品事實、聯盟揭露、誇大宣稱、相似度與內容疲勞；核准後才能排程。
4. **發布與追蹤**：通過 readiness gate 後使用 Threads API 發布，連結經 `/r/{slug}` 記錄點擊，轉換由 `/api/conversions` 回傳收益。

管理介面的預設「內容發布」頁只呈現以上四步。成效分析、批次匯入、來源同步、背景程序與系統 readiness 保留在次要工作模式中。

## 最小正式設定

```env
NODE_ENV=production
PUBLIC_BASE_URL=https://your-service.example
DATABASE_URL=postgresql://...
ADMIN_PASSWORD=...
ADMIN_SESSION_SECRET=...

AI_DRAFT_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_TIMEOUT_MS=90000
OFFER_PAGE_CONTEXT_ENABLED=true

THREADS_DRY_RUN=true
THREADS_USER_ID=...
THREADS_ACCESS_TOKEN=...
```

先保持 `THREADS_DRY_RUN=true` 完成商品讀取、AI 產文、審核、排程與模擬發布。確認 `/api/readiness` 全部通過後，才切換正式發布。

## 聯盟商品來源

- 管理介面單筆建立。
- CSV / JSON 批次匯入，先預覽驗證再寫入。
- 透過 `AFFILIATE_OFFER_FEED_URLS` 從聯盟平台 adapter 自動同步。

只有真實公開 HTTPS 聯盟連結會進入主要內容流程。`example.com`、本機網址、示範平台及私有網路不會通過營利與發布閘門。

## 驗證

```bash
npm test
```

聚焦測試可分別執行：

```bash
npm run test:workflow
npm run test:offer-page
npm run test:offer-import
npm run test:monetization
```

正式部署與環境變數細節請見 [`docs/PRODUCTION_RUNBOOK.md`](docs/PRODUCTION_RUNBOOK.md) 與 [`docs/deployment.md`](docs/deployment.md)。
