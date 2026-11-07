import {
  ASSETS,
  assetUrl,
  SHARED_MODULES,
  THEME_STORAGE_KEY,
} from "./dashboard-protocol";

const IMPORT_MAP = JSON.stringify({
  imports: Object.fromEntries(
    SHARED_MODULES.map((module) => [module.specifier, assetUrl(module.file)]),
  ),
});

/**
 * The page the dashboard serves at `/`. The React app and its styles load from
 * `/assets/`; the inline script applies the saved theme before first paint. The
 * import map hands the project's own modules (its docs components and its
 * dashboard extension), bundled apart from the dashboard, the dashboard's copy
 * of React and its UI kit, so there is one of each on the page.
 *
 * `extension` describes the project's extension: `revision` changes with every
 * rebuild (the page reloads when it does), `js` and `css` say what it built.
 * `theme` is whether `/assets/brick-theme.css` has token values to apply.
 */
export function dashboardShell(
  options: {
    extension?: { revision: number; js: boolean; css: boolean };
    theme?: boolean;
    mode?: "dev" | "production";
  } = {},
): string {
  const { extension, theme, mode } = options;
  const version = extension ? `?v=${extension.revision}` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${mode === "production" ? "Brick" : "Brick dev"}</title>
<link rel="icon" href="data:,">
<script>
(function () {
  try {
    var theme = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var dark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
  } catch (error) {}
})();
</script>
<link rel="stylesheet" href="${assetUrl(ASSETS.appCss)}">
${extension?.css ? `<link rel="stylesheet" href="${assetUrl(ASSETS.extensionCss)}${version}">\n` : ""}${theme ? `<link rel="stylesheet" href="${assetUrl(ASSETS.theme)}" data-brick-theme>\n` : ""}${extension ? `<meta name="brick-extension" data-revision="${extension.revision}"${extension.js ? ` data-src="${assetUrl(ASSETS.extension)}${version}"` : ""}>\n` : ""}<script type="importmap">
${IMPORT_MAP}
</script>
</head>
<body>
<div id="root"></div>
<script type="module" src="${assetUrl(ASSETS.app)}"></script>
</body>
</html>
`;
}
