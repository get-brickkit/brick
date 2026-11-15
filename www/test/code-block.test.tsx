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
