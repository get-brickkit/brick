import { useEffect, useId, useRef, useState } from "react";
import { CodeBlockPre } from "./code-block";
import { brickPalette } from "../lib/code-theme";

function isDark() {
  return document.documentElement.classList.contains("dark");
}

/** The source is the server render and the fallback; the diagram replaces it once mermaid draws it in the browser. */
export function Mermaid({ chart }: { chart: string }) {
  const id = `mermaid-${useId().replace(/\W/g, "")}`;
  const box = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>();
  const [dark, setDark] = useState<boolean>();

  useEffect(() => {
    setDark(isDark());
    const watch = new MutationObserver(() => setDark(isDark()));
    watch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    if (dark === undefined) return;
    let stale = false;
    const c = brickPalette[dark ? "dark" : "light"];
    // Holds the block's height so the swap from source to diagram does not move the page.
    if (box.current)
      box.current.style.minHeight = `${box.current.offsetHeight}px`;
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            fontFamily: "inherit",
            background: c.background,
            primaryColor: c.background,
            primaryTextColor: c.ink,
            primaryBorderColor: c.accent,
            lineColor: c.muted,
            textColor: c.ink,
          },
        });
        const out = await mermaid.render(id, chart);
        if (!stale) setSvg(out.svg);
      })
      // A diagram that fails to parse keeps showing its source.
      .catch(() => !stale && setSvg(undefined));
    return () => {
      stale = true;
    };
  }, [chart, dark, id]);

  return (
    <div ref={box}>
      {svg ? (
        <div
          role="img"
          aria-label="Diagram"
          className="my-4 flex justify-center overflow-x-auto motion-safe:animate-fd-fade-in [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <CodeBlockPre>
          <code>{chart}</code>
        </CodeBlockPre>
      )}
    </div>
  );
}
