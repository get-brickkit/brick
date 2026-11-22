import { describe, expect, it } from "bun:test";
import { blank, fillRect, rowSheet, type Image, type RGB } from "../src/image";
import {
  carve,
  findViews,
  removeBackground,
  viewsToSlices,
  type Volume,
} from "../src/carve";
import { carSheet, samplePresets, treeSheet } from "../src/samples";

function solid(
  width: number,
  height: number,
  rgb: RGB = [255, 255, 255],
): Image {
  return blank(width, height, rgb);
}

function at(volume: Volume, z: number, y: number, x: number): boolean {
  return volume.data[((z * volume.height + y) * volume.width + x) * 4 + 3]! > 0;
}

function color(volume: Volume, z: number, y: number, x: number): RGB {
  const i = ((z * volume.height + y) * volume.width + x) * 4;
  return [volume.data[i]!, volume.data[i + 1]!, volume.data[i + 2]!];
}

function opaqueCount(volume: Volume, z: number): number {
  let count = 0;
  for (let y = 0; y < volume.height; y++) {
    for (let x = 0; x < volume.width; x++) if (at(volume, z, y, x)) count++;
  }
  return count;
}

function components(volume: Volume, z: number): number {
  const { height: h, width: w } = volume;
  const seen = new Uint8Array(h * w);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (seen[start] || !at(volume, z, y, x)) continue;
      count++;
      const stack: [number, number][] = [[y, x]];
      seen[start] = 1;
      while (stack.length) {
        const [cy, cx] = stack.pop()!;
        for (const [dy, dx] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const yy = cy + dy;
          const xx = cx + dx;
          if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
          const i = yy * w + xx;
          if (seen[i] || !at(volume, z, yy, xx)) continue;
          seen[i] = 1;
          stack.push([yy, xx]);
        }
      }
    }
  }
  return count;
}

describe("carve", () => {
  it("keeps a voxel only where every view covers it", () => {
    const top = solid(4, 3);
    fillRect(top, 0, 0, 1, 3, [0, 0, 0]);
    for (let y = 0; y < 3; y++) top.data[y * 4 * 4 + 3] = 0;
    const volume = carve(top, solid(3, 2), solid(4, 2), solid(4, 2));
    expect(volume.slices).toBe(2);
    expect(volume.height).toBe(3);
    expect(volume.width).toBe(4);
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 3; y++) {
        expect(at(volume, z, y, 0)).toBe(false);
        expect(at(volume, z, y, 1)).toBe(true);
      }
    }
  });

  it("colors the roof from the top view and the sides from the side view", () => {
    const red: RGB = [200, 0, 0];
    const green: RGB = [0, 180, 0];
    const volume = carve(
      solid(3, 3, red),
      solid(3, 2, green),
      solid(3, 2, [0, 0, 220]),
      solid(3, 2, [220, 220, 0]),
      { shade: 0 },
    );
    expect(color(volume, 1, 1, 1)).toEqual(red);
    expect(color(volume, 0, 1, 1)).toEqual(green);
  });

  it("lathes a solid layer and leaves a gapped layer square", () => {
    const round = carve(solid(8, 8), solid(8, 1), solid(8, 1), solid(8, 1), {
      round: true,
    });
    expect(at(round, 0, 0, 0)).toBe(false);
    expect(at(round, 0, 4, 4)).toBe(true);

    const side = solid(8, 1);
    for (let x = 2; x <= 5; x++) side.data[x * 4 + 3] = 0;
    const gapped = carve(solid(8, 8), side, solid(8, 1), solid(8, 1), {
      round: true,
    });
    expect(at(gapped, 0, 0, 0)).toBe(true);
    expect(at(gapped, 0, 3, 3)).toBe(false);
  });

  it("flood-fills a flat background and finds four views in reading order", () => {
    const sheet = blank(40, 12, [240, 240, 240]);
    fillRect(sheet, 2, 2, 6, 8, [20, 20, 20]);
    const cleared = removeBackground(sheet, 28);
    expect(cleared.data[3]).toBe(0);
    expect(cleared.data[(2 * 40 + 2) * 4 + 3]).toBe(255);

    const views = [solid(4, 6), solid(8, 4), solid(5, 4), solid(5, 3)].map(
      (view, index) => {
        const mark = view.data;
        mark[0] = index;
        return view;
      },
    );
    const found = findViews(rowSheet(views, 8, 4), "reading");
    expect(found.map((view) => view.data[0])).toEqual([0, 1, 2, 3]);
  });

  it("stacks the car into a body with four wheels on the ground", () => {
    const { volume } = viewsToSlices(carSheet(), {
      ...samplePresets.car,
      shade: 0,
    });
    expect(components(volume, 0)).toBe(4);
    let fattest = 0;
    let fatCount = 0;
    for (let z = 0; z < volume.slices; z++) {
      const count = opaqueCount(volume, z);
      if (count > fatCount) {
        fatCount = count;
        fattest = z;
      }
    }
    expect(components(volume, fattest)).toBe(1);
    expect(fatCount).toBeGreaterThan(opaqueCount(volume, 0));
    expect(opaqueCount(volume, volume.slices - 1)).toBeLessThan(fatCount);
  });

  it("stacks the tree into a round canopy over a narrow trunk", () => {
    const { volume } = viewsToSlices(treeSheet(), {
      ...samplePresets.tree,
      shade: 0,
    });
    const ground = opaqueCount(volume, 0);
    let canopy = 0;
    let canopyZ = 0;
    for (let z = 0; z < volume.slices; z++) {
      const count = opaqueCount(volume, z);
      if (count > canopy) {
        canopy = count;
        canopyZ = z;
      }
    }
    expect(canopy).toBeGreaterThan(ground * 3);
    expect(at(volume, canopyZ, 0, 0)).toBe(false);
    expect(
      at(
        volume,
        0,
        Math.floor(volume.height / 2),
        Math.floor(volume.width / 2),
      ),
    ).toBe(true);
  });
});
