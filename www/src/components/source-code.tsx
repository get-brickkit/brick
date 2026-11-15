import * as React from "react";
import { codeToHtml } from "shiki";

import { codeThemes } from "@/lib/code-theme";

/** Highlight actual source inside the site's plain code layout. */
export function SourceCode({
  code,
  lang = "ts",
}: {
  code: string;
  lang?: string;
}) {
  const [html, setHtml] = React.useState("");
  React.useEffect(() => {
    let active = true;
    setHtml("");
    codeToHtml(code, {
      lang,
      themes: codeThemes,
      defaultColor: false,
    }).then((result) => {
      if (active) setHtml(result);
    });
    return () => {
      active = false;
    };
  }, [code, lang]);
  return html ? (
    <div
      className="home-code not-fumadocs-codeblock"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <pre className="font-mono text-[13px] leading-[1.7] text-foreground">
      <code>{code}</code>
    </pre>
  );
}
