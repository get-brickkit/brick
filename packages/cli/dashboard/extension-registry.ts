import type { ComponentType, ReactNode } from "react";
import type { TraceSummary } from "../src/dashboard-protocol";
import type { Route, View } from "./state";

/*
 * A project's dashboard extension: what `defineDashboard` takes, and how its
 * pages and links join the built-in sidebar. Kept free of React so the merge
 * has tests of its own (`../test/dashboard-extension.test.ts`).
 */

/** What every slot, page and drawer tab receives. */
export interface SlotContext {
  /** Where the dashboard is: `#/x/queues/42` is `{ view: "x", page: "queues", path: ["42"] }`. */
  route: Route;
  /** The theme in effect, after following the system setting. */
  theme: "light" | "dark";
  /** The read-only dashboard of `brick start`, not `brick dev`. */
  production: boolean;
  /** The request open in the Requests view, when one is. */
  selectedRequestId?: string;
}

export interface SidebarSlotContext extends SlotContext {
  /** Whether the sidebar shows labels, or only its icon rail. */
  expanded: boolean;
}

export interface DrawerTabContext extends SlotContext {
  /** The request the drawer shows; undefined while its spans load. */
  request: TraceSummary | undefined;
}

/** A tab of the request drawer, beside its own Details. */
export interface DrawerTab {
  id: string;
  label: string;
  component: ComponentType<DrawerTabContext>;
}

/** The fixed places an extension can fill. */
export interface DashboardSlots {
  "topbar.start"?: ComponentType<SlotContext>;
  "topbar.end"?: ComponentType<SlotContext>;
  "sidebar.header"?: ComponentType<SidebarSlotContext>;
  "sidebar.footer"?: ComponentType<SidebarSlotContext>;
  "overview.top"?: ComponentType<SlotContext>;
  "request.drawer.tabs"?: DrawerTab[];
}

export type SlotName = keyof DashboardSlots;

export interface PageProps extends SlotContext {
  /** The address after the page's own: `#/x/queues/a/b` gives `["a", "b"]`. */
  path: string[];
}

/** Where a page or link sits in the sidebar. */
export interface Placement {
  /** After this page: a built-in one (`"overview"`) or another extension page's id. */
  after?: string;
  /** Under this heading, below the built-in pages. `after` wins when both are set. */
  section?: string;
  /** Show it in the production dashboard of `brick start` too. */
  production?: boolean;
}

interface PageBase extends Placement {
  /** Its address is `#/x/<id>`: letters, digits and dashes. */
  id: string;
  label: string;
  icon?: ReactNode;
}

export type ExtensionPage =
  | (PageBase & { component: ComponentType<PageProps>; url?: undefined })
  /** A page shown in a frame. It cannot fill slots or follow the theme. */
  | (PageBase & { url: string; component?: undefined });

/** A sidebar link. One to another site opens in a new tab. */
export interface SidebarLink extends Placement {
  label: string;
  icon?: ReactNode;
  href: string;
}

export interface DashboardExtension {
  /** Wraps the whole dashboard: providers, analytics, feature flags. */
  root?: ComponentType<{ children: ReactNode }>;
  slots?: DashboardSlots;
  pages?: ExtensionPage[];
  sidebar?: SidebarLink[];
}

/** Declare the dashboard extension; the module's default export. */
export function defineDashboard<T extends DashboardExtension>(extension: T): T {
  return extension;
}

/**
 * The app's extension and its plugins' as one, in order: the app's comes
 * first and keeps its slots (drawer tabs add up), a page whose id is taken is
 * skipped, and a plugin's pages without a place go under a section named after
 * it. Roots are left to the caller, which nests them.
 */
export function mergeExtensions(
  parts: readonly {
    name: string;
    plugin: boolean;
    extension: DashboardExtension;
  }[],
): DashboardExtension {
  const pages: ExtensionPage[] = [];
  const sidebar: SidebarLink[] = [];
  const slots: Record<string, unknown> = {};
  for (const { name, plugin, extension } of parts) {
    for (const page of extension.pages ?? []) {
      if (pages.some((item) => item.id === page.id)) {
        console.error(
          `[Brick dashboard] Extension ${name}: page id ${page.id} is taken; skipped.`,
        );
        continue;
      }
      pages.push(
        plugin && !page.after && !page.section
          ? { ...page, section: name }
          : page,
      );
    }
    sidebar.push(...(extension.sidebar ?? []));
    for (const [slot, value] of Object.entries(extension.slots ?? {})) {
      if (slot === "request.drawer.tabs")
        slots[slot] = [
          ...((slots[slot] as DrawerTab[]) ?? []),
          ...(value as DrawerTab[]),
        ];
      else if (!(slot in slots)) slots[slot] = value;
    }
  }
  return { pages, sidebar, slots: slots as DashboardSlots };
}

