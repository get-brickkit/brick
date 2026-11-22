/**
 * Bundled 4-view sheets, drawn in code so the demo runs without an asset pipeline.
 * Each sheet is one row: top, side, front, back.
 */
import {
  blank,
  fillEllipse,
  fillRect,
  rowSheet,
  type Image,
  type RGB,
} from "./image";
import type { StackOptions } from "./carve";

export const SAMPLE_NAMES = ["car", "tree"] as const;
export type SampleName = (typeof SAMPLE_NAMES)[number];

export function isSampleName(value: string): value is SampleName {
  return (SAMPLE_NAMES as readonly string[]).includes(value);
}

const RED: RGB = [214, 64, 78];
const CREAM: RGB = [244, 220, 196];
const GLASS: RGB = [64, 104, 132];
const TIRE: RGB = [36, 38, 46];
const HUB: RGB = [196, 198, 204];
const LAMP: RGB = [255, 208, 72];
const TAIL: RGB = [255, 96, 64];

const LEAF: RGB = [58, 140, 72];
const LEAF_DARK: RGB = [36, 104, 58];
const LEAF_LIT: RGB = [122, 186, 90];
const TRUNK: RGB = [138, 92, 52];
const TRUNK_DARK: RGB = [96, 62, 36];

/**
 * Presets applied when a bundled sample is stacked and the caller leaves
 * the matching option unset. `dark: 0` keeps the tires and the trunk, which
 * are darker than the outline stripper's default cutoff.
 */
export const samplePresets: Record<SampleName, StackOptions> = {
  car: {
    round: false,
    order: "reading",
    sideNose: "left",
    topNose: "down",
    palette: 0,
    dark: 0,
  },
  tree: {
    round: true,
    order: "reading",
    sideNose: "left",
    topNose: "down",
    palette: 0,
    dark: 0,
  },
};

function view(width: number, height: number): Image {
  return blank(width, height);
}

/** Side faces left. Wheels are four separate voxels once the front view cuts them. */
export function carViews(): [Image, Image, Image, Image] {
  const H = 16;
  const L = 32;
  const W = 14;
  const side = view(L, H);
  fillRect(side, 10, 2, 11, 2, CREAM);
  fillRect(side, 9, 4, 13, 3, GLASS);
  fillRect(side, 6, 7, 21, 1, RED);
  fillRect(side, 1, 8, 29, 4, RED);
  fillRect(side, 0, 8, 3, 2, LAMP);
  fillRect(side, 4, 12, 7, 4, TIRE);
  fillRect(side, 20, 12, 7, 4, TIRE);
  fillRect(side, 6, 13, 3, 2, HUB);
  fillRect(side, 22, 13, 3, 2, HUB);

  const top = view(W, L);
  fillRect(top, 0, 1, W, 30, RED);
  fillRect(top, 2, 10, W - 4, 12, GLASS);
  fillRect(top, 1, 1, 3, 2, LAMP);
  fillRect(top, W - 4, 1, 3, 2, LAMP);
  fillRect(top, 1, 28, 3, 2, TAIL);
  fillRect(top, W - 4, 28, 3, 2, TAIL);

  const front = view(W, H);
  fillRect(front, 4, 2, 6, 2, CREAM);
  fillRect(front, 3, 4, 8, 3, GLASS);
  fillRect(front, 2, 7, 10, 1, RED);
  fillRect(front, 1, 8, 12, 4, RED);
  fillRect(front, 2, 8, 3, 2, LAMP);
  fillRect(front, 9, 8, 3, 2, LAMP);
  fillRect(front, 0, 12, 5, 4, TIRE);
  fillRect(front, 9, 12, 5, 4, TIRE);
  fillRect(front, 1, 13, 3, 2, HUB);
  fillRect(front, 10, 13, 3, 2, HUB);

  const back = view(W, H);
  fillRect(back, 4, 2, 6, 2, CREAM);
  fillRect(back, 3, 4, 8, 3, GLASS);
  fillRect(back, 2, 7, 10, 1, RED);
  fillRect(back, 1, 8, 12, 4, RED);
  fillRect(back, 1, 9, 3, 2, TAIL);
  fillRect(back, 10, 9, 3, 2, TAIL);
  fillRect(back, 0, 12, 5, 4, TIRE);
  fillRect(back, 9, 12, 5, 4, TIRE);
  fillRect(back, 1, 13, 3, 2, HUB);
  fillRect(back, 10, 13, 3, 2, HUB);
  return [top, side, front, back];
}

/** A round canopy on a narrow trunk. Stack it with `round: true`. */
export function treeViews(): [Image, Image, Image, Image] {
  const H = 34;
  const L = 26;
  const W = 26;
  const side = view(L, H);
  fillEllipse(side, 13, 13, 11, 10, LEAF);
  fillEllipse(side, 10, 11, 5, 4, LEAF_LIT);
  fillRect(side, 11, 18, 4, 16, TRUNK);

  const top = view(W, L);
  fillEllipse(top, 13, 13, 11, 11, LEAF);
  fillEllipse(top, 10, 10, 4, 4, LEAF_LIT);

  const front = view(W, H);
  fillEllipse(front, 13, 13, 11, 10, LEAF);
  fillEllipse(front, 13, 12, 4, 3, LEAF_LIT);
  fillRect(front, 11, 18, 4, 16, TRUNK);

  const back = view(W, H);
  fillEllipse(back, 13, 13, 11, 10, LEAF_DARK);
  fillRect(back, 11, 18, 4, 16, TRUNK_DARK);
  return [top, side, front, back];
}

export function carSheet(): Image {
  return rowSheet(carViews());
}

export function treeSheet(): Image {
  return rowSheet(treeViews());
}

export function sampleSheet(name: SampleName): Image {
  return name === "car" ? carSheet() : treeSheet();
}
