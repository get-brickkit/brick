import { CheckIcon, CopyIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";
import { Link } from "@tanstack/react-router";

export function InstallOptions() {
  const [audience, setAudience] = React.useState<"you" | "agent">("you");
  return (
    <div className="install-options">
      <div
        role="group"
        aria-label="Installation options"
        className="install-audiences"
      >
        <button
          type="button"
          aria-pressed={audience === "you"}
          onClick={() => setAudience("you")}
        >
          For you
        </button>
        <span aria-hidden="true">|</span>
        <button
          type="button"
          aria-pressed={audience === "agent"}
          onClick={() => setAudience("agent")}
        >
          For your agent
        </button>
      </div>
      <InstallCommand
        key={audience}
        className="home-install"
        command={
          audience === "you"
            ? "bun add @brickkit/core @brickkit/cli"
            : "npx skills add get-brickkit/brick --skill brick"
        }
      />
      <Link
        to="/docs/$"
        params={{ _splat: "for-ai-agents" }}
        className="install-agent-guide"
      >
        {audience === "agent"
          ? "Set up your agent with Brick docs and MCP ↗"
          : "Building with an AI agent? ↗"}
      </Link>
    </div>
  );
}

export function InstallCommand({
  command = "bun add @brickkit/core @brickkit/cli",
  className,
}: {
  command?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy "${command}"`}
      onClick={() =>
        void navigator.clipboard.writeText(command).then(() => {
          trackEvent("copy-install-command", { command });
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      className={cn(
        "group inline-flex h-11 max-w-full items-center gap-3 rounded-lg border bg-card pr-3 pl-4 font-mono text-[13.5px] transition-colors hover:border-foreground/25",
        className,
      )}
    >
      <span className="text-gopher-ink select-none">$</span>
      <span className="min-w-0 truncate">{command}</span>
      <span className="ml-2 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground">
        {copied ? (
          <CheckIcon className="size-4" />
        ) : (
          <CopyIcon className="size-4" />
        )}
      </span>
    </button>
  );
}
