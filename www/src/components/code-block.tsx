import { CodeBlock, Pre } from "@fumadocs/base-ui/components/codeblock";
import type { ComponentProps } from "react";

// Fumadocs caps each code block at 600px and scrolls inside it. On a phone that
// inner scroll takes over the page's swipe, so the block grows to its content
// instead. Long lines still scroll sideways.
export function CodeBlockPre(props: ComponentProps<"pre">) {
  return (
    <CodeBlock {...props} viewportProps={{ className: "max-h-none" }}>
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}
