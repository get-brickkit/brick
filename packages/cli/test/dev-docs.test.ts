import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleComponents } from "../src/dashboard-extension";
import { DevDocs, DocsHost, openDocs } from "../src/dev-docs";
import { DevTelemetryStore } from "../src/dev-telemetry-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brick-docs-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const FILES = {
  "docs/index.mdx": `---
title: Welcome
description: Start here
---

# Welcome

Read the [setup guide](./guide/setup.mdx#install) first.
`,
  "docs/meta.json": JSON.stringify({
    title: "Orders docs",
    pages: ["index", "---Guides---", "guide", "reference"],
  }),
  "docs/guide/meta.json": JSON.stringify({
    title: "Guide",
    // "..." lists the pages not named here, as in Fumadocs.
    pages: ["setup", "deploy", "..."],
  }),
  "docs/guide/setup.mdx": `---
title: Setup
---

## Install

Run the install, then see [deploying](deploy.md) and [home](../index.mdx).

\`\`\`ts title="boot.ts"
const orders: number = 1;
\`\`\`

<Callout title="Careful">Check the env.</Callout>

<Cards>
  <Card title="Relative" href="./deploy.md" />
  <Card title="Absolute" href="/guide/deploy#ship" />
  <Card title="Elsewhere" href="https://example.com/x" />
</Cards>

See [a page that is gone](./gone.mdx) and [the spec](../assets/spec.pdf).

![diagram](../assets/diagram.png)

## \`Config\` file
`,
  "docs/guide/deploy.md": `# Deploy it

Ship the container to production.
`,
  "docs/reference.mdx": `---
title: Broken
---

<Unclosed>
`,
  "docs/assets/diagram.png": PNG.toString("latin1"),
  "docs/notes.txt": "not a page",
  "secret.png": "outside",
};

async function ready(root: string, extra = {}): Promise<DevDocs> {
  const opened = await openDocs({
    base: root,
    documentation: { dir: "./docs", ...extra },
    warn: () => {},
  });
  if (opened.status !== "ready") throw new Error(JSON.stringify(opened));
  return opened.docs;
}

