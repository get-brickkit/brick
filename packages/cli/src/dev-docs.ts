import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import type { DocumentationOptions } from "@brickkit/core";
import { bundleComponents } from "./dashboard-extension";
import {
  decode,
  docsFileUrl,
  docsHref,
  isExternalHref,
  type DocsInfo,
  type DocsNode,
  type DocsPage,
  type DocsSearchHit,
  type DocsSnapshot,
  type DocsTree,
} from "./dashboard-protocol";

/*
 * Developer documentation for the dashboard's Docs tab. The folder follows
 * Fumadocs' layout (frontmatter, meta.json, folder groups), and fumadocs-core
 * builds the page tree and search. MDX is compiled here and run in the browser
 * with the dashboard's components plus the project's own.
 *
 * fumadocs-core and @mdx-js/mdx are optional peers, loaded only when an app
 * sets `documentation`, so projects without docs do not install them.
 */

export type OpenedDocs =
  | { status: "ready"; docs: DevDocs }
  | { status: "missing"; packages: string[] }
  | { status: "error"; message: string };

const PACKAGES = ["fumadocs-core", "@mdx-js/mdx"] as const;
/** What the docs are called when their folder does not name them. */
const DEFAULT_TITLE = "Docs";
const PAGE_EXTENSIONS = new Set([".md", ".mdx"]);
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const REFRESH_DELAY_MS = 100;

interface Fumadocs {
  loader: typeof import("fumadocs-core/source").loader;
  frontmatter: typeof import("fumadocs-core/content/md/frontmatter").frontmatter;
  plugins: typeof import("fumadocs-core/mdx-plugins");
  createSearchAPI: typeof import("fumadocs-core/search/server").createSearchAPI;
  compile: typeof import("@mdx-js/mdx").compile;
}

async function loadFumadocs(): Promise<Fumadocs | string[]> {
  try {
    const [source, matter, plugins, search, mdx] = await Promise.all([
      import("fumadocs-core/source"),
      import("fumadocs-core/content/md/frontmatter"),
      import("fumadocs-core/mdx-plugins"),
      import("fumadocs-core/search/server"),
      import("@mdx-js/mdx"),
    ]);
    return {
      loader: source.loader,
      frontmatter: matter.frontmatter,
      plugins,
      createSearchAPI: search.createSearchAPI,
      compile: mdx.compile,
    };
  } catch (error) {
    // Only a missing package is the project's to fix; anything else is a bug.
    if (
      (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND" ||
      /Cannot find (module|package)/.test(String((error as Error)?.message))
    )
      return [...PACKAGES];
    throw error;
  }
}

interface PageFile {
  /** Relative to the docs folder, with forward slashes. */
  path: string;
  absolute: string;
  title: string;
  description?: string;
  /** The file's text after the frontmatter. */
  content: string;
  data: Record<string, unknown>;
}

interface MetaFile {
  path: string;
  data: Record<string, unknown>;
}

const humanize = (name: string): string => {
  const spaced = name.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const H1 = /^#\s+(.+?)\s*#*\s*$/;

/**
 * The first `# Heading` outside code fences: its text, and the content without
 * it. The page shows its title above the content, so a heading that only
 * repeats the title would appear twice.
 */
function firstHeading(
  content: string,
): { text: string; rest: string; leading: boolean } | undefined {
  const lines = content.split("\n");
  let fenced = false;
  let seenText = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      seenText = true;
    } else if (!fenced) {
      const match = H1.exec(line);
      if (match) {
        const rest = [...lines.slice(0, index), ...lines.slice(index + 1)];
        if (rest[index]?.trim() === "") rest.splice(index, 1);
        return { text: match[1]!, rest: rest.join("\n"), leading: !seenText };
      }
      if (line.trim() !== "") seenText = true;
    }
  }
  return undefined;
}

