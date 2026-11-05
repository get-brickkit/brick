import {
  Component,
  Fragment,
  createContext,
  useContext,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import defaultMdxComponents from "@fumadocs/base-ui/mdx";
import "@fumadocs/base-ui/components/image-zoom2.css";
import { Accordion, Accordions } from "@fumadocs/base-ui/components/accordion";
import { Banner } from "@fumadocs/base-ui/components/banner";
import { Callout } from "@fumadocs/base-ui/components/callout";
import { CodeBlock, Pre } from "@fumadocs/base-ui/components/codeblock";
import { File, Files, Folder } from "@fumadocs/base-ui/components/files";
import { ImageZoom } from "@fumadocs/base-ui/components/image-zoom";
import { InlineTOC } from "@fumadocs/base-ui/components/inline-toc";
import { Step, Steps } from "@fumadocs/base-ui/components/steps";
import { Tab, Tabs } from "@fumadocs/base-ui/components/tabs";
import { TypeTable } from "@fumadocs/base-ui/components/type-table";
import type { DocsHeading } from "../../../src/dashboard-protocol";

/** The headings of the page being shown, for components that list them. */
export const PageHeadings = createContext<DocsHeading[]>([]);

/** `<InlineTOC />` lists the page's own headings unless given `items`. */
function PageInlineTOC(props: Partial<React.ComponentProps<typeof InlineTOC>>) {
  const headings = useContext(PageHeadings);
  return <InlineTOC items={headings} {...props} />;
}

/** `<DynamicCodeBlock lang code />`, without highlighting in the browser. */
function DynamicCodeBlock({
  code,
  title,
}: {
  lang?: string;
  code: string;
  title?: string;
}) {
  return (
    <CodeBlock title={title}>
      <Pre>
        <code>{code}</code>
      </Pre>
    </CodeBlock>
  );
}

/** Fumadocs components that need a build step or the network to work. */
function unavailable(name: string): ComponentType {
  const Unavailable = () => (
    <Callout type="warn" title={`<${name}> is not available here`}>
      It needs a build step or the network, so it shows on your docs site but
      not in the dashboard.
    </Callout>
  );
  return Unavailable;
}

/**
 * What a page can use without importing: Fumadocs' MDX components, then the
 * project's own, which may replace any of them.
 */
export function mdxComponents(
  project: Record<string, ComponentType<never>> = {},
): Record<string, ComponentType<never>> {
  return {
    ...defaultMdxComponents,
    img: (props: React.ComponentProps<"img">) => (
      <ImageZoom {...(props as React.ComponentProps<typeof ImageZoom>)} />
    ),
    Callout,
    Tabs,
    Tab,
    Steps,
    Step,
    Accordions,
    Accordion,
    Files,
    File,
    Folder,
    TypeTable,
    Banner,
    InlineTOC: PageInlineTOC,
    DynamicCodeBlock,
    AutoTypeTable: unavailable("AutoTypeTable"),
    GithubInfo: unavailable("GithubInfo"),
    GraphView: unavailable("GraphView"),
    ...project,
  } as Record<string, ComponentType<never>>;
}

type MdxContent = ComponentType<{
  components?: Record<string, ComponentType<never>>;
}>;

/**
 * Run a page compiled to a function body. The compiled code takes the JSX
 * runtime as its argument and returns the page's component.
 */
export function runMdx(code: string): MdxContent {
  const run = new Function(code) as (runtime: unknown) => {
    default: MdxContent;
  };
  return run({ Fragment, jsx, jsxs }).default;
}

/** Shows what went wrong in a page instead of blanking the whole view. */
export class PageErrorBoundary extends Component<
  { reset: unknown[]; children: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Docs page failed to render", error, info.componentStack);
  }

  componentDidUpdate(previous: { reset: unknown[] }) {
    // A new page, or newly loaded components, deserve another try.
    const changed = previous.reset.some(
      (value, index) => value !== this.props.reset[index],
    );
    if (changed && this.state.error) this.setState({ error: undefined });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // MDX throws this when a page uses a component nobody provided.
    const missing = /Expected component `([^`]+)` to be defined/.exec(
      error.message,
    );
    return (
      <Callout
        type="error"
        title={
          missing
            ? `<${missing[1]}> is not defined`
            : "This page failed to render"
        }
      >
        {missing
          ? `Export ${missing[1]} from the file named in documentation.components, or import it in the page.`
          : error.message}
      </Callout>
    );
  }
}
