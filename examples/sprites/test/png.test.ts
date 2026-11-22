import { describe, expect, it } from "bun:test";
import { blank, setPixel } from "../src/image";
import { decodePng, decodePngBase64, encodePng, PngError } from "../src/png";

describe("png", () => {
  it("round-trips an rgba image", () => {
    const image = blank(5, 3);
    setPixel(image, 0, 0, [10, 20, 30]);
    setPixel(image, 4, 2, [255, 128, 0], 0);
    setPixel(image, 2, 1, [1, 2, 3], 200);
    const back = decodePng(encodePng(image));
    expect(back.width).toBe(5);
    expect(back.height).toBe(3);
    expect([...back.data]).toEqual([...image.data]);
  });

  it("decodes a data url and rejects a non-png", () => {
    const image = blank(1, 1, [9, 8, 7]);
    const url = `data:image/png;base64,${Buffer.from(encodePng(image)).toString("base64")}`;
    expect([...decodePngBase64(url).data]).toEqual([...image.data]);
    expect(() => decodePng(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))).toThrow(
      PngError,
    );
  });
});
