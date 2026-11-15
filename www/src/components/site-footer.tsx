import { Link } from "@tanstack/react-router";
import { Wordmark } from "@/components/logo";
import {
  DitherCanvas,
  GlyphCanvas,
  type Field,
} from "@/components/pixel-field";
import { site } from "@/lib/site";

// Glow rises from the bottom edge, under the wordmark.
const footerField: Field = (_x, y) => y ** 1.6 * 0.8;

export function SiteFooter() {
  return (
    <footer className="frame home-footer">
      <div className="home-footer-top">
        <div className="footer-brand">
          <Link to="/" aria-label="Brick home">
            <Wordmark />
          </Link>
          <p>TypeScript definitions. Production execution.</p>
        </div>
        <div className="footer-chips">
          <Link to="/docs/$" params={{ _splat: "for-ai-agents" }}>
            For AI agents
          </Link>
          <a href="/llms.txt">llms.txt</a>
          <a href="/llms-full.txt">llms-full.txt</a>
        </div>
      </div>
      <div className="home-footer-main">
        <nav aria-label="Platform links">
          <h2>Platform</h2>
          <Link to="/docs/$" params={{ _splat: "resources" }}>
            Resources
          </Link>
          <Link to="/docs/$" params={{ _splat: "access-control" }}>
            Access control
          </Link>
          <Link to="/docs/$" params={{ _splat: "migrations" }}>
            Databases
          </Link>
          <Link to="/docs/$" params={{ _splat: "plugins" }}>
            Extensions
          </Link>
        </nav>
        <nav aria-label="Developer links">
          <h2>Developers</h2>
          <Link to="/docs/$" params={{ _splat: "quickstart" }}>
            Getting started
          </Link>
          <Link to="/docs/$" params={{ _splat: "" }}>
            Documentation
          </Link>
          <Link to="/examples">Examples</Link>
          <Link to="/blog">Blog</Link>
        </nav>
        <nav aria-label="Project links">
          <h2>Project</h2>
          <a
            href={site.repo}
            target="_blank"
            rel="noreferrer"
            data-umami-event="github-click"
            data-umami-event-location="footer"
          >
            GitHub
          </a>
          <a
            href={`${site.repo}/releases`}
            target="_blank"
            rel="noreferrer"
            data-umami-event="github-click"
            data-umami-event-location="footer-releases"
          >
            Releases
          </a>
          <a
            href={`${site.repo}/issues`}
            target="_blank"
            rel="noreferrer"
            data-umami-event="github-click"
            data-umami-event-location="footer-issues"
          >
            Issues
          </a>
          <Link to="/brand">Brand assets</Link>
        </nav>
      </div>
      <div className="home-footer-bottom">
        <p>
          Brick v{site.version}
          <span aria-hidden="true">·</span>
          <a
            href={`${site.repo}/blob/main/LICENSE`}
            target="_blank"
            rel="noreferrer"
          >
            MIT licensed
          </a>
        </p>
        <p>
          Privacy-friendly, cookieless analytics by Umami.
          <span aria-hidden="true">·</span>
          <a href="#site-top">Back to top ↑</a>
        </p>
      </div>
      <div className="footer-wordmark" aria-hidden="true">
        <DitherCanvas field={footerField} className="footer-dither" />
        <GlyphCanvas className="footer-glyphs" />
        <div className="footer-wordmark-clip">
          <p>brick.ts</p>
        </div>
      </div>
    </footer>
  );
}
