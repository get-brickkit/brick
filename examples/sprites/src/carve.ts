/**
 * Sprite stacking: four orthographic views become a fake-3D volume.
 *
 * A voxel survives only where the top, side, front, and back views all cover
 * it. The volume is cut into flat layers, ground first. Rendering rotates each
 * layer, squashes it for pitch, and lifts it by one pixel.
 *
 * The algorithm is a fresh TypeScript port of sprite-stacking by Daniel White
 * (https://github.com/danielwh2/sprite-stacking), used under the MIT License.
 */
import {
  blank,
  clone,
  crop,
  flipX,
  flipY,
  resize,
  type Image,
  type RGB,
} from "./image";

export class StackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackError";
  }
}

/** Layers of RGBA voxels. Index 0 is the ground. `height` is length, `width` is width. */
export interface Volume {
  slices: number;
  height: number;
  width: number;
  data: Uint8Array;
}

export interface StackOptions {
  /** Layer count. Omit for auto (native, or 36 when the side view is taller than 64). 0 keeps the sheet height. */
  slices?: number;
  /** Nose of the top view before alignment. */
  topNose?: "auto" | "up" | "down";
  /** Which way the side view faces in the sheet. */
  sideNose?: "left" | "right";
  /** `reading` takes the row as top, side, front, back. `auto` matches views by proportion. */
  order?: "auto" | "reading";
  /** Shared palette size. 0 keeps every color. */
  palette?: number;
  /** Darken side faces toward the ground. 0 is flat. */
  shade?: number;
  /** Luminance cutoff for stripping a 1px dark outline. 0 disables it. */
  dark?: number;
  /** Color distance for flood-filling a flat background. */
  bgTol?: number;
  /** Lathe each solid layer into the ellipse its side and front spans describe. */
  round?: boolean;
}

const DEFAULTS = {
  topNose: "auto",
  sideNose: "left",
  order: "reading",
  palette: 24,
  shade: 0.2,
  dark: 70,
  bgTol: 28,
  round: false,
} as const;

function opaque(image: Image, x: number, y: number): boolean {
  return image.data[(y * image.width + x) * 4 + 3]! >= 128;
}

function maskOf(image: Image): Uint8Array {
  const mask = new Uint8Array(image.width * image.height);
  for (let i = 0; i < mask.length; i++)
    mask[i] = image.data[i * 4 + 3]! >= 128 ? 1 : 0;
  return mask;
}

/** Keep an existing alpha mask, or flood-fill a flat border color. */
export function removeBackground(image: Image, tol = 28): Image {
  const out = clone(image);
  const { width: w, height: h, data } = out;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 128) transparent++;
  if (transparent / (w * h) > 0.05) {
    for (let i = 3; i < data.length; i += 4)
      data[i] = data[i]! >= 128 ? 255 : 0;
    return out;
  }
  const corner = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!] as RGB;
  };
  const corners = [
    corner(0, 0),
    corner(w - 1, 0),
    corner(0, h - 1),
    corner(w - 1, h - 1),
  ];
  const bg: RGB = [0, 1, 2].map((channel) => {
    const values = corners.map((rgb) => rgb[channel]).sort((a, b) => a - b);
    return Math.round((values[1]! + values[2]!) / 2);
  }) as RGB;
  const close = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dist = Math.max(
        Math.abs(data[i]! - bg[0]),
        Math.abs(data[i + 1]! - bg[1]),
        Math.abs(data[i + 2]! - bg[2]),
      );
      if (dist <= tol) close[y * w + x] = 1;
    }
  }
  const bgMask = new Uint8Array(w * h);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * w + x;
    if (!close[i] || bgMask[i]) return;
    bgMask[i] = 1;
    queue.push(i);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    push(0, y);
    push(w - 1, y);
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    const x = i % w;
    const y = (i - x) / w;
    if (y > 0) push(x, y - 1);
    if (y + 1 < h) push(x, y + 1);
    if (x > 0) push(x - 1, y);
    if (x + 1 < w) push(x + 1, y);
  }
  for (let i = 0; i < w * h; i++) data[i * 4 + 3] = bgMask[i] ? 0 : 255;
  return out;
}

