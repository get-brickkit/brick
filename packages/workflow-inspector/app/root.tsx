import { TooltipProvider } from "@radix-ui/react-tooltip";
import { ThemeProvider, useTheme } from "next-themes";
import { useEffect, useRef } from "react";
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useNavigate,
  useRouteError,
  useSearchParams,
} from "react-router";
import { Toaster } from "~/components/ui/sonner";

import "./globals.css";

// Catch-all action: handles stray POST requests (e.g. from Radix UI dialogs
// that render internal <form method="dialog"> elements).
export async function action({ request }: { request: Request }) {
  const url = new URL(request.url);
  const contentType = request.headers.get("content-type") || "(none)";
  const body = await request.text().catch(() => "(unreadable)");
  console.warn(
    `[root action] Unexpected POST to ${url.pathname}`,
    `\n  Content-Type: ${contentType}`,
    `\n  Referer: ${request.headers.get("referer") || "(none)"}`,
    `\n  Body: ${body.slice(0, 500) || "(empty)"}`,
  );
  return null;
}

/**
 * Brick change. The inspector is shown in a frame of the Brick dashboard, on the
 * same origin, and takes that page's light or dark theme: the dashboard keeps it
 * as a `dark` class on its root element. Standing alone, the inspector keeps the
 * system theme.
 */
function parentRoot(): HTMLElement | null {
  try {
    return window.parent !== window
      ? window.parent.document.documentElement
      : null;
  } catch {
    return null;
  }
}

const FOLLOW_PARENT_THEME = `try{if(window.parent!==window){var d=window.parent.document.documentElement.classList.contains("dark");document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light"}}catch(e){}`;

function FollowParentTheme() {
  const { setTheme } = useTheme();
  useEffect(() => {
    const root = parentRoot();
    if (!root) return;
    const follow = () =>
      setTheme(root.classList.contains("dark") ? "dark" : "light");
    follow();
    const observer = new MutationObserver(follow);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [setTheme]);
  return null;
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Workflow Observability UI</title>
        <meta
          name="description"
          content="Web interface for inspecting flow runs, steps, streams, and events"
        />
        <Meta />
        <Links />
      </head>
      <body className="antialiased">
        {children}
        {/* Brick change: take the dashboard's theme before first paint (after next-themes' own script, which this overrides). */}
        <script dangerouslySetInnerHTML={{ __html: FOLLOW_PARENT_THEME }} />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// --- Deep-link navigation helpers (migrated from layout-client.tsx) ---

function computeDirectRunUrl(params: {
  runId: string;
  stepId: string | null;
  hookId: string | null;
}): string {
  const { runId, stepId, hookId } = params;
  if (stepId) {
    return `/run/${runId}?sidebar=step&stepId=${stepId}`;
  }
  if (hookId) {
    return `/run/${runId}?sidebar=hook&hookId=${hookId}`;
  }
  return `/run/${runId}`;
}

function computeResourceUrl(params: {
  resource: string;
  id: string;
  runId: string | null;
}): string | null {
  const { resource, id, runId } = params;
  switch (resource) {
    case "run":
      return `/run/${id}`;
    case "step":
      return runId ? `/run/${runId}?sidebar=step&stepId=${id}` : null;
    case "stream":
      return runId ? `/run/${runId}?sidebar=stream&streamId=${id}` : null;
    case "event":
      return runId ? `/run/${runId}?sidebar=event&eventId=${id}` : null;
    case "hook":
      return runId
        ? `/run/${runId}?sidebar=hook&hookId=${id}`
        : `/?sidebar=hook&hookId=${id}`;
    default:
      return null;
  }
}

function LayoutContent({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const { setTheme } = useTheme();

  const id = searchParams.get("id");
  const runId = searchParams.get("runId");
  const stepId = searchParams.get("stepId");
  const hookId = searchParams.get("hookId");
  const resource = searchParams.get("resource");
  const themeParam = searchParams.get("theme");

  const deepLinkReadRef = useRef(false);

  // Sync theme from URL param to next-themes
  useEffect(() => {
    if (
      themeParam &&
      (themeParam === "light" ||
        themeParam === "dark" ||
        themeParam === "system")
    ) {
      setTheme(themeParam);
    }
  }, [themeParam, setTheme]);

  // Deep-link navigation, once, when the page opens on the home route. The
  // router's `pathname` is relative to the base path, unlike `window.location`.
  useEffect(() => {
    if (deepLinkReadRef.current) return;
    deepLinkReadRef.current = true;
    if (pathname !== "/") return;

    if (resource) {
      if (!id) return;
      const url = computeResourceUrl({ resource, id, runId });
      if (url) {
        navigate(url);
      } else {
        console.warn(`Can't deep-link to ${resource} ${id}.`);
      }
      return;
    }

    if (runId) {
      navigate(computeDirectRunUrl({ runId, stepId, hookId }));
    }
  }, [pathname, resource, id, runId, stepId, hookId, navigate]);

  return (
    <div className="min-h-screen flex flex-col">
      <TooltipProvider delayDuration={0}>
        {/* Brick change: no header of its own. The Brick dashboard around this page has the navigation and the theme switch. */}
        {/* Scrollable Content */}
        <div className="flex-1 px-6 pt-6">{children}</div>
      </TooltipProvider>
      <Toaster />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="workflow-theme"
    >
      <FollowParentTheme />
      <LayoutContent>
        <Outlet />
      </LayoutContent>
    </ThemeProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const isNotFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">
          {isNotFound ? "404" : "Error"}
        </h1>
        <p className="text-muted-foreground mb-6">
          {isNotFound ? "This page does not exist." : "Something went wrong."}
        </p>
        <Link to="/" className="text-primary underline">
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
