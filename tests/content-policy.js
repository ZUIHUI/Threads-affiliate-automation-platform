const assert = require("node:assert/strict");

const {
  commercialPostText,
  editorialPostText,
  explicitTopicTag,
  socialDisclosureText
} = require("../src/contentPolicy");
const { validatePost } = require("../src/validators");

const config = { defaultDisclosureText: "含聯盟連結" };
const productUrl = "https://shop.example/product?id=real-affiliate-product";
const wrongUrl = "https://app.example/r/wrong-link?post=123";
const cta = "你會放在玄關還是衣櫃？";
const text = commercialPostText({
  post: `想要一盞走近就亮的小燈？\n\n含有聯盟連結：磁吸安裝比較適合不想鑽牆的人。 ${wrongUrl}\n\n${cta}`,
  cta
}, productUrl, config);

assert.doesNotMatch(text, /含有?聯盟連結|app\.example\/r\//);
assert.equal((text.match(/https:\/\//g) || []).length, 1);
assert.match(text, /商品連結：\nhttps:\/\/shop\.example\/product\?id=real-affiliate-product/);
assert.match(text, /#廣告/);
assert.equal(text.endsWith(cta), true);
assert.equal(socialDisclosureText(config), "#廣告");
assert.equal(explicitTopicTag(""), "");
assert.equal(explicitTopicTag("照明.選購&建議"), "照明選購建議");

const validation = validatePost({
  text,
  linkAttachment: productUrl,
  funnelRatio: "conversion",
  topicTag: ""
}, config);
assert.equal(validation.valid, true);
assert.equal(validation.warnings.some((warning) => /disclosure/i.test(warning)), false);

const editorial = editorialPostText({
  post: `不導購的選購提醒。\n\n${wrongUrl}\n\n含聯盟連結：先確認尺寸。`
}, config);
assert.doesNotMatch(editorial, /https?:\/\/|含有?聯盟連結|#廣告/);

console.log("Content policy passed.");
