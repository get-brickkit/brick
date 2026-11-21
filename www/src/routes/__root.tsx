import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useLocation,
  useRouterState,
} from "@tanstack/react-router";
import * as React from "react";
import appCss from "@/styles/app.css?url";
import { RootProvider } from "@fumadocs/base-ui/provider/tanstack";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { site } from "@/lib/site";
import { marketingPages, socialMeta } from "@/lib/social";

const shellMeta = [
  { charSet: "utf-8" },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
  {
    name: "theme-color",
    media: "(prefers-color-scheme: light)",
    content: "#ffffff",
  },
  {
    name: "theme-color",
    media: "(prefers-color-scheme: dark)",
    content: "#000000",
  },
];

const shellLinks = [
  { rel: "stylesheet", href: appCss },
  { rel: "icon", type: "image/svg+xml", href: "/brand/logo.svg" },
];

const analytics = [
  {
    defer: true,
    src: "https://unami.rega.run/script.js",
    "data-website-id": "40d976e9-29ab-42b6-a777-b3a126a87e19",
    "data-domains": new URL(site.url).hostname,
  },
];

function isNotFoundPage(
  matches: readonly { status: string; _notFound?: boolean }[],
) {
  return matches.some(
    (match) => match.status === "notFound" || match._notFound,
  );
}

export const Route = createRootRoute({
  head: ({ matches }) => {
    if (isNotFoundPage(matches)) {
      return {
        meta: [
          { title: "Page not found" },
          { name: "robots", content: "noindex" },
          ...shellMeta,
        ],
        links: shellLinks,
        scripts: analytics,
      };
    }
    return {
      meta: [
        ...socialMeta({ ...marketingPages["/"], path: "/" }),
        ...shellMeta,
      ],
      links: shellLinks,
      scripts: analytics,
    };
  },
  headers: ({ matches }) =>
    isNotFoundPage(matches) ? { "X-Robots-Tag": "noindex" } : undefined,
  component: RootComponent,
});

function RootComponent() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const notFound = useRouterState({
    select: (state) => isNotFoundPage(state.matches),
  });
  const isDocs = pathname.startsWith("/docs");
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {notFound ? null : (
          <link
            rel="canonical"
            href={new URL(pathname.replace(/\/+$/, "") || "/", site.url).href}
          />
        )}
      </head>
      <body className="flex min-h-screen flex-col bg-background text-foreground antialiased">
        <RootProvider>
          {isDocs ? (
            <div className="brick-site brick-docs-site flex min-h-svh flex-col">
              <Outlet />
            </div>
          ) : (
            <div className="brick-site flex min-h-svh flex-col">
              <SiteHeader />
              <div className="frame flex flex-1 flex-col">
                <Outlet />
              </div>
              <SiteFooter />
            </div>
          )}
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