function dilate(
  mask: Uint8Array,
  w: number,
  h: number,
  steps: number,
): Uint8Array {
  let cur = mask;
  for (let s = 0; s < steps; s++) {
    const next = cur.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!cur[y * w + x]) continue;
        if (y > 0) next[(y - 1) * w + x] = 1;
        if (y + 1 < h) next[(y + 1) * w + x] = 1;
        if (x > 0) next[y * w + (x - 1)] = 1;
        if (x + 1 < w) next[y * w + (x + 1)] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
}

/** Locate the four views, dropping specks. Order is top, side, front, back. */
export function findViews(sheet: Image, order: "auto" | "reading"): Image[] {
  const { width: w, height: h } = sheet;
  const solid = maskOf(sheet);
  const steps = Math.max(2, Math.min(6, Math.round(Math.min(h, w) / 260)));
  const grown = dilate(solid, w, h, steps);
  const seen = new Uint8Array(grown.length);
  const boxes: Box[] = [];
  for (let start = 0; start < grown.length; start++) {
    if (!grown[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let minX = start % w;
    let maxX = minX;
    let minY = (start - minX) / w;
    let maxY = minY;
    let count = 0;
    while (stack.length) {
      const i = stack.pop()!;
      count++;
      const x = i % w;
      const y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const visit = (xx: number, yy: number) => {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) return;
        const j = yy * w + xx;
        if (!grown[j] || seen[j]) return;
        seen[j] = 1;
        stack.push(j);
      };
      visit(x + 1, y);
      visit(x - 1, y);
      visit(x, y + 1);
      visit(x, y - 1);
    }
    if (count > 40)
      boxes.push({ x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1, count });
  }
  if (!boxes.length)
    throw new StackError(
      "No foreground drawings found. Check the background or the alpha.",
    );
  const big = Math.max(
    ...boxes.map((box) => (box.x1 - box.x0) * (box.y1 - box.y0)),
  );
  const kept = boxes.filter(
    (box) => (box.x1 - box.x0) * (box.y1 - box.y0) >= 0.14 * big,
  );
  const rowBand = Math.max(1, h / 2.2);
  kept.sort((a, b) => {
    const rowA = Math.round((a.y0 + a.y1) / 2 / rowBand);
    const rowB = Math.round((b.y0 + b.y1) / 2 / rowBand);
    return rowA - rowB || a.x0 - b.x0;
  });
  if (kept.length !== 4) {
    const summary = kept
      .map((box) => `${box.x1 - box.x0}x${box.y1 - box.y0}`)
      .join(", ");
    throw new StackError(
      `Found ${kept.length} drawings (${summary || "none"}), expected 4: top, side, front, back.`,
    );
  }
  const views = kept.map((box) => {
    let minX = box.x1;
    let maxX = box.x0 - 1;
    let minY = box.y1;
    let maxY = box.y0 - 1;
    for (let y = box.y0; y < box.y1; y++) {
      for (let x = box.x0; x < box.x1; x++) {
        if (!opaque(sheet, x, y)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const view = crop(sheet, minX, minY, maxX - minX + 1, maxY - minY + 1);
    for (let i = 3; i < view.data.length; i += 4)
      view.data[i] = view.data[i]! >= 128 ? 255 : 0;
    return view;
  });
  if (order === "reading") return views;
  return orderByProportion(views);
}

function logRatio(a: number, b: number): number {
  return Math.abs(Math.log(a / b));
}

function proportionError(views: Image[], top: number, side: number): number {
  const tv = views[top]!;
  const sv = views[side]!;
  let extra = 0;
  let rest = 0;
  for (let i = 0; i < 4; i++) {
    if (i === top || i === side) continue;
    const face = views[i]!;
    extra += logRatio(tv.width, face.width) + logRatio(sv.height, face.height);
    rest++;
  }
  return logRatio(tv.height, sv.width) + (rest ? extra / rest : 0);
}

function orderByProportion(views: Image[]): Image[] {
  const pairs: [number, number][] = [];
  for (let top = 0; top < 4; top++) {
    for (let side = 0; side < 4; side++)
      if (top !== side) pairs.push([top, side]);
  }
  let best = Infinity;
  for (const [top, side] of pairs) {
    best = Math.min(best, proportionError(views, top, side));
  }
  const chosen = pairs.find(
    ([top, side]) => proportionError(views, top, side) <= best + 0.1,
  )!;
  const rest = views.filter(
    (_, index) => index !== chosen[0] && index !== chosen[1],
  );
  return [views[chosen[0]]!, views[chosen[1]]!, rest[0]!, rest[1]!];
}

/** Replace a 1px dark outer contour with the color of an interior neighbor. */
export function stripOutline(view: Image, dark: number): Image {
  if (dark <= 0) return view;
  const { width: w, height: h, data } = view;
  const solid = maskOf(view);
  const line = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!solid[i]) continue;
      let enclosed = true;
      for (let dy = -1; dy <= 1 && enclosed; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !solid[yy * w + xx])
            enclosed = false;
        }
      }
      if (enclosed) continue;
      const p = i * 4;
      const lum = (data[p]! + data[p + 1]! + data[p + 2]!) / 3;
      if (lum < dark) line[i] = 1;
    }
  }
  const out = clone(view);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!line[i]) continue;
      for (const [dy, dx] of dirs) {
        const yy = y + dy!;
        const xx = x + dx!;
        if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
        const j = yy * w + xx;
        if (solid[j] && !line[j]) {
          out.data.set(data.subarray(j * 4, j * 4 + 4), i * 4);
          break;
        }
      }
    }
  }
  return out;
}

