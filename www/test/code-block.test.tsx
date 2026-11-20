import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getMDXComponents } from "../src/components/mdx";

describe("code blocks", () => {
  test("grow to their content instead of scrolling inside a 600px box", () => {
    const { pre: Pre } = getMDXComponents();
    const html = renderToStaticMarkup(
      <Pre>
        <code>const a = 1;</code>
      </Pre>,
    );

    const region =
      html.match(/<div[^>]*class="[^"]*fd-scroll-container[^"]*"[^>]*>/)?.[0] ??
      "";
    expect(region).toContain("max-h-none");
    expect(region).not.toContain("max-h-[600px]");
    expect(region).toContain("overflow-auto");
  });
});

describe("mermaid", () => {
  test("server-renders the diagram source as a code block", () => {
    const { Mermaid } = getMDXComponents();
    const html = renderToStaticMarkup(
      <Mermaid chart={"flowchart LR\n  A --> B"} />,
    );
    expect(html).toContain("flowchart LR");
    expect(html).toContain("fd-scroll-container");
  });
});
