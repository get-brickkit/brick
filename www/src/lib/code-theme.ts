import type { ThemeRegistration } from "shiki";

/** Shiki themes built only from the brand palette: ink, muted, and the accent for keywords and literals. */
function brickTheme(
  name: string,
  type: "light" | "dark",
  c: { background: string; ink: string; muted: string; accent: string },
): ThemeRegistration {
  return {
    name,
    type,
    colors: { "editor.background": c.background, "editor.foreground": c.ink },
    settings: [
      { settings: { foreground: c.ink, background: c.background } },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: c.muted, fontStyle: "italic" },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "constant.numeric",
          "constant.language",
          "support.type.primitive",
          "markup.heading",
        ],
        settings: { foreground: c.accent },
      },
      {
        scope: [
          "string",
          "string.quoted",
          "string.template",
          "markup.inline.raw",
        ],
        settings: { foreground: c.muted },
      },
    ],
  };
}

export const brickPalette = {
  light: {
    background: "#fafaf8",
    ink: "#171716",
    muted: "#666660",
    accent: "#9b432c",
  },
  dark: {
    background: "#1b1b19",
    ink: "#f3f3ee",
    muted: "#a5a59c",
    accent: "#da916e",
  },
};

export const brickLight = brickTheme(
  "brick-light",
  "light",
  brickPalette.light,
);

export const brickDark = brickTheme("brick-dark", "dark", brickPalette.dark);

export const codeThemes = { light: brickLight, dark: brickDark };