function medianCut(colors: RGB[], count: number): RGB[] {
  let boxes: RGB[][] = [colors];
  while (boxes.length < count) {
    let best = -1;
    let range = -1;
    let channel = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      if (box.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let min = 255;
        let max = 0;
        for (const rgb of box) {
          if (rgb[c] < min) min = rgb[c];
          if (rgb[c] > max) max = rgb[c];
        }
        if (max - min > range) {
          range = max - min;
          best = i;
          channel = c;
        }
      }
    }
    if (range <= 0 || best < 0) break;
    const box = boxes[best]!.slice().sort((a, b) => a[channel]! - b[channel]!);
    const mid = Math.floor(box.length / 2);
    boxes = [
      ...boxes.slice(0, best),
      box.slice(0, mid),
      box.slice(mid),
      ...boxes.slice(best + 1),
    ];
  }
  return boxes.map((box) => {
    const sum: RGB = [0, 0, 0];
    for (const rgb of box) {
      sum[0] += rgb[0];
      sum[1] += rgb[1];
      sum[2] += rgb[2];
    }
    return [
      Math.round(sum[0] / box.length),
      Math.round(sum[1] / box.length),
      Math.round(sum[2] / box.length),
    ];
  });
}

/** Quantize every view onto one shared palette, without dithering. */
export function onePalette(views: Image[], count: number): Image[] {
  if (count <= 0) return views;
  const seen = new Map<number, RGB>();
  for (const view of views) {
    for (let i = 0; i < view.data.length; i += 4) {
      if (view.data[i + 3] === 0) continue;
      const rgb: RGB = [
        Math.floor(view.data[i]! / 6) * 6 + 3,
        Math.floor(view.data[i + 1]! / 6) * 6 + 3,
        Math.floor(view.data[i + 2]! / 6) * 6 + 3,
      ];
      seen.set((rgb[0] << 16) | (rgb[1] << 8) | rgb[2], rgb);
    }
  }
  const colors = [...seen.values()];
  if (!colors.length) return views;
  const palette = colors.length <= count ? colors : medianCut(colors, count);
  return views.map((view) => {
    const out = clone(view);
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i + 3] === 0) continue;
      let best = 0;
      let bestDist = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const rgb = palette[p]!;
        const dist =
          (out.data[i]! - rgb[0]) ** 2 +
          (out.data[i + 1]! - rgb[1]) ** 2 +
          (out.data[i + 2]! - rgb[2]) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
      const rgb = palette[best]!;
      out.data[i] = rgb[0];
      out.data[i + 1] = rgb[1];
      out.data[i + 2] = rgb[2];
    }
    return out;
  });
}

