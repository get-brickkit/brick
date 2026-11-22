import { deflateSync, inflateSync } from "node:zlib";
import { blank, type Image } from "./image";

export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngError";
  }
}

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Encode an RGBA image as an 8-bit PNG. No interlacing, filter None. */
export function encodePng(image: Image): Uint8Array {
  if (image.width < 1 || image.height < 1)
    throw new PngError("image has no pixels");
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = image.width * 4;
  const raw = new Uint8Array(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) {
    const start = y * (stride + 1);
    raw[start] = 0;
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), start + 1);
  }
  return concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(
  raw: Uint8Array,
  height: number,
  stride: number,
  bpp: number,
): Uint8Array {
  if (raw.length < height * (stride + 1))
    throw new PngError("png pixel data is truncated");
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? out[row + i - bpp]! : 0;
      const up = y > 0 ? out[prev + i]! : 0;
      const ul = y > 0 && i >= bpp ? out[prev + i - bpp]! : 0;
      const value = raw[src + i]!;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) add = paeth(left, up, ul);
      else if (filter !== 0)
        throw new PngError(`unsupported png filter ${filter}`);
      out[row + i] = (value + add) & 255;
    }
  }
  return out;
}

function channelsFor(colorType: number): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 3) return 1;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new PngError(`unsupported png color type ${colorType}`);
}

/**
 * Decode an 8-bit PNG into RGBA.
 * Indexed, gray, and RGB sheets are expanded. Interlaced PNGs are rejected.
 */
export function decodePng(bytes: Uint8Array): Image {
  if (bytes.length < 8) throw new PngError("not a png");
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new PngError("not a png");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length)
      throw new PngError("truncated png chunk");
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expected = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (view.getUint32(offset + 8 + length) !== expected)
      throw new PngError(`bad crc in ${type}`);
    offset += 12 + length;
    if (type === "IHDR") {
      const header = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      width = header.getUint32(0);
      height = header.getUint32(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (data[12] !== 0) throw new PngError("interlaced png is not supported");
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (width < 1 || height < 1 || colorType < 0)
    throw new PngError("png is missing IHDR");
  if (bitDepth !== 8)
    throw new PngError(
      `png bit depth ${bitDepth} is not supported; export an 8-bit png`,
    );
  if (width > 4096 || height > 4096) throw new PngError("png is too large");
  const channels = channelsFor(colorType);
  const stride = width * channels;
  const raw = unfilter(inflateSync(concat(idat)), height, stride, channels);
  const image = blank(width, height);
  const rgba = image.data;
  if (colorType === 6) {
    rgba.set(raw);
    return image;
  }
  if (colorType === 2) {
    const key =
      trns && trns.length >= 6 ? [trns[1]!, trns[3]!, trns[5]!] : undefined;
    for (let i = 0, o = 0; i < raw.length; i += 3, o += 4) {
      rgba[o] = raw[i]!;
      rgba[o + 1] = raw[i + 1]!;
      rgba[o + 2] = raw[i + 2]!;
      const transparent =
        key &&
        raw[i] === key[0] &&
        raw[i + 1] === key[1] &&
        raw[i + 2] === key[2];
      rgba[o + 3] = transparent ? 0 : 255;
    }
    return image;
  }
  if (colorType === 0) {
    const key = trns && trns.length >= 2 ? trns[1]! : undefined;
    for (let i = 0; i < raw.length; i++) {
      const o = i * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = raw[i]!;
      rgba[o + 3] = raw[i] === key ? 0 : 255;
    }
    return image;
  }
  if (colorType === 4) {
    for (let i = 0, o = 0; i < raw.length; i += 2, o += 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = raw[i]!;
      rgba[o + 3] = raw[i + 1]!;
    }
    return image;
  }
  if (!palette) throw new PngError("indexed png is missing a palette");
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]! * 3;
    const o = i * 4;
    rgba[o] = palette[entry] ?? 0;
    rgba[o + 1] = palette[entry + 1] ?? 0;
    rgba[o + 2] = palette[entry + 2] ?? 0;
    rgba[o + 3] = trns ? (trns[raw[i]!] ?? 255) : 255;
  }
  return image;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Accept a raw base64 PNG or a `data:image/png;base64,...` URL. */
export function decodePngBase64(value: string): Image {
  const trimmed = value.trim();
  if (trimmed.length > 12_000_000) throw new PngError("sheet is too large");
  const comma = trimmed.startsWith("data:") ? trimmed.indexOf(",") : -1;
  const payload = comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length < 8) throw new PngError("sheet is not a png");
  return decodePng(bytes);
}
