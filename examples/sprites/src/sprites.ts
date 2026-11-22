import { defineService, defineTool, t } from "@brickkit/core";
import {
  StackError,
  viewsToSlices,
  volumeStrip,
  type StackOptions,
} from "./carve";
import { PngError, decodePngBase64, encodePng, toBase64 } from "./png";
import { bakeDirections, DIRECTIONS } from "./render";
import { samplePresets, sampleSheet, type SampleName } from "./samples";

export const sprites = defineService("sprites");

const stackInput = t.Object(
  {
    sample: t.Optional(
      t.Union([t.Literal("car"), t.Literal("tree")], {
        description: "A bundled 4-view sheet. Ignored when sheet is set.",
      }),
    ),
    sheet: t.Optional(
      t.String({
        description:
          "A 4-view PNG as base64, or a data URL. One row: top, side, front, back.",
      }),
    ),
    slices: t.Optional(
      t.Integer({
        minimum: 0,
        maximum: 96,
        description: "Layer count. 0 keeps the sheet's own height.",
      }),
    ),
    round: t.Optional(
      t.Boolean({
        description:
          "Lathe each solid layer into an ellipse. Good for trees, pots, balloons.",
      }),
    ),
    palette: t.Optional(
      t.Integer({
        minimum: 0,
        maximum: 256,
        description: "Shared palette size. 0 keeps every color.",
      }),
    ),
    shade: t.Optional(
      t.Number({
        minimum: 0,
        maximum: 1,
        description: "How much to darken side faces toward the ground.",
      }),
    ),
    order: t.Optional(t.Union([t.Literal("reading"), t.Literal("auto")])),
    sideNose: t.Optional(t.Union([t.Literal("left"), t.Literal("right")])),
    topNose: t.Optional(
      t.Union([t.Literal("auto"), t.Literal("up"), t.Literal("down")]),
    ),
  },
  { additionalProperties: false },
);

const stackOutput = t.Object(
  {
    slices: t.Integer(),
    sliceWidth: t.Integer(),
    sliceHeight: t.Integer(),
    stripPng: t.String({
      description: "Base64 PNG. Ground slice on the left.",
    }),
    directions: t.Integer(),
    frameWidth: t.Integer(),
    frameHeight: t.Integer(),
    sheetPng: t.String({
      description:
        "Base64 PNG of a 16-direction turntable, frames left to right.",
    }),
  },
  { additionalProperties: false },
);

export interface StackResult {
  slices: number;
  sliceWidth: number;
  sliceHeight: number;
  stripPng: string;
  directions: number;
  frameWidth: number;
  frameHeight: number;
  sheetPng: string;
}

function option<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

/** Resolve a request to carving options. Bundled samples fill in what was omitted. */
export function resolveStack(input: {
  sample?: SampleName;
  sheet?: string;
  slices?: number;
  round?: boolean;
  palette?: number;
  shade?: number;
  order?: StackOptions["order"];
  sideNose?: StackOptions["sideNose"];
  topNose?: StackOptions["topNose"];
}): { image: ReturnType<typeof sampleSheet>; options: StackOptions } {
  if (!input.sample && !input.sheet) {
    throw new StackError(
      "Pass a sample name (car or tree) or a base64 PNG sheet.",
    );
  }
  const preset = input.sample ? samplePresets[input.sample] : {};
  const image = input.sheet
    ? decodePngBase64(input.sheet)
    : sampleSheet(input.sample as SampleName);
  if (image.width > 768 || image.height > 768) {
    throw new StackError("Sheet must be at most 768 pixels on a side.");
  }
  if (image.width < 8 || image.height < 8) {
    throw new StackError("Sheet is too small to hold four views.");
  }
  return {
    image,
    options: {
      slices: input.slices,
      round: option(input.round, preset.round ?? false),
      palette: option(input.palette, preset.palette ?? 24),
      shade: option(input.shade, preset.shade ?? 0.2),
      order: option(input.order, preset.order ?? "reading"),
      sideNose: option(input.sideNose, preset.sideNose ?? "left"),
      topNose: option(input.topNose, preset.topNose ?? "auto"),
      // Bundled art has no black contour. A caller-supplied sheet keeps the default stripper.
      dark: input.sheet ? 70 : (preset.dark ?? 70),
    },
  };
}

export function stackImage(
  image: ReturnType<typeof sampleSheet>,
  options: StackOptions,
): StackResult {
  const { volume } = viewsToSlices(image, options);
  const strip = volumeStrip(volume);
  const baked = bakeDirections(volume, DIRECTIONS);
  return {
    slices: volume.slices,
    sliceWidth: volume.width,
    sliceHeight: volume.height,
    stripPng: toBase64(encodePng(strip)),
    directions: baked.directions,
    frameWidth: baked.frameWidth,
    frameHeight: baked.frameHeight,
    sheetPng: toBase64(encodePng(baked.image)),
  };
}

/**
 * One action, four doors: call it in process, POST it, use the typed client,
 * or let an agent call the MCP tool. `http: true` publishes the route.
 */
export const stack = defineTool({
  name: "stack",
  title: "Stack sprite views",
  description:
    "Carve a 4-view pixel-art sheet (top, side, front, back in one row) into a sprite-stacked slice strip and a 16-direction turntable. Pass sample car or tree, or a base64 PNG as sheet.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  http: true,
  input: stackInput,
  output: stackOutput,
  execute: ({ input, error }) => {
    try {
      const resolved = resolveStack(input);
      return stackImage(resolved.image, resolved.options);
    } catch (err) {
      if (err instanceof StackError || err instanceof PngError) {
        return error.BAD_REQUEST(err.message);
      }
      throw err;
    }
  },
});

sprites.tool(stack);

export { stackInput, stackOutput };
