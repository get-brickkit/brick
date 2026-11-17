import { site } from "./site";

export const marketingPages = {
  "/": { title: site.title, description: site.description },
  "/brand": {
    title: "Brick logo and brand assets",
    description:
      "Download the Brick logo, see the angular knot mark, and read the guidelines for using it.",
  },
  "/blog": {
    title: "Brick blog: releases and guides",
    description:
      "Release notes for Brick and guides to building TypeScript backends on Bun: REST APIs, typed clients, events and the dev dashboard.",
  },
  "/examples": {
    title: "Brick examples: TypeScript backend apps you can run",
    description:
      "Runnable Brick apps on Bun, each with its service graph, HTTP routes, database tables and source code.",
  },
};

export function socialImagePath(path: string) {
  return `/og${path === "/" ? "/index" : path.replace(/\/$/, "")}.png`;
}

export function socialMeta({
  title,
  description,
  path,
  type = "website",
}: {
  title: string;
  description: string;
  path: string;
  type?: "website" | "article";
}) {
  const image = new URL(socialImagePath(path), site.url).href;
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: type },
    {
      property: "og:url",
      content: new URL(path.replace(/\/+$/, "") || "/", site.url).href,
    },
    { property: "og:site_name", content: site.name },
    { property: "og:image", content: image },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: title },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
    { name: "twitter:image:alt", content: title },
  ];
}