async function scan(
  root: string,
  fumadocs: Fumadocs,
  warn: (message: string) => void,
): Promise<{ pages: PageFile[]; metas: MetaFile[] }> {
  const pages: PageFile[] = [];
  const metas: MetaFile[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.name === "meta.json") {
        try {
          const data = JSON.parse(await readFile(absolute, "utf8"));
          if (data && typeof data === "object") metas.push({ path, data });
        } catch (error) {
          warn(`[Brick-TS] Skipping docs ${path}: ${errorMessage(error)}`);
        }
      } else if (PAGE_EXTENSIONS.has(extname(entry.name))) {
        const text = await readFile(absolute, "utf8");
        let data: Record<string, unknown> = {};
        let content = text;
        try {
          const parsed = fumadocs.frontmatter(text);
          data = parsed.data as Record<string, unknown>;
          content = parsed.content;
        } catch (error) {
          warn(
            `[Brick-TS] Ignoring the frontmatter of docs ${path}: ${errorMessage(error)}`,
          );
        }
        const name = basename(entry.name, extname(entry.name));
        const heading = firstHeading(content);
        const given =
          typeof data.title === "string" && data.title ? data.title : undefined;
        const title =
          given ??
          heading?.text ??
          humanize(name === "index" ? basename(dirname(path)) || "Home" : name);
        // A title taken from the heading, or a leading heading that repeats the
        // frontmatter title, is shown once, above the content.
        if (heading && (!given || (heading.leading && heading.text === given)))
          content = heading.rest;
        pages.push({
          path,
          absolute,
          title,
          description:
            typeof data.description === "string" ? data.description : undefined,
          content,
          data,
        });
      }
    }
  }
  await visit(root);
  return { pages, metas };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type MdastNode = {
  type: string;
  url?: string;
  name?: string | null;
  attributes?: { type: string; name?: string; value?: unknown }[];
  children?: MdastNode[];
};

