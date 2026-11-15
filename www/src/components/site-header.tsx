import { ArrowRightIcon } from "lucide-react";
import { Link, useLocation } from "@tanstack/react-router";
import { GitHubIcon } from "@/components/icons";
import { Wordmark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { site } from "@/lib/site";

const navLink =
  "text-muted-foreground transition-colors hover:text-foreground data-current:text-foreground data-current:font-medium";

export function SiteHeader() {
  const pathname = useLocation({ select: (l) => l.pathname });
  return (
    <header
      id="site-top"
      className="frame sticky top-0 z-40 flex flex-wrap items-center gap-x-8 gap-y-3 border-b bg-background/95 py-5 backdrop-blur-xl"
    >
      <Link to="/">
        <Wordmark />
      </Link>
      <nav className="order-3 flex w-full flex-wrap items-center gap-x-6 gap-y-3 text-sm sm:order-none sm:w-auto">
        <a
          href={pathname === "/" ? "#platform" : "/#platform"}
          className={navLink}
        >
          Platform
        </a>
        <Link
          to="/docs/$"
          params={{ _splat: "" }}
          className={navLink}
          data-current={pathname.startsWith("/docs") || undefined}
        >
          Docs
        </Link>
        <Link
          to="/examples"
          className={navLink}
          data-current={pathname.startsWith("/examples") || undefined}
        >
          Examples
        </Link>
        <Link
          to="/blog"
          className={navLink}
          data-current={pathname.startsWith("/blog") || undefined}
        >
          Blog
        </Link>
      </nav>
      <div className="header-actions ml-auto flex items-center gap-2">
        <Link
          to="/docs/$"
          params={{ _splat: "quickstart" }}
          className="home-button home-button-primary header-cta"
        >
          Get started <ArrowRightIcon className="size-3" />
        </Link>
        <a
          href={site.repo}
          aria-label="GitHub"
          target="_blank"
          rel="noreferrer"
          data-umami-event="github-click"
          data-umami-event-location="header"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
        >
          <GitHubIcon className="size-4" />
        </a>
        <ThemeToggle />
      </div>
    </header>
  );
}
