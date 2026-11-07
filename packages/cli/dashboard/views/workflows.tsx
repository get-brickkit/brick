import { useEffect, useState } from "react";
import { Empty } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { ROUTES, SHELL } from "../../src/dashboard-protocol";

/**
 * The Workflow SDK's own inspector, served by the dev server at `/workflows`
 * and shown whole in a frame. Like the API reference it stays mounted once
 * opened (`hidden` only hides it), so a run you were reading is still open when
 * you come back, and after the app restarts.
 */
export function WorkflowsView({
  available,
  hidden,
}: {
  available: boolean;
  hidden: boolean;
}) {
  // The inspector stops while the app restarts; the frame keeps its page meanwhile.
  const [loaded, setLoaded] = useState(available);
  useEffect(() => {
    if (available) setLoaded(true);
  }, [available]);
  if (!loaded)
    return hidden ? null : (
      <Empty
        title="The workflow inspector is not running"
        hint="It needs a workflow listener in the app, and shows its runs once the app is up."
      />
    );
  return (
    <div className={cn("relative", hidden && "hidden")}>
      {!available && (
        <div className="absolute inset-x-0 top-0 border-b bg-background px-4 py-2 text-center text-xs text-muted-foreground">
          The workflow inspector is not running. The app may be restarting.
        </div>
      )}
      <iframe
        title="Workflow inspector"
        src={`${ROUTES.workflows.path}/`}
        className="h-[calc(100svh-3.5rem)] w-full border-0"
        onLoad={(event) => {
          // The project's theme applies to the inspector too: it uses the same tokens.
          const theme = document.querySelector(SHELL.themeLink);
          const head = event.currentTarget.contentDocument?.head;
          if (theme && head) head.append(theme.cloneNode());
        }}
      />
    </div>
  );
}
