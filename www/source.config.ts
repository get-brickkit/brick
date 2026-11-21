import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { pageSchema } from "fumadocs-core/source/schema";
import { z } from "zod";
import {
  docsMarkdownOptions,
  remarkDocsMarkdown,
} from "./src/lib/docs-markdown";
import { codeThemes } from "./src/lib/code-theme";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    lastModified: true,
    postprocess: {
      includeProcessedMarkdown: docsMarkdownOptions,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkDocsMarkdown],
    rehypeCodeOptions: { themes: codeThemes },
  },
});

export const blog = defineDocs({
  dir: "content/blog",
  docs: {
    lastModified: true,
    schema: pageSchema.extend({
      description: z.string(),
      date: z.iso.date(),
      category: z.enum(["release", "guide"]),
      author: z.string().default("BrickKit team"),
      version: z.string().optional(),
    }),
  },
});
