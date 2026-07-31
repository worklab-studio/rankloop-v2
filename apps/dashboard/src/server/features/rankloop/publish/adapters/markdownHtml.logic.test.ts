import { describe, expect, it } from "vitest";
import { markdownToHtml, renderInline } from "./markdownHtml.logic";

describe("renderInline", () => {
  it("renders links, bold, italic and code", () => {
    expect(
      renderInline(
        "See the [tamper guide](/blog/tampers/) for **dose** and *grind*.",
      ),
    ).toBe(
      'See the <a href="/blog/tampers/">tamper guide</a> for <strong>dose</strong> and <em>grind</em>.',
    );
    expect(renderInline("Run `pnpm test` first.")).toBe(
      "Run <code>pnpm test</code> first.",
    );
  });

  it("leaves markdown inside a code span alone", () => {
    expect(renderInline("Type `**not bold**` here.")).toBe(
      "Type <code>**not bold**</code> here.",
    );
  });

  it("escapes HTML the writer typed rather than passing it through", () => {
    expect(renderInline("Use <script>alert(1)</script> nowhere.")).toBe(
      "Use &lt;script&gt;alert(1)&lt;/script&gt; nowhere.",
    );
  });

  it("does not read an underscore inside a URL as emphasis", () => {
    expect(renderInline("[docs](/a_b_c/) then _emphasis_ after.")).toBe(
      '<a href="/a_b_c/">docs</a> then <em>emphasis</em> after.',
    );
  });
});

describe("markdownToHtml", () => {
  it("renders the shape a gated draft actually has", () => {
    const markdown = [
      "Espresso pucks channel when the dose is off.",
      "",
      "## What we compared",
      "",
      "- Grind consistency",
      "- Retention",
      "",
      "See the [tamper guide](/blog/tampers/) for the method.",
    ].join("\n");

    expect(markdownToHtml(markdown)).toBe(
      [
        "<p>Espresso pucks channel when the dose is off.</p>",
        "",
        "<h2>What we compared</h2>",
        "",
        "<ul>",
        "<li>Grind consistency</li>",
        "<li>Retention</li>",
        "</ul>",
        "",
        '<p>See the <a href="/blog/tampers/">tamper guide</a> for the method.</p>',
      ].join("\n"),
    );
  });

  it("renders an ordered list as ol", () => {
    expect(markdownToHtml("1. Weigh in\n2. Weigh out")).toBe(
      "<ol>\n<li>Weigh in</li>\n<li>Weigh out</li>\n</ol>",
    );
  });

  it("renders a GFM table", () => {
    const markdown = [
      "| Tool | Yield |",
      "| --- | --- |",
      "| V60 | 300g |",
    ].join("\n");
    expect(markdownToHtml(markdown)).toBe(
      [
        "<table>",
        "<thead><tr><th>Tool</th><th>Yield</th></tr></thead>",
        "<tbody>",
        "<tr><td>V60</td><td>300g</td></tr>",
        "</tbody>",
        "</table>",
      ].join("\n"),
    );
  });

  it("keeps a fenced code block whole and escaped", () => {
    const markdown = "```\nif (a < b) {}\n```";
    expect(markdownToHtml(markdown)).toBe(
      "<pre><code>if (a &lt; b) {}</code></pre>",
    );
  });

  it("joins a wrapped paragraph into one p", () => {
    expect(markdownToHtml("One line\nand its wrap.")).toBe(
      "<p>One line and its wrap.</p>",
    );
  });

  it("still finds a heading the writer forgot to surround with blank lines", () => {
    expect(markdownToHtml("Body text.\n## FAQ\nAnswer.")).toBe(
      "<p>Body text.</p>\n<h2>FAQ</h2>\n<p>Answer.</p>",
    );
  });

  it("renders a blockquote", () => {
    expect(markdownToHtml("> Grind finer.\n> Then re-dose.")).toBe(
      "<blockquote><p>Grind finer. Then re-dose.</p></blockquote>",
    );
  });
});