function walk(node: MdastNode, visit: (node: MdastNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** Ways a link inside a page can point at another page or a local image. */
function resolveInside(from: string, href: string): string | undefined {
  if (isExternalHref(href) || href.startsWith("#")) return undefined;
  if (href.startsWith("/")) return undefined;
  const [target] = href.split(/[?#]/);
  if (!target) return undefined;
  const resolved = posix.normalize(posix.join(posix.dirname(from), target));
  return resolved.startsWith("../") ? undefined : resolved;
}

/**
 * The page tree and compiled pages of one docs folder. It watches the folder,
 * so edits show in the dashboard as they are saved.
 */
export class DevDocs {
  readonly #root: string;
  readonly #documentation: DocumentationOptions;
  readonly #base: string;
  readonly #fumadocs: Fumadocs;
  readonly #warn: (message: string) => void;
  readonly #listeners = new Set<() => void>();
  readonly #watchers: FSWatcher[] = [];
  #loader: Source | undefined;
  #pages = new Map<string, PageFile>();
  #byPath = new Map<string, string>();
  #compiled = new Map<string, DocsPage>();
  #search:
    | Promise<{ search(query: string): Promise<DocsSearchHit[]> }>
    | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #refreshing: Promise<void> = Promise.resolve();
  #closed = false;
  #title = DEFAULT_TITLE;
  revision = 0;

  constructor(
    base: string,
    documentation: DocumentationOptions,
    fumadocs: Fumadocs,
    warn: (message: string) => void,
  ) {
    this.#base = base;
    this.#documentation = documentation;
    this.#root = resolve(base, documentation.dir);
    this.#fumadocs = fumadocs;
    this.#warn = warn;
  }

  async refresh(): Promise<void> {
    // Refreshes run one at a time, so a slow scan cannot overwrite a newer one.
    this.#refreshing = this.#refreshing.then(() => this.#scan());
    await this.#refreshing;
  }

  async #scan(): Promise<void> {
    const { pages, metas } = await scan(this.#root, this.#fumadocs, this.#warn);
    if (this.#closed) return;
    const source = this.#fumadocs.loader({
      baseUrl: "/",
      source: {
        files: [
          ...pages.map((page) => ({
            type: "page" as const,
            path: page.path,
            data: {
              ...page.data,
              title: page.title,
              description: page.description,
            },
          })),
          ...metas.map((meta) => ({
            type: "meta" as const,
            path: meta.path,
            data: meta.data,
          })),
        ],
      },
    });
    this.#loader = source as unknown as Source;
    this.#pages = new Map();
    this.#byPath = new Map();
    for (const page of this.#loader.getPages()) {
      const slug = page.slugs.join("/");
      const file = pages.find((candidate) => candidate.path === page.path);
      if (!file) continue;
      this.#pages.set(slug, file);
      this.#byPath.set(file.path, slug);
    }
    this.#compiled.clear();
    this.#search = undefined;
    const tree = this.#loader.getPageTree();
    this.#title = typeof tree.name === "string" ? tree.name : DEFAULT_TITLE;
    this.revision++;
    for (const listener of this.#listeners) listener();
  }

  watch(): void {
    const changed = () => {
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        void this.refresh().catch((error) =>
          this.#warn(`[Brick-TS] Docs: ${errorMessage(error)}`),
        );
      }, REFRESH_DELAY_MS);
    };
    const folders = [this.#root];
    if (this.#documentation.components)
      folders.push(dirname(this.#componentsPath()!));
    for (const [index, folder] of folders.entries()) {
      try {
        // Recursive for the docs; the components module's folder is the
        // project's own source, where only its direct files matter.
        this.#watchers.push(
          watch(folder, { recursive: index === 0 }, () => changed()),
        );
      } catch {
        try {
          this.#watchers.push(watch(folder, () => changed()));
        } catch {
          // A folder that cannot be watched still works; it just needs a reload.
        }
      }
    }
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  snapshot(): DocsSnapshot {
    return {
      revision: this.revision,
      status: "ready",
      title: this.#title,
      components: Boolean(this.#documentation.components),
    };
  }

  info(): DocsInfo {
    return {
      tree: simplify(this.#loader?.getPageTree()),
      components: Boolean(this.#documentation.components),
      revision: this.revision,
    };
  }

  /** Compile one page; undefined when there is no such page. */
  async page(slugs: string[]): Promise<DocsPage | undefined> {
    const key = slugs.join("/");
    const file = this.#pages.get(key);
    if (!file) return undefined;
    const cached = this.#compiled.get(key);
    if (cached) return cached;
    const page = await this.#compile(file, slugs);
    // A refresh while compiling clears the cache; do not put stale output back.
    if (this.#pages.get(key) === file) this.#compiled.set(key, page);
    return page;
  }

  async #compile(file: PageFile, slugs: string[]): Promise<DocsPage> {
    const { plugins, compile } = this.#fumadocs;
    const base = {
      title: file.title,
      description: file.description,
      path: file.path,
      slugs,
    };
    try {
      const result = await compile(
        { path: file.absolute, value: file.content },
        {
          outputFormat: "function-body",
          development: false,
          remarkPlugins: [
            plugins.remarkGfm,
            plugins.remarkHeading,
            plugins.remarkCodeTab,
            plugins.remarkNpm,
            plugins.remarkAdmonition,
            () => (tree: MdastNode) => this.#rewriteLinks(tree, file.path),
          ],
          rehypePlugins: [plugins.rehypeCode],
        },
      );
      const toc = (result.data.toc ?? []) as {
        title: unknown;
        url: string;
        depth: number;
      }[];
      return {
        ...base,
        toc: toc.map((item) => ({
          title: plainText(item.title),
          url: item.url,
          depth: item.depth,
        })),
        code: String(result),
      };
    } catch (error) {
      return { ...base, toc: [], code: "", error: errorMessage(error) };
    }
  }

  /**
   * Links to other pages become dashboard routes, and local images are served
   * from the docs folder, so a folder reads the same here as on a docs site.
   * This covers markdown links and the `href` of components such as `<Card>`.
   */
  #rewriteLinks(tree: MdastNode, from: string): void {
    walk(tree, (node) => {
      if (node.type === "link" && node.url !== undefined) {
        node.url = this.#route(from, node.url) ?? node.url;
      } else if (node.type === "image" && node.url !== undefined) {
        const resolved = resolveInside(from, node.url);
        if (resolved !== undefined) node.url = docsFileUrl(resolved);
      } else if (
        node.type === "mdxJsxFlowElement" ||
        node.type === "mdxJsxTextElement"
      ) {
        for (const attribute of node.attributes ?? []) {
          if (attribute.type !== "mdxJsxAttribute") continue;
          if (typeof attribute.value !== "string") continue;
          if (attribute.name === "href")
            attribute.value =
              this.#route(from, attribute.value) ?? attribute.value;
          else if (attribute.name === "src" && node.name === "img") {
            const resolved = resolveInside(from, attribute.value);
            if (resolved !== undefined) attribute.value = docsFileUrl(resolved);
          }
        }
      }
    });
  }

  /**
   * The dashboard route for a link to a page of these docs, or undefined for
   * anything else (other sites, in-page anchors, files). A link to a page that
   * does not exist still becomes a route, so it says "No such page" here
   * instead of leaving the dashboard.
   */
  #route(from: string, href: string): string | undefined {
    const hashAt = href.indexOf("#");
    const anchor = hashAt >= 0 ? decode(href.slice(hashAt + 1)) : undefined;
    const target =
      (hashAt >= 0 ? href.slice(0, hashAt) : href).split("?")[0] ?? "";
    const route = (slug: string) =>
      docsHref(slug ? slug.split("/") : [], anchor);
    if (isExternalHref(href) || !target) return undefined;
    if (target.startsWith("/")) {
      // A docs site links by address (/guide/setup); so can these pages.
      const slug = target.replace(/^\/+|\/+$/g, "");
      return this.#pages.has(slug) ? route(slug) : undefined;
    }
    const resolved = resolveInside(from, target);
    if (resolved === undefined) return undefined;
    const known = this.#byPath.get(resolved);
    if (known !== undefined) return route(known);
    if (!PAGE_EXTENSIONS.has(extname(resolved))) return undefined;
    const guess = resolved
      .slice(0, -extname(resolved).length)
      .replace(/(^|\/)index$/, "");
    return route(guess);
  }

  async search(query: string): Promise<DocsSearchHit[]> {
    if (!query.trim()) return [];
    this.#search ??= this.#buildSearch();
    return (await this.#search).search(query);
  }

  async #buildSearch() {
    const { plugins, createSearchAPI } = this.#fumadocs;
    const indexes = [...this.#pages.entries()].map(([slug, file]) => ({
      id: file.path,
      title: file.title,
      description: file.description,
      url: `/${slug}`,
      structuredData: plugins.structure(file.content),
    }));
    const api = createSearchAPI("advanced", { indexes });
    return {
      async search(query: string) {
        return (await api.search(query)) as DocsSearchHit[];
      },
    };
  }

  /** A file from the docs folder that a page can show, such as an image. */
  async file(
    relativePath: string,
  ): Promise<{ body: Uint8Array; type: string } | undefined> {
    const type = IMAGE_TYPES[extname(relativePath).toLowerCase()];
    if (!type) return undefined;
    const absolute = resolve(this.#root, relativePath);
    // Stay inside the docs folder, whatever the path says.
    if (absolute !== this.#root && !absolute.startsWith(this.#root + sep))
      return undefined;
    try {
      if (!(await stat(absolute)).isFile()) return undefined;
      return { body: new Uint8Array(await readFile(absolute)), type };
    } catch {
      return undefined;
    }
  }

  #componentsPath(): string | undefined {
    const { components } = this.#documentation;
    return components ? resolve(this.#base, components) : undefined;
  }

  /** The project's components as one browser module; undefined when it has none. */
  async components(): Promise<string | undefined> {
    const entry = this.#componentsPath();
    return entry ? bundleComponents(entry) : undefined;
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers.length = 0;
    this.#listeners.clear();
  }
}

/** Flatten what MDX gives for a heading to text. */
function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plainText).join("");
  if (value && typeof value === "object") {
    const node = value as {
      props?: { children?: unknown };
      children?: unknown;
      value?: unknown;
    };
    if (typeof node.value === "string") return node.value;
    return plainText(node.props?.children ?? node.children);
  }
  return "";
}

interface RawNode {
  type: string;
  name?: unknown;
  url?: string;
  description?: unknown;
  index?: RawNode;
  children?: RawNode[];
  defaultOpen?: boolean;
}
type RawTree = { name?: unknown; children: RawNode[] };

/** What this module uses of a fumadocs-core loader. */
interface Source {
  getPages(): { slugs: string[]; path: string }[];
  getPageTree(): RawTree;
}

/** The page tree as plain data for the dashboard; icons and links are left out. */
function simplify(tree: RawTree | undefined): DocsTree {
  const text = (value: unknown): string =>
    typeof value === "string" ? value : plainText(value);
  const convert = (node: RawNode): DocsNode | undefined => {
    if (node.type === "page" && node.url !== undefined)
      return {
        type: "page",
        name: text(node.name),
        url: node.url,
        ...(typeof node.description === "string"
          ? { description: node.description }
          : {}),
      };
    if (node.type === "separator")
      return {
        type: "separator",
        ...(node.name ? { name: text(node.name) } : {}),
      };
    if (node.type === "folder")
      return {
        type: "folder",
        name: text(node.name),
        ...(node.index?.url !== undefined
          ? { index: { name: text(node.index.name), url: node.index.url } }
          : {}),
        children: (node.children ?? []).flatMap(
          (child) => convert(child) ?? [],
        ),
        ...(node.defaultOpen ? { defaultOpen: true } : {}),
      };
    return undefined;
  };
  return {
    name: text(tree?.name) || DEFAULT_TITLE,
    children: (tree?.children ?? []).flatMap((child) => convert(child) ?? []),
  };
}

/** Open a docs folder; says what is missing when it cannot be shown. */
export async function openDocs(options: {
  base: string;
  documentation: DocumentationOptions;
  warn: (message: string) => void;
}): Promise<OpenedDocs> {
  const fumadocs = await loadFumadocs();
  if (Array.isArray(fumadocs)) return { status: "missing", packages: fumadocs };
  const docs = new DevDocs(
    options.base,
    options.documentation,
    fumadocs,
    options.warn,
  );
  try {
    await docs.refresh();
  } catch (error) {
    docs.close();
    const root = resolve(options.base, options.documentation.dir);
    return {
      status: "error",
      message:
        (error as { code?: string }).code === "ENOENT"
          ? `The docs folder ${root} does not exist.`
          : errorMessage(error),
    };
  }
  docs.watch();
  return { status: "ready", docs };
}

/**
 * The docs of whichever app is running: opened when the app says where they
 * are, replaced when that changes, and closed when it stops asking for them.
 */
export class DocsHost {
  readonly #publish: (docs: DocsSnapshot | null) => void;
  readonly #warn: (message: string) => void;
  #docs: DevDocs | undefined;
  #stopListening: (() => void) | undefined;
  #key: string | undefined;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    publish: (docs: DocsSnapshot | null) => void,
    warn: (message: string) => void,
  ) {
    this.#publish = publish;
    this.#warn = warn;
  }

  get current(): DevDocs | undefined {
    return this.#docs;
  }

  /**
   * Follow the app's `documentation`. Relative paths in it start at `base`, the
   * folder of the app entry, as they read in the file that sets them.
   */
  configure(
    base: string,
    documentation: DocumentationOptions | undefined,
  ): Promise<void> {
    this.#pending = this.#pending.then(() =>
      this.#configure(base, documentation),
    );
    return this.#pending;
  }

  async #configure(
    base: string,
    documentation: DocumentationOptions | undefined,
  ): Promise<void> {
    const key = JSON.stringify([base, documentation ?? null]);
    if (key === this.#key) return;
    this.#key = key;
    this.#release();
    if (!documentation) {
      this.#publish(null);
      return;
    }
    const opened = await openDocs({
      base,
      documentation,
      warn: this.#warn,
    });
    if (opened.status !== "ready") {
      const message =
        opened.status === "missing"
          ? `The docs need ${opened.packages.join(" and ")}. Install with: bun add -d ${opened.packages.join(" ")}`
          : opened.message;
      this.#warn(`[Brick-TS] Docs are off. ${message}`);
      this.#publish(
        opened.status === "missing"
          ? { status: "missing", packages: opened.packages, message }
          : { status: "error", message },
      );
      return;
    }
    this.#docs = opened.docs;
    this.#stopListening = opened.docs.onChange(() =>
      this.#publish(opened.docs.snapshot()),
    );
    this.#publish(opened.docs.snapshot());
  }

  #release(): void {
    this.#stopListening?.();
    this.#stopListening = undefined;
    this.#docs?.close();
    this.#docs = undefined;
  }

  close(): void {
    this.#key = undefined;
    this.#release();
  }
}