function rowSpan(
  mask: Uint8Array,
  row: number,
  width: number,
): [number, number] | undefined {
  let first = -1;
  let last = -1;
  const start = row * width;
  for (let x = 0; x < width; x++) {
    if (!mask[start + x]) continue;
    if (first < 0) first = x;
    last = x;
  }
  return first < 0 ? undefined : [first, last];
}

function spanSolid(mask: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i <= to; i++) if (!mask[i]) return false;
  return true;
}

/**
 * Visual-hull carve.
 * `top` is length x width, `side` is height x length, `front` and `back` are height x width.
 * Returns slices `[z, y, x]`, z = 0 on the ground.
 */
export function carve(
  top: Image,
  side: Image,
  front: Image,
  back: Image,
  options?: { shade?: number; round?: boolean },
): Volume {
  const shade = options?.shade ?? 0;
  const round = options?.round ?? false;
  const L = top.height;
  const W = top.width;
  const H = side.height;
  if (
    side.width !== L ||
    front.height !== H ||
    front.width !== W ||
    back.height !== H ||
    back.width !== W
  ) {
    throw new StackError(
      "view sizes do not agree: top is length x width, side is height x length, front and back are height x width",
    );
  }
  const topMask = maskOf(top);
  const sideMask = maskOf(side);
  const frontMask = maskOf(front);
  const backMask = maskOf(back);
  const occ = new Uint8Array(H * L * W);
  for (let z = 0; z < H; z++) {
    const row = H - 1 - z;
    const along = sideMask.subarray(row * L, (row + 1) * L);
    const acrossF = frontMask.subarray(row * W, (row + 1) * W);
    const acrossB = backMask.subarray(row * W, (row + 1) * W);
    let alongAny = false;
    let acrossAny = false;
    for (let i = 0; i < L; i++) if (along[i]) alongAny = true;
    for (let i = 0; i < W; i++) if (acrossF[i] || acrossB[i]) acrossAny = true;
    const base = z * L * W;
    for (let y = 0; y < L; y++) {
      if (!along[y]) continue;
      for (let x = 0; x < W; x++) {
        if (!topMask[y * W + x]) continue;
        if (acrossF[x] || acrossB[x]) occ[base + y * W + x] = 1;
      }
    }
    if (!round || !alongAny || !acrossAny) continue;
    let y0 = -1;
    let y1 = -1;
    let x0 = -1;
    let x1 = -1;
    for (let y = 0; y < L; y++)
      if (along[y]) {
        if (y0 < 0) y0 = y;
        y1 = y;
      }
    for (let x = 0; x < W; x++)
      if (acrossF[x] || acrossB[x]) {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    if (
      !spanSolid(along, y0, y1) ||
      !spanSolid(
        Uint8Array.from({ length: W }, (_, x) =>
          acrossF[x] || acrossB[x] ? 1 : 0,
        ),
        x0,
        x1,
      )
    ) {
      continue;
    }
    const cy = (y0 + y1) / 2;
    const cx = (x0 + x1) / 2;
    const ry = (y1 - y0) / 2 + 0.5;
    const rx = (x1 - x0) / 2 + 0.5;
    for (let y = 0; y < L; y++) {
      for (let x = 0; x < W; x++) {
        const i = base + y * W + x;
        if (!occ[i]) continue;
        const ey = (y - cy) / ry;
        const ex = (x - cx) / rx;
        if (ey * ey + ex * ex >= 1) occ[i] = 0;
      }
    }
  }

  const data = new Uint8Array(H * L * W * 4);
  const covered = new Uint8Array(L * W);
  for (let z = H - 1; z >= 0; z--) {
    const row = H - 1 - z;
    const base = z * L * W;
    const above = covered.slice();
    let any = false;
    for (let i = 0; i < L * W; i++) {
      if (occ[base + i]) {
        covered[i] = 1;
        any = true;
      }
    }
    if (!any) continue;
    const depth = new Uint16Array(L * W);
    const face = new Uint8Array(L * W);
    const left = new Int16Array(L * W).fill(-1);
    const right = new Int16Array(L * W).fill(W);
    const up = new Int16Array(L * W).fill(-1);
    const down = new Int16Array(L * W).fill(L);
    for (let y = 0; y < L; y++) {
      let runL = -1;
      let runR = W;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!occ[base + i]) runL = x;
        left[i] = runL;
      }
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        if (!occ[base + i]) runR = x;
        right[i] = runR;
      }
    }
    for (let x = 0; x < W; x++) {
      let runU = -1;
      let runD = L;
      for (let y = 0; y < L; y++) {
        const i = y * W + x;
        if (!occ[base + i]) runU = y;
        up[i] = runU;
      }
      for (let y = L - 1; y >= 0; y--) {
        const i = y * W + x;
        if (!occ[base + i]) runD = y;
        down[i] = runD;
      }
    }
    for (let y = 0; y < L; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const distances = [
          x - left[i]!,
          right[i]! - x,
          y - up[i]!,
          down[i]! - y,
        ];
        let best = 0;
        for (let d = 1; d < 4; d++)
          if (distances[d]! < distances[best]!) best = d;
        face[i] = best;
        depth[i] = distances[best]!;
      }
    }
    const nearAbove = new Uint8Array(L * W);
    for (let y = 0; y < L; y++) {
      for (let x = 0; x < W; x++) {
        let hit = 0;
        for (let dy = -2; dy <= 2 && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= L) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < W && above[yy * W + xx]) {
              hit = 1;
              break;
            }
          }
        }
        nearAbove[y * W + x] = hit;
      }
    }
    const sideRow = edgeRow(side, row, L);
    const backRow = edgeRow(back, row, W);
    const frontRow = edgeRow(front, row, W);
    for (let y = 0; y < L; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!occ[base + i]) continue;
        const steep = !above[i] && depth[i]! <= 2 && nearAbove[i] === 1;
        const useTop = !above[i] && !steep;
        const aboveIndex = (z + 1) * L * W + i;
        const useAbove =
          z + 1 < H &&
          above[i] === 1 &&
          depth[i]! > 2 &&
          data[aboveIndex * 4 + 3]! > 0;
        let rgb: RGB;
        if (useAbove) {
          const p = aboveIndex * 4;
          rgb = [data[p]!, data[p + 1]!, data[p + 2]!];
        } else if (useTop) {
          const p = (y * W + x) * 4;
          rgb = [top.data[p]!, top.data[p + 1]!, top.data[p + 2]!];
        } else if (face[i]! < 2 && sideRow) {
          rgb = sideRow[y]!;
        } else if (face[i] === 2 && backRow) {
          rgb = backRow[x]!;
        } else if (face[i]! > 2 && frontRow) {
          rgb = frontRow[x]!;
        } else {
          const p = (y * W + x) * 4;
          rgb = [top.data[p]!, top.data[p + 1]!, top.data[p + 2]!];
        }
        if (shade && (above[i] || steep) && depth[i]! <= 2) {
          const factor = 1 - shade * (1 - z / Math.max(H - 1, 1)) - shade * 0.4;
          rgb = [
            clampByte(rgb[0] * factor),
            clampByte(rgb[1] * factor),
            clampByte(rgb[2] * factor),
          ];
        }
        const p = (base + i) * 4;
        data[p] = rgb[0];
        data[p + 1] = rgb[1];
        data[p + 2] = rgb[2];
        data[p + 3] = 255;
      }
    }
  }
  return { slices: H, height: L, width: W, data };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Opaque colors along one view row, clamped to the opaque span. */
