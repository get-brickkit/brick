import * as React from "react";

const CELL = 3;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// How far each palette step mixes from the page background toward the brick accent.
const STEPS = [0, 0.14, 0.28, 0.46, 0.68];
const GLYPHS = "0123456789abcdef";

type RGB = [number, number, number];
/** Brightness in [0, 1] for a cell at (x, y), both in [0, 1]. */
export type Field = (x: number, y: number) => number;

function hex(value: string): RGB {
  const v = value.trim().replace("#", "");
  const n = parseInt(v.length === 3 ? v.replace(/./g, "$&$&") : v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// shortcut: reads hex tokens only, upgrade if --background or --gopher move to oklch.
function themeColors(el: Element) {
  const style = getComputedStyle(el);
  return {
    bg: hex(style.getPropertyValue("--background") || "#f5f5f3"),
    accent: hex(style.getPropertyValue("--gopher") || "#b45335"),
  };
}

function useThemeVersion() {
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return version;
}

/** Hashed jitter so the dither reads as texture, not as banded steps. */
function noise(x: number, y: number) {
  return ((Math.imul(x, 0x165667b1) ^ Math.imul(y, 0x27d4eb2f)) >>> 0) % 1024;
}

/** Ordered-dithered pixel gradient in the site's own paper and brick colors. */
export function DitherCanvas({
  field,
  className,
}: {
  field: Field;
  className?: string;
}) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const theme = useThemeVersion();
  const [ready, setReady] = React.useState(false);

  React.useLayoutEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !parent || !ctx) return;
    let frame = 0;

    const draw = () => {
      const cols = Math.ceil(parent.clientWidth / CELL);
      const rows = Math.ceil(parent.clientHeight / CELL);
      if (cols < 2 || rows < 2) return;
      const { bg, accent } = themeColors(canvas);
      const palette = STEPS.map(
        (t) => bg.map((c, i) => Math.round(c + (accent[i] - c) * t)) as RGB,
      );
      const image = new ImageData(cols, rows);
      const levels = palette.length - 1;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const jitter = (noise(x, y) / 1024 - 0.5) * 0.06;
          const v = Math.min(
            1,
            Math.max(0, field(x / cols, y / rows) + jitter),
          );
          const scaled = v * levels;
          const base = Math.floor(scaled);
          const step =
            scaled - base > (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16
              ? Math.min(levels, base + 1)
              : base;
          const [r, g, b] = palette[step];
          const o = (y * cols + x) * 4;
          image.data[o] = r;
          image.data[o + 1] = g;
          image.data[o + 2] = b;
          image.data[o + 3] = 255;
        }
      }
      canvas.width = cols;
      canvas.height = rows;
      ctx.putImageData(image, 0, 0);
      setReady(true);
    };

    draw();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    });
    observer.observe(parent);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [field, theme]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-ready={ready || undefined}
      className={className}
    />
  );
}

type Glyph = { x: number; y: number; ch: string; alpha: number; next: number };

/** Sparse hex characters that flip slowly over the dither. Static under reduced motion. */
export function GlyphCanvas({ className }: { className?: string }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const theme = useThemeVersion();

  React.useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !parent || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const [r, g, b] = themeColors(canvas).accent;
    let glyphs: Glyph[] = [];
    let frame = 0;
    let visible = false;
    let last = performance.now();
    const pick = () => GLYPHS[(Math.random() * 16) | 0];

    const layout = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      glyphs = [];
      for (let y = 18; y < h; y += 18) {
        for (let x = 4; x < w; x += 18) {
          if (Math.random() > 0.22) continue;
          // Glyphs grow brighter toward the bottom, where the glow is.
          const depth = y / h;
          glyphs.push({
            x,
            y,
            ch: pick(),
            alpha: 0.04 + depth * depth * 0.22 * Math.random(),
            next: 700 + Math.random() * 3000,
          });
        }
      }
      paint(0);
    };

    const paint = (dt: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
      for (const glyph of glyphs) {
        glyph.next -= dt;
        if (glyph.next <= 0) {
          glyph.ch = pick();
          glyph.next = 700 + Math.random() * 3000;
        }
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${glyph.alpha})`;
        ctx.fillText(glyph.ch, glyph.x, glyph.y);
      }
    };

    const tick = (now: number) => {
      // Characters flip on their own timers, so ~10 fps is plenty.
      if (now - last > 100) {
        paint(now - last);
        last = now;
      }
      if (visible) frame = requestAnimationFrame(tick);
    };

    layout();
    const resize = new ResizeObserver(layout);
    resize.observe(parent);
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting && !still;
      cancelAnimationFrame(frame);
      if (visible) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }
    });
    seen.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      seen.disconnect();
    };
  }, [theme]);

  return <canvas ref={ref} aria-hidden="true" className={className} />;
}
