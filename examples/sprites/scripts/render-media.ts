/**
 * Write the bundled sample sheets and a turntable contact sheet for the README.
 *   bun scripts/render-media.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { viewsToSlices } from "../src/carve";
import { blank, blit, type Image, type RGB } from "../src/image";
import { encodePng } from "../src/png";
import { renderFrame } from "../src/render";
import { carSheet, samplePresets, treeSheet } from "../src/samples";

const root = join(import.meta.dir, "..");

function scale(image: Image, factor: number): Image {
  const out = blank(image.width * factor, image.height * factor);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const pixel = image.data.subarray(
        (y * image.width + x) * 4,
        (y * image.width + x) * 4 + 4,
      );
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          out.data.set(
            pixel,
            ((y * factor + dy) * out.width + (x * factor + dx)) * 4,
          );
        }
      }
    }
  }
  return out;
}

function paint(image: Image, rgb: RGB) {
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = rgb[0];
    image.data[i + 1] = rgb[1];
    image.data[i + 2] = rgb[2];
    image.data[i + 3] = 255;
  }
}

function anglesOf(
  sheet: Image,
  options: Parameters<typeof viewsToSlices>[1],
  angles: number[],
) {
  const { volume } = viewsToSlices(sheet, options);
  return angles.map((angle) => scale(renderFrame(volume, angle), 4));
}

const angles = [20, 70, 120, 200, 250, 310];
const car = anglesOf(carSheet(), samplePresets.car, angles);
const tree = anglesOf(treeSheet(), samplePresets.tree, angles);
const pad = 18;
const cellW = Math.max(
  ...car.map((frame) => frame.width),
  ...tree.map((frame) => frame.width),
);
const cellH = Math.max(
  ...car.map((frame) => frame.height),
  ...tree.map((frame) => frame.height),
);
const sheet = blank(
  pad + angles.length * (cellW + pad),
  pad + 2 * (cellH + pad),
);
paint(sheet, [16, 19, 26]);
for (const [row, frames] of [car, tree].entries()) {
  frames.forEach((frame, index) => {
    const x =
      pad + index * (cellW + pad) + Math.floor((cellW - frame.width) / 2);
    const y =
      pad + row * (cellH + pad) + Math.floor((cellH - frame.height) / 2);
    blit(sheet, frame, x, y);
  });
}

mkdirSync(join(root, "media"), { recursive: true });
mkdirSync(join(root, "samples"), { recursive: true });
await Bun.write(join(root, "media/turntable.png"), encodePng(sheet));
await Bun.write(join(root, "samples/car.png"), encodePng(carSheet()));
await Bun.write(join(root, "samples/tree.png"), encodePng(treeSheet()));
console.log("wrote media/turntable.png, samples/car.png, samples/tree.png");
