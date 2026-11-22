/**
 * Turntable render. Each layer is rotated, squashed for pitch, and lifted
 * one pixel above the layer under it. Ground is drawn first.
 *
 * The projection follows sprite-stacking by Daniel White
 * (https://github.com/danielwh2/sprite-stacking), MIT License.
 */
import { blank, blit, type Image } from "./image";
import type { Volume } from "./carve";

export const DIRECTIONS = 16;

export interface FrameOptions {
  squash?: number;
  spacing?: number;
  shadow?: boolean;
  outline?: boolean;
}

export function frameSize(volume: Volume, spacing = 1, squash = 0.75) {
  const diag = Math.ceil(Math.hypot(volume.width, volume.height)) + 8;
  const liftMax = Math.ceil((volume.slices - 1) * spacing);
  const width = diag + 12;
  const height = Math.ceil(diag * squash) + liftMax + 16;
  const cx = Math.floor(width / 2);
  const baseY = height - Math.ceil((diag * squash) / 2) - 6;
  return { width, height, cx, baseY };
}

function sample(
  volume: Volume,
  z: number,
  sx: number,
  sy: number,
): [number, number, number, number] | undefined {
  if (sx < 0 || sy < 0 || sx >= volume.width || sy >= volume.height) return;
  const i = ((z * volume.height + sy) * volume.width + sx) * 4;
  if (volume.data[i + 3] === 0) return;
  return [
    volume.data[i]!,
    volume.data[i + 1]!,
    volume.data[i + 2]!,
    volume.data[i + 3]!,
  ];
}

/** One crisp frame of the stacked volume. */
export function renderFrame(
  volume: Volume,
  angleDeg: number,
  options: FrameOptions = {},
): Image {
  const squash = options.squash ?? 0.75;
  const spacing = options.spacing ?? 1;
  const shadow = options.shadow ?? true;
  const outline = options.outline ?? true;
  const {
    width: cw,
    height: ch,
    cx,
    baseY,
  } = frameSize(volume, spacing, squash);
  const rad = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(rad);
  const sa = Math.sin(rad);
  const canvas = blank(cw, ch);
  const body = blank(cw, ch);
  const { width: w, height: h, slices: n } = volume;

  if (shadow) {
    for (let y = 0; y < ch; y++) {
      const dy = (y - (baseY + 3)) / squash;
      for (let x = 0; x < cw; x++) {
        const dx = x - (cx + 2);
        const sx = Math.floor(dx * ca + dy * sa + w / 2);
        const sy = Math.floor(-dx * sa + dy * ca + h / 2);
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        let hit = false;
        for (let z = 0; z < n; z++) {
          const a = volume.data[((z * h + sy) * w + sx) * 4 + 3]!;
          if (a > 0) {
            hit = true;
            break;
          }
        }
        if (!hit) continue;
        const p = (y * cw + x) * 4;
        canvas.data[p] = 186;
        canvas.data[p + 1] = 198;
        canvas.data[p + 2] = 212;
        canvas.data[p + 3] = 255;
      }
    }
  }

  for (let z = 0; z < n; z++) {
    const lift = Math.round(z * spacing);
    const origin = baseY - lift;
    for (let y = 0; y < ch; y++) {
      const dy = (y - origin) / squash;
      for (let x = 0; x < cw; x++) {
        const dx = x - cx;
        const sx = Math.floor(dx * ca + dy * sa + w / 2);
        const sy = Math.floor(-dx * sa + dy * ca + h / 2);
        const pixel = sample(volume, z, sx, sy);
        if (!pixel) continue;
        const p = (y * cw + x) * 4;
        body.data[p] = pixel[0];
        body.data[p + 1] = pixel[1];
        body.data[p + 2] = pixel[2];
        body.data[p + 3] = pixel[3];
      }
    }
  }

  const solid = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < cw &&
    y < ch &&
    body.data[(y * cw + x) * 4 + 3]! > 0;

  if (outline) {
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (solid(x, y)) continue;
        if (
          solid(x, y - 1) ||
          solid(x, y + 1) ||
          solid(x - 1, y) ||
          solid(x + 1, y)
        ) {
          const p = (y * cw + x) * 4;
          canvas.data[p] = 24;
          canvas.data[p + 1] = 28;
          canvas.data[p + 2] = 36;
          canvas.data[p + 3] = 255;
        }
      }
    }
  }

  for (let i = 3; i < body.data.length; i += 4) {
    if (body.data[i]! > 0)
      canvas.data.set(body.data.subarray(i - 3, i + 1), i - 3);
  }
  return canvas;
}

/** Sixteen frames, one full turn, packed left to right. */
export function bakeDirections(volume: Volume, directions = DIRECTIONS) {
  const frames = Array.from({ length: directions }, (_, i) =>
    renderFrame(volume, (i * 360) / directions),
  );
  const frameWidth = frames[0]!.width;
  const frameHeight = frames[0]!.height;
  const sheet = blank(frameWidth * directions, frameHeight);
  frames.forEach((frame, i) => blit(sheet, frame, i * frameWidth, 0));
  return { image: sheet, frameWidth, frameHeight, directions };
}
