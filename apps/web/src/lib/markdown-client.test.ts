import test from "node:test"
import assert from "node:assert/strict"
import { renderMarkdownToHtml } from "./markdown-client"

test("renders headings, paragraphs, inline styles, and horizontal rules", () => {
  const html = renderMarkdownToHtml("# Title\n\nHello **world** and *friends* with ~~old~~ `code`.\n\n---")
  assert.match(html, /<h1>Title<\/h1>/)
  assert.match(html, /<p>Hello <strong>world<\/strong> and <em>friends<\/em> with <del>old<\/del> <code>code<\/code>\.<\/p>/)
  assert.match(html, /<hr>/)
})

test("renders fenced code blocks without interpreting inner markdown or HTML", () => {
  const html = renderMarkdownToHtml("```ts\nconst x = 1 < 2 && **raw**\n```")
  assert.equal(html, '<pre><code class="language-ts">const x = 1 &lt; 2 &amp;&amp; **raw**</code></pre>')
})

test("renders lists, checklists, blockquotes, and pipe tables", () => {
  const md = [
    "- [x] Done item",
    "- [ ] Pending item",
    "",
    "1. First",
    "2. Second",
    "",
    "> Quoted **line**",
    "",
    "| Item | Qty |",
    "| --- | --- |",
    "| Milk | 2 |",
  ].join("\n")
  const html = renderMarkdownToHtml(md)
  assert.match(html, /<ul><li><span class="md-check">☑<\/span> Done item<\/li><li><span class="md-check">☐<\/span> Pending item<\/li><\/ul>/)
  assert.match(html, /<ol><li>First<\/li><li>Second<\/li><\/ol>/)
  assert.match(html, /<blockquote><p>Quoted <strong>line<\/strong><\/p><\/blockquote>/)
  assert.match(html, /<table><thead><tr><th>Item<\/th><th>Qty<\/th><\/tr><\/thead><tbody><tr><td>Milk<\/td><td>2<\/td><\/tr><\/tbody><\/table>/)
})

test("escapes raw HTML and blocks javascript: URLs while allowing safe links", () => {
  const html = renderMarkdownToHtml("<script>alert(1)</script> [bad](javascript:alert(1)) [ok](https://example.com)")
  assert.ok(!html.includes("<script>"))
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"))
  assert.ok(!html.includes("javascript:"))
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">ok<\/a>/)
})