function edgeRow(view: Image, row: number, length: number): RGB[] | undefined {
  const span = rowSpan(maskOf(view), row, view.width);
  if (!span) return undefined;
  const colors: RGB[] = [];
  for (let i = 0; i < length; i++) {
    const x = Math.min(span[1], Math.max(span[0], i));
    const p = (row * view.width + x) * 4;
    colors.push([view.data[p]!, view.data[p + 1]!, view.data[p + 2]!]);
  }
  return colors;
}

function matchTop(top: Image, side: Image): "down" | "up" {
  const tall = new Float64Array(side.width);
  let max = 0;
  for (let x = 0; x < side.width; x++) {
    let count = 0;
    for (let y = 0; y < side.height; y++) if (opaque(side, x, y)) count++;
    tall[x] = count;
    if (count > max) max = count;
  }
  const mapped = new Float64Array(top.height);
  for (let i = 0; i < top.height; i++) {
    const pos =
      top.height === 1 ? 0 : (i * (tall.length - 1)) / (top.height - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(tall.length - 1, i0 + 1);
    const f = pos - i0;
    mapped[i] = tall[i0]! * (1 - f) + tall[i1]! * f;
  }
  const dark = new Float64Array(top.height);
  for (let y = 0; y < top.height; y++) {
    let count = 0;
    for (let x = 0; x < top.width; x++) {
      const p = (y * top.width + x) * 4;
      const sum = top.data[p]! + top.data[p + 1]! + top.data[p + 2]!;
      if (top.data[p + 3]! > 0 && sum < 240) count++;
    }
    dark[y] = count / top.width;
  }
  let current = 0;
  let flipped = 0;
  for (let i = 0; i < top.height; i++) {
    if (mapped[i]! < 0.8 * max) continue;
    current += dark[i]!;
    flipped += dark[top.height - 1 - i]!;
  }
  return current >= flipped ? "down" : "up";
}

export interface Carved {
  volume: Volume;
  views: Image[];
}

/** Full pipeline: background, four views, align, palette, carve. */
export function viewsToSlices(
  sheet: Image,
  options: StackOptions = {},
): Carved {
  const topNose = options.topNose ?? DEFAULTS.topNose;
  const sideNose = options.sideNose ?? DEFAULTS.sideNose;
  const order = options.order ?? DEFAULTS.order;
  const palette = options.palette ?? DEFAULTS.palette;
  const shade = options.shade ?? DEFAULTS.shade;
  const dark = options.dark ?? DEFAULTS.dark;
  const round = options.round ?? DEFAULTS.round;
  const clean = removeBackground(sheet, options.bgTol ?? DEFAULTS.bgTol);
  const raw = findViews(clean, order);
  let [top, side, front, back] = raw as [Image, Image, Image, Image];
  let sideAligned = sideNose === "left" ? flipX(side) : side;
  const rawH = side.height;
  const targetH =
    options.slices === undefined
      ? rawH > 64
        ? 36
        : rawH
      : options.slices === 0
        ? rawH
        : options.slices;
  let L: number;
  let W: number;
  let H: number;
  if (targetH !== rawH) {
    L = Math.max(4, Math.round((targetH * side.width) / side.height));
    W = Math.max(4, Math.round((L * top.width) / top.height));
    H = targetH;
  } else {
    L = top.height;
    W = top.width;
    H = Math.max(2, Math.round((side.height * L) / side.width));
  }
  top = resize(top, W, L);
  sideAligned = resize(sideAligned, L, H);
  front = resize(front, W, H);
  back = resize(flipX(back), W, H);
  const cleaned = [top, sideAligned, front, back].map((view) =>
    stripOutline(view, dark),
  );
  [top, sideAligned, front, back] = onePalette(cleaned, palette) as [
    Image,
    Image,
    Image,
    Image,
  ];
  let nose = topNose;
  if (nose === "auto") nose = matchTop(top, sideAligned);
  if (nose === "up") top = flipY(top);
  const volume = carve(top, sideAligned, front, back, { shade, round });
  if (!volume.data.some((value, index) => index % 4 === 3 && value > 0))
    throw new StackError(
      "The four views do not overlap, so the carve is empty.",
    );
  return {
    volume,
    views: [
      top,
      sideNose === "left" ? flipX(sideAligned) : sideAligned,
      front,
      flipX(back),
    ],
  };
}

/** Horizontal strip, ground slice on the left. Height is the length axis. */
export function volumeStrip(volume: Volume): Image {
  const { slices, height, width, data } = volume;
  const image = blank(width * slices, height);
  for (let z = 0; z < slices; z++) {
    for (let y = 0; y < height; y++) {
      const src = (z * height + y) * width * 4;
      const dest = (y * image.width + z * width) * 4;
      image.data.set(data.subarray(src, src + width * 4), dest);
    }
  }
  return image;
}