/** One entry of the sidebar. */
export interface NavItem {
  /** A built-in view's name, an extension page's id, or `link:<n>`. */
  key: string;
  label: string;
  icon?: ReactNode;
  href: string;
  /** A built-in page. */
  view?: View;
  /** An extension page. */
  page?: ExtensionPage;
  /** Opens in a new tab. */
  external?: boolean;
  section?: string;
}

const PAGE_ID = /^[a-z0-9][a-z0-9-]*$/i;

export function pageHref(id: string): string {
  return `#/x/${encodeURIComponent(id)}`;
}

/** The sidebar entry a route belongs to. */
export function routeKey(route: Route): string {
  return route.view === "x" ? (route.page ?? "") : route.view;
}

/**
 * The built-in sidebar with the extension's pages and links placed in it.
 * Throws for a page id that is malformed, taken by a built-in page or used
 * twice, and for an `after` that names no page. In production only what is
 * marked `production: true` stays.
 */
export function mergeNav(
  builtIn: NavItem[],
  extension: DashboardExtension | undefined,
  production: boolean,
): NavItem[] {
  if (!extension) return builtIn;
  const ids = new Set<string>();
  const added: (NavItem & Placement)[] = [];
  for (const page of extension.pages ?? []) {
    if (typeof page.id !== "string" || !PAGE_ID.test(page.id))
      throw new Error(
        `Dashboard extension: page id "${String(page.id)}" must be letters, digits and dashes.`,
      );
    if (builtIn.some((item) => item.key === page.id))
      throw new Error(
        `Dashboard extension: page id "${page.id}" is a built-in page's.`,
      );
    if (ids.has(page.id))
      throw new Error(
        `Dashboard extension: two pages have the id "${page.id}".`,
      );
    if (!page.component === !page.url)
      throw new Error(
        `Dashboard extension: page "${page.id}" needs a component or a url, not both.`,
      );
    ids.add(page.id);
    added.push({
      ...placement(page),
      key: page.id,
      label: page.label,
      icon: page.icon,
      href: pageHref(page.id),
      page,
    });
  }
  for (const [index, link] of (extension.sidebar ?? []).entries())
    added.push({
      ...placement(link),
      key: `link:${index}`,
      label: link.label,
      icon: link.icon,
      href: link.href,
      external: /^[a-z][a-z\d+.-]*:/i.test(link.href),
    });

  const nav: (NavItem & Placement)[] = [...builtIn];
  const sections: (NavItem & Placement)[] = [];
  for (const item of added) {
    if (item.after !== undefined) continue;
    if (item.section !== undefined) sections.push(item);
    else nav.push(item);
  }
  // Each section's entries together, in the order the sections first appear.
  const order = [...new Set(sections.map((item) => item.section))];
  for (const section of order)
    nav.push(...sections.filter((item) => item.section === section));
  // Placed in the order given; one `after` may name a page declared later.
  let waiting = added.filter((item) => item.after !== undefined);
  while (waiting.length) {
    const left = waiting.filter((item) => {
      const at = nav.findIndex((other) => other.key === item.after);
      if (at < 0) return true;
      nav.splice(at + 1, 0, { ...item, section: nav[at]!.section });
      return false;
    });
    if (left.length === waiting.length)
      throw new Error(
        `Dashboard extension: "${left[0]!.label}" is placed after "${left[0]!.after}", which is no page.`,
      );
    waiting = left;
  }
  return nav
    .filter((item) => !production || item.view || item.production)
    .map(({ after: _after, production: _production, ...item }) => item);
}

function placement(item: Placement): Placement {
  return {
    after: item.after,
    section: item.section,
    production: item.production === true,
  };
}