describe("DevDocs", () => {
  it("builds the page tree from folders, titles, and meta.json", async () => {
    const root = await project(FILES);
    const docs = await ready(root);
    try {
      const { tree, components, revision } = docs.info();
      expect(revision).toBe(1);
      expect(components).toBe(false);
      expect(tree.name).toBe("Orders docs");
      expect(tree.children).toEqual([
        {
          type: "page",
          name: "Welcome",
          url: "/",
          description: "Start here",
        },
        { type: "separator", name: "Guides" },
        {
          type: "folder",
          name: "Guide",
          children: [
            { type: "page", name: "Setup", url: "/guide/setup" },
            // No frontmatter title: the first heading names the page.
            { type: "page", name: "Deploy it", url: "/guide/deploy" },
          ],
        },
        { type: "page", name: "Broken", url: "/reference" },
      ]);
    } finally {
      docs.close();
    }
  });

  it("compiles a page to MDX with headings, highlighted code, and routes for links", async () => {
    const root = await project(FILES);
    const docs = await ready(root);
    try {
      const page = await docs.page(["guide", "setup"]);
      expect(page).toMatchObject({
        title: "Setup",
        path: "guide/setup.mdx",
        slugs: ["guide", "setup"],
      });
      expect(page!.error).toBeUndefined();
      expect(page!.toc).toEqual([
        { title: "Install", url: "#install", depth: 2 },
        { title: "Config file", url: "#config-file", depth: 2 },
      ]);
      // Function-body MDX: it takes its components from the page that runs it.
      expect(page!.code).toContain("arguments[0]");
      expect(page!.code).toContain("Callout");
      // Shiki's output for both themes travels with the page.
      expect(page!.code).toContain("--shiki-light");
      expect(page!.code).toContain("--shiki-dark");
      // Links to other pages are dashboard routes; images come from the folder.
      expect(page!.code).toContain("#/docs/guide/deploy");
      expect(page!.code).toContain('"#/docs"');
      expect(page!.code).toContain("/api/docs/files/assets/diagram.png");

      // The href of a component is a route too, so a click stays in the dashboard.
      expect(page!.code).toContain('href: "#/docs/guide/deploy"');
      expect(page!.code).toContain('href: "#/docs/guide/deploy#ship"');
      expect(page!.code).toContain('href: "https://example.com/x"');
      // A link to a missing page still stays here, and says so on arrival.
      expect(page!.code).toContain("#/docs/guide/gone");
      // Files other than pages are left as they were written.
      expect(page!.code).toContain("../assets/spec.pdf");

      const home = await docs.page([]);
      expect(home!.code).toContain("#/docs/guide/setup#install");
      // The page's title is shown above the content, so a heading that repeats
      // it is left out, here and for a title taken from the heading.
      expect(home!.toc).toEqual([]);
      expect(home!.code).not.toContain("Welcome");
      expect((await docs.page(["guide", "deploy"]))!.code).not.toContain(
        "Deploy it",
      );
      expect(await docs.page(["nope"])).toBeUndefined();
    } finally {
      docs.close();
    }
  });

  it("returns a page's compile error instead of throwing", async () => {
    const root = await project(FILES);
    const docs = await ready(root);
    try {
      const page = await docs.page(["reference"]);
      expect(page).toMatchObject({ title: "Broken", code: "", toc: [] });
      expect(page!.error).toContain("Unclosed");
    } finally {
      docs.close();
    }
  });

  it("searches titles, headings, and text, giving a route for each hit", async () => {
    const root = await project(FILES);
    const docs = await ready(root);
    try {
      const hits = await docs.search("container production");
      expect(hits.map((hit) => hit.url)).toContain("/guide/deploy");
      const install = await docs.search("install");
      expect(install.some((hit) => hit.url === "/guide/setup#install")).toBe(
        true,
      );
      expect(await docs.search("   ")).toEqual([]);
      expect(await docs.search("zzzz-no-match")).toEqual([]);
    } finally {
      docs.close();
    }
  });

  it("serves images from the docs folder and nothing outside it", async () => {
    const root = await project(FILES);
    const docs = await ready(root);
    try {
      const image = await docs.file("assets/diagram.png");
      expect(image?.type).toBe("image/png");
      expect(image?.body.byteLength).toBeGreaterThan(0);
      // Not an image, outside the folder, missing, or a directory.
      expect(await docs.file("notes.txt")).toBeUndefined();
      expect(await docs.file("../secret.png")).toBeUndefined();
      expect(await docs.file("assets/../../secret.png")).toBeUndefined();
      expect(await docs.file("assets/missing.png")).toBeUndefined();
      expect(await docs.file("assets")).toBeUndefined();
    } finally {
      docs.close();
    }
  });

  it("notices edits, new pages, and removed pages", async () => {
    const root = await project(FILES);
    const docs = await ready(root);
    try {
      const changes: number[] = [];
      docs.onChange(() => changes.push(docs.revision));

      await writeFile(
        join(root, "docs/guide/faq.mdx"),
        "---\ntitle: FAQ\n---\n\n# Questions\n",
      );
      await waitFor(() => changes.length > 0);
      const names = () =>
        docs
          .info()
          .tree.children.flatMap((node) =>
            node.type === "folder"
              ? node.children.map((c) => (c.type === "page" ? c.name : ""))
              : [],
          );
      expect(names()).toContain("FAQ");
      expect(docs.revision).toBeGreaterThan(1);

      // Edited content is compiled again, not served from before.
      await writeFile(
        join(root, "docs/guide/faq.mdx"),
        "---\ntitle: FAQ\n---\n\n# Questions\n\nA fresh answer.\n",
      );
      await waitFor(async () =>
        (await docs.page(["guide", "faq"]))!.code.includes("fresh answer"),
      );

      await rm(join(root, "docs/guide/faq.mdx"));
      await waitFor(
        async () => (await docs.page(["guide", "faq"])) === undefined,
      );
      expect(names()).not.toContain("FAQ");
    } finally {
      docs.close();
    }
  });

  it("stops watching once closed", async () => {
    const root = await project(FILES);
    const docs = await ready(root);
    let changes = 0;
    docs.onChange(() => changes++);
    docs.close();
    await writeFile(join(root, "docs/late.mdx"), "# Late\n");
    await Bun.sleep(400);
    expect(changes).toBe(0);
  });
});

