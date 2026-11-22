/** An 8-bit RGBA image, row-major, length `width * height * 4`. */
export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

export type RGB = [number, number, number];

export function blank(width: number, height: number, fill?: RGB): Image {
  const data = new Uint8Array(width * height * 4);
  if (fill) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

export function clone(image: Image): Image {
  return {
    width: image.width,
    height: image.height,
    data: image.data.slice(),
  };
}

export function index(image: Image, x: number, y: number): number {
  return (y * image.width + x) * 4;
}

export function setPixel(
  image: Image,
  x: number,
  y: number,
  rgb: RGB,
  alpha = 255,
): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const i = index(image, x, y);
  image.data[i] = rgb[0];
  image.data[i + 1] = rgb[1];
  image.data[i + 2] = rgb[2];
  image.data[i + 3] = alpha;
}

export function fillRect(
  image: Image,
  x: number,
  y: number,
  width: number,
  height: number,
  rgb: RGB,
): void {
  const x1 = Math.max(0, x);
  const y1 = Math.max(0, y);
  const x2 = Math.min(image.width, x + width);
  const y2 = Math.min(image.height, y + height);
  for (let yy = y1; yy < y2; yy++) {
    for (let xx = x1; xx < x2; xx++) setPixel(image, xx, yy, rgb);
  }
}

/** Filled ellipse. `cx` and `cy` are pixel centers. */
export function fillEllipse(
  image: Image,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rgb: RGB,
): void {
  if (rx <= 0 || ry <= 0) return;
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(image.height - 1, Math.ceil(cy + ry));
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(image.width - 1, Math.ceil(cx + rx));
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      if (dx * dx + dy * dy <= 1) setPixel(image, x, y, rgb);
    }
  }
}

export function blit(dest: Image, src: Image, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const yy = dy + y;
    if (yy < 0 || yy >= dest.height) continue;
    for (let x = 0; x < src.width; x++) {
      const xx = dx + x;
      if (xx < 0 || xx >= dest.width) continue;
      const from = index(src, x, y);
      if (src.data[from + 3] === 0) continue;
      dest.data.set(src.data.subarray(from, from + 4), index(dest, xx, yy));
    }
  }
}

export function flipX(image: Image): Image {
  const out = blank(image.width, image.height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = index(image, x, y);
      out.data.set(
        image.data.subarray(from, from + 4),
        index(out, image.width - 1 - x, y),
      );
    }
  }
  return out;
}

export function flipY(image: Image): Image {
  const out = blank(image.width, image.height);
  for (let y = 0; y < image.height; y++) {
    const from = y * image.width * 4;
    const to = (image.height - 1 - y) * image.width * 4;
    out.data.set(image.data.subarray(from, from + image.width * 4), to);
  }
  return out;
}

export function crop(
  image: Image,
  x: number,
  y: number,
  w: number,
  h: number,
): Image {
  const out = blank(w, h);
  for (let yy = 0; yy < h; yy++) {
    const from = index(image, x, y + yy);
    out.data.set(image.data.subarray(from, from + w * 4), yy * w * 4);
  }
  return out;
}

/** Nearest-neighbor resize. Pixel centers map into the source. */
export function resize(image: Image, width: number, height: number): Image {
  width = Math.max(1, width);
  height = Math.max(1, height);
  if (image.width === width && image.height === height) return image;
  const out = blank(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(
      image.height - 1,
      Math.floor(((y + 0.5) * image.height) / height),
    );
    for (let x = 0; x < width; x++) {
      const sx = Math.min(
        image.width - 1,
        Math.floor(((x + 0.5) * image.width) / width),
      );
      const from = index(image, sx, sy);
      out.data.set(image.data.subarray(from, from + 4), index(out, x, y));
    }
  }
  return out;
}

/** Place views in one horizontal row, each in its own opaque-free cell. */
export function rowSheet(views: Image[], gap = 12, pad = 8): Image {
  const innerH = Math.max(...views.map((view) => view.height));
  const width =
    pad * 2 +
    views.reduce((sum, view) => sum + view.width, 0) +
    gap * (views.length - 1);
  const height = pad * 2 + innerH;
  const sheet = blank(width, height);
  let x = pad;
  for (const view of views) {
    const y = pad + Math.floor((innerH - view.height) / 2);
    blit(sheet, view, x, y);
    x += view.width + gap;
  }
  return sheet;
}
