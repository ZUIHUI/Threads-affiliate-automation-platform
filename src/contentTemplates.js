const POST_PROMPT_TEMPLATE = `你是 Threads 短文內容企劃，請根據以下資料產生 5 則 Threads 貼文草稿。

主題：{topic}
目標受眾：想用 AI 做副業、自動化、聯盟行銷的新手
內容目的：教育、建立信任、引導互動
語氣：自然、直接、有觀點，不要像廣告文
字數限制：每則 500 字以內
限制：
1. 不要過度誇大收益
2. 不要保證賺錢
3. 不要使用假見證
4. 每則只能有一個重點
5. 結尾要有一個互動問題

輸出格式：
[
  {
    "hook": "...",
    "post": "...",
    "cta": "...",
    "risk_note": "這則文是否有誇大或違規風險"
  }
]`;

const POST_TYPE_TEMPLATES = [
  {
    type: "教學型",
    ratio: "trust",
    hook: "很多人做 AI 自動化副業，第一步就做錯。",
    body: (topic) => `不是先開帳號，也不是先找商品。

而是先設計「內容資料流」：

1. 你要講什麼主題
2. 內容從哪裡來
3. 誰審稿
4. 什麼時間發
5. 發完怎麼追成效

以「${topic}」來看，沒有這條流程，自動化只會變成自動製造垃圾內容。`,
    cta: "你覺得最難的是產文，還是穩定發文？"
  },
  {
    type: "清單型",
    ratio: "trust",
    hook: "Threads 自動發文流程，我會拆成 6 層：",
    body: () => `1. 題庫
2. AI 草稿
3. 人工審核
4. 排程發文
5. 成效紀錄
6. 內容優化

真正重要的不是「能不能自動發」。

而是你有沒有辦法知道哪一種內容有效，然後讓下一輪內容變好。`,
    cta: "你現在卡在哪一層？"
  },
  {
    type: "觀點型",
    ratio: "trust",
    hook: "AI 發文自動化不是問題。",
    body: () => `問題是很多人把它做成：
大量貼文、大量連結、大量廣告。

這種帳號通常撐不久。

比較好的做法是：

80% 內容建立信任
15% 分享工具/方法
5% 才放聯盟連結或轉換入口

Threads 比較吃「像真人的觀點」，不是像型錄的文案。`,
    cta: "你目前的內容比較像觀點，還是比較像廣告？"
  },
  {
    type: "MVP 型",
    ratio: "method",
    hook: "如果要最快驗證 Threads affiliate，我不會一開始就做完整系統。",
    body: () => `MVP 版可以先用：

Google Sheet
+ OpenAI / ChatGPT 產草稿
+ n8n 排程
+ Threads API

先看哪些主題有人互動、哪種語氣比較自然、發文頻率多少不會太像機器。

工具不是重點，流程才是重點。`,
    cta: "你會先驗證主題，還是先驗證商品？"
  },
  {
    type: "轉換型",
    ratio: "conversion",
    hook: "聯盟連結不要急著每篇都放。",
    body: (topic, productName, link, disclosure) => `${disclosure}：比較穩的做法是先用內容建立信任，再把工具或資源整理成一個入口。

例如「${topic}」這種主題，可以先教育流程，再推薦適合新手測試的小工具。

我會把連結放在少數幾篇真正需要延伸資源的內容裡：${link}`,
    cta: "你比較能接受直接放連結，還是先導到整理頁？"
  }
];

function buildPrompt(topic) {
  return POST_PROMPT_TEMPLATE.replace("{topic}", topic || "AI 自動化聯盟行銷");
}

function generatePromptDrafts({ topic, productName, trackingLink, disclosureText }) {
  const safeTopic = topic || "AI 自動化聯盟行銷";
  const disclosure = disclosureText || "含聯盟連結";
  return POST_TYPE_TEMPLATES.map((template) => {
    const body = template.body(safeTopic, productName, trackingLink, disclosure);
    const post = `${template.hook}\n\n${body}\n\n${template.cta}`;
    return {
      type: template.type,
      ratio: template.ratio,
      hook: template.hook,
      post,
      cta: template.cta,
      risk_note: "低風險：未保證收益、未使用假見證，結尾有互動問題。"
    };
  });
}

module.exports = {
  POST_PROMPT_TEMPLATE,
  POST_TYPE_TEMPLATES,
  buildPrompt,
  generatePromptDrafts
};