describe("openDocs", () => {
  it("says so when the docs folder does not exist", async () => {
    const root = await project({});
    const opened = await openDocs({
      base: root,
      documentation: { dir: "./docs" },
      warn: () => {},
    });
    expect(opened.status).toBe("error");
    expect((opened as { message: string }).message).toContain("does not exist");
  });

  it("warns about, and skips, an invalid meta.json or frontmatter", async () => {
    const root = await project({
      "docs/meta.json": "{ not json",
      "docs/a.mdx": "---\ntitle: [unclosed\n---\n\n# Heading A\n",
    });
    const warnings: string[] = [];
    const opened = await openDocs({
      base: root,
      documentation: { dir: "./docs" },
      warn: (message) => warnings.push(message),
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    try {
      expect(warnings.join("\n")).toContain("meta.json");
      expect(warnings.join("\n")).toContain("frontmatter");
      // The page still shows, titled from its first heading.
      expect(opened.docs.info().tree.children).toEqual([
        { type: "page", name: "Heading A", url: "/a" },
      ]);
    } finally {
      opened.docs.close();
    }
  });
});

describe("components", () => {
  it("bundles the project's components, leaving React to the dashboard", async () => {
    const root = await project({
      "docs/index.mdx": "# Hi\n",
      "docs/components.tsx": `import { useState } from "react";
import { shout } from "./shout";
export const Counter = () => {
  const [count] = useState(0);
  return <b>{shout("count")}{count}</b>;
};
export default { Counter };
`,
      "docs/shout.ts":
        "export const shout = (text: string) => text.toUpperCase();\n",
    });
    const docs = await ready(root, { components: "./docs/components.tsx" });
    try {
      expect(docs.info().components).toBe(true);
      const code = (await docs.components())!;
      // Imported modules are inlined; React is imported by name for the import map.
      expect(code).toContain("toUpperCase");
      expect(code).toMatch(/from\s*["']react["']/);
      expect(code).toMatch(/from\s*["']react\/jsx-(dev-)?runtime["']/);
      expect(code).toContain("Counter");
    } finally {
      docs.close();
    }
  });

  it("reports a module that does not build", async () => {
    const root = await project({ "components.tsx": "export const x = ;\n" });
    await expect(
      bundleComponents(join(root, "components.tsx")),
    ).rejects.toThrow();
  });

  it("has no bundle when the project has no components module", async () => {
    const root = await project(FILES);
    const docs = await ready(root);
    try {
      expect(await docs.components()).toBeUndefined();
    } finally {
      docs.close();
    }
  });
});

describe("DocsHost", () => {
  it("follows the app's documentation setting and tells the store", async () => {
    const root = await project(FILES);
    const store = new DevTelemetryStore();
    const events: (string | null)[] = [];
    store.subscribe((event) => {
      if (event.type === "docs") events.push(event.docs?.status ?? null);
    });
    const host = new DocsHost(
      (docs) => store.setDocs(docs),
      () => {},
    );
    try {
      expect(store.snapshot().docs).toBeNull();

      await host.configure(root, { dir: "./docs" });
      expect(host.current).toBeDefined();
      expect(store.snapshot().docs).toMatchObject({
        status: "ready",
        title: "Orders docs",
        components: false,
        revision: 1,
      });

      // Asking again for the same folder keeps what is open.
      const first = host.current;
      await host.configure(root, { dir: "./docs" });
      expect(host.current).toBe(first);
      expect(events).toEqual(["ready"]);

      // Edits reach the store as a new revision.
      await writeFile(join(root, "docs/extra.mdx"), "# Extra\n");
      await waitFor(() => store.snapshot().docs?.revision === 2);

      // An app that drops `documentation` closes them.
      await host.configure(root, undefined);
      expect(host.current).toBeUndefined();
      expect(store.snapshot().docs).toBeNull();
    } finally {
      host.close();
    }
  });

  it("shows why the docs are unavailable instead of failing the app", async () => {
    const root = await project({});
    const store = new DevTelemetryStore();
    const warnings: string[] = [];
    const host = new DocsHost(
      (docs) => store.setDocs(docs),
      (message) => warnings.push(message),
    );
    try {
      await host.configure(root, { dir: "./nowhere" });
      expect(host.current).toBeUndefined();
      expect(store.snapshot().docs).toMatchObject({
        status: "error",
        message: expect.stringContaining("does not exist"),
      });
      expect(warnings.join("\n")).toContain("Docs are off");
    } finally {
      host.close();
    }
  });
});

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(40);
  }
  throw new Error("Timed out waiting for the docs to change");
}

describe("under Node", () => {
  // The Vite dev server runs under Node, where there is no Bun.build and the
  // project's components are bundled by Vite instead.
  it("opens the docs, compiles a page, and bundles components", async () => {
    const root = await project({
      "docs/index.mdx":
        "---\ntitle: Home\n---\n\n## Part\n\nHello <Thing />.\n",
      "docs/components.tsx":
        "export const Thing = () => <i>thing</i>;\nexport const components = { Thing };\n",
    });
    // Bundled inside the package, so Node finds fumadocs-core and Vite there.
    const out = await mkdtemp(resolve(import.meta.dir, "../.brick-node-docs-"));
    roots.push(out);
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/dev-docs.ts")],
      outdir: out,
      target: "node",
      format: "esm",
      packages: "external",
    });
    expect(built.success).toBe(true);
    const script = `
      import { openDocs } from ${JSON.stringify(join(out, "dev-docs.js"))};
      const opened = await openDocs({ base: ${JSON.stringify(root)},
        documentation: { dir: "./docs", components: "./docs/components.tsx" }, warn: console.warn });
      if (opened.status !== "ready") { console.log(JSON.stringify(opened)); process.exit(0); }
      const docs = opened.docs;
      const page = await docs.page([]);
      const bundle = await docs.components();
      const hits = await docs.search("part");
      docs.close();
      console.log(JSON.stringify({ runtime: process.versions.bun ? "bun" : "node",
        error: page.error, toc: page.toc, shiki: page.code.includes("Thing"),
        bundleHasThing: bundle.includes("Thing"),
        bundleImportsReact: /from\\s*["']react\\/jsx-(dev-)?runtime["']/.test(bundle),
        hits: hits.length > 0 }));
    `;
    const result = Bun.spawnSync(
      ["node", "--input-type=module", "-e", script],
      {
        stderr: "pipe",
      },
    );
    expect(result.stderr.toString()).not.toContain("Error");
    expect(JSON.parse(result.stdout.toString())).toEqual({
      runtime: "node",
      toc: [{ title: "Part", url: "#part", depth: 2 }],
      shiki: true,
      bundleHasThing: true,
      bundleImportsReact: true,
      hits: true,
    });
  }, 60000);
});
