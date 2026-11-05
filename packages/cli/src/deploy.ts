// `brick build --deploy <targets>`: production routing for every deploy
// target, all generated from one routing table. Browsers reach the Go and
// Rust services directly through the proxy; everything else goes to Bun.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { kebabCase, remoteEnv, type BrickApp } from "@brickkit/core";
import {
  DEPLOY_TARGETS,
  type DeployOptions,
  type DeployTarget,
} from "./config";

export { DEPLOY_TARGETS, type DeployOptions, type DeployTarget };

/**
 * Headers only another service may send, with the internal token. Every proxy strips them.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export const BRICK_HEADERS = [
  "X-Brick-Internal",
  "X-Brick-User",
  "X-Brick-Caller",
  "X-Brick-Tenant",
];

/** @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release. */
export interface Upstream {
  /** Its name: `app`, or the kebab-case service name; the host name in compose and Kubernetes. */
  name: string;
  /** `host:port` the proxy forwards to. */
  address: string;
  port: number;
  language: "ts" | "go" | "rust";
  /** Go and Rust: the service folder and its build, from `remoteService`. */
  dir?: string;
  build?: { command: string; run: string };
  /**
   * Go and Rust: the Docker build context, relative to the project root. It is
   * the project root, or a folder above it when a Go `replace` or Cargo `path`
   * dependency points outside it (an SDK checkout, a monorepo package).
   */
  context?: string;
  /** Go and Rust: the folders the Dockerfile copies, relative to `context`; the service's own last. */
  sources?: string[];
  /** Go and Rust: the project root, relative to `context`. */
  project?: string;
  /** The process's environment in compose and Kubernetes. */
  env: Record<string, string>;
}

/**
 * The neutral routing table: `deploy/routes/routes.json`, and the input of every generator.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export interface RoutingTable {
  domain?: string;
  /** Request headers every proxy removes. */
  stripHeaders: string[];
  upstreams: Upstream[];
  /** Most specific first; the last is `/` to the app. */
  routes: { path: string; upstream: string }[];
  app: { build: string; start: string };
}

/** @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release. */
export interface RoutingTableOptions extends DeployOptions {
  /** Override `host:port` per upstream name (the benchmark points them at the host). */
  addresses?: Record<string, string>;
  /** Where the remote services' `dir`s are relative to (default the working directory). */
  cwd?: string;
}

/** The folders outside `dir` its Go `replace` or Cargo `path` dependencies point to. */
function localDependencies(dir: string, language: "go" | "rust"): string[] {
  const manifest = readFileSync(
    join(dir, language === "go" ? "go.mod" : "Cargo.toml"),
    "utf8",
  );
  const paths =
    language === "go"
      ? [...manifest.matchAll(/=>\s*(\.\.?\/[^\s]*)/g)]
      : [...manifest.matchAll(/\bpath\s*=\s*"([^"]+)"/g)];
  return paths
    .map((match) => resolve(dir, match[1]!))
    .filter((path) => relative(dir, path).startsWith(".."));
}

/** The build context and what to copy: the closest folder holding the project and every local dependency. */
function buildContext(root: string, dir: string, language: "go" | "rust") {
  const service = resolve(root, dir);
  const folders = [...localDependencies(service, language), service];
  let context = resolve(root);
  for (const folder of folders)
    while (
      relative(context, folder).startsWith("..") &&
      dirname(context) !== context
    )
      context = dirname(context);
  return {
    context: relative(root, context) || ".",
    sources: folders.map((folder) => relative(context, folder)),
    project: relative(context, root) || ".",
  };
}

function languageOf(dir: string): "go" | "rust" {
  if (existsSync(join(dir, "go.mod"))) return "go";
  if (existsSync(join(dir, "Cargo.toml"))) return "rust";
  throw new Error(`Brick: ${dir} has neither go.mod nor Cargo.toml.`);
}

/**
 * Build the routing table: `/api/<service>/` to each Go or Rust service, the rest to Bun.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function routingTable(
  app: BrickApp,
  options: RoutingTableOptions = {},
): RoutingTable {
  const { prefix, services, remote = [] } = app.definition;
  const base = prefix.replace(/\/$/, "");
  const appPort = options.app?.port ?? 3000;
  const address = (name: string, port: number) =>
    options.addresses?.[name] ?? `${name}:${port}`;
  const issuer = options.domain
    ? `https://${options.domain}`
    : "http://localhost";
  const appUrl = `http://app:${appPort}`;
  const urls: Record<string, string> = {};
  for (const service of services)
    urls[service.name] = `${appUrl}/_brick/call/${kebabCase(service.name)}`;
  const remotes = remote.map((service, i) => {
    const name = kebabCase(service.name);
    const port = service.options.port ?? 4001 + i;
    urls[service.name] = `http://${name}:${port}`;
    return { service, name, port };
  });
  const shared = {
    BRICK_SERVICES: JSON.stringify(urls),
    BRICK_INTERNAL_TOKEN:
      "${BRICK_INTERNAL_TOKEN:?set BRICK_INTERNAL_TOKEN, a long random secret}",
  };
  const upstreams: Upstream[] = [
    {
      name: "app",
      address: address("app", appPort),
      port: appPort,
      language: "ts",
      env: {
        NODE_ENV: "production",
        PORT: String(appPort),
        ...(remote.length ? shared : {}),
      },
    },
    ...remotes.map(({ service, name, port }) => {
      const root = resolve(options.cwd ?? ".");
      const language = languageOf(resolve(root, service.options.dir));
      return {
        name,
        address: address(name, port),
        port,
        language,
        dir: service.options.dir,
        build: service.options.build,
        ...buildContext(root, service.options.dir, language),
        env: {
          ...shared,
          BRICK_HOST: "0.0.0.0",
          BRICK_PORT: String(port),
          BRICK_PREFIX: base || "/",
          BRICK_JWT_ISSUER: `\${BRICK_JWT_ISSUER:-${issuer}}`,
          BRICK_JWKS_URL: `${appUrl}/api/auth/jwks`,
          ...remoteEnv(app.definition),
        },
      };
    }),
  ];
  return {
    ...(options.domain ? { domain: options.domain } : {}),
    stripHeaders: BRICK_HEADERS,
    upstreams,
    routes: [
      ...remotes.map(({ name }) => ({
        path: `${base}/${name}/`,
        upstream: name,
      })),
      { path: "/", upstream: "app" },
    ],
    app: {
      build: options.app?.build ?? "bun x brick build",
      start: options.app?.start ?? "bun dist/brick/server.js",
    },
  };
}

const HEADER =
  "Generated by brick build --deploy. Rerun it instead of editing.";
const upstreamOf = (table: RoutingTable, name: string) =>
  table.upstreams.find((u) => u.name === name)!;
const ident = (name: string) => name.replace(/-/g, "_");

/** @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release. */
export function routesJson(table: RoutingTable): string {
  return `${JSON.stringify(table, null, 2)}\n`;
}

/** Idle keep-alive connections each proxy keeps per upstream. */
const KEEPALIVE = 256;

/**
 * Caddyfile: automatic HTTPS for the domain, and a keep-alive pool per upstream.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function caddyfile(table: RoutingTable): string {
  const handles = table.routes.map(({ path, upstream }) => {
    // Caddy keeps 32 idle upstream connections by default: past 32 concurrent
    // requests it would open and close one per request, until ports run out.
    const proxy = `reverse_proxy ${upstreamOf(table, upstream).address} {\n\t\t\ttransport http {\n\t\t\t\tkeepalive_idle_conns_per_host ${KEEPALIVE}\n\t\t\t}\n\t\t}`;
    return path === "/"
      ? `\thandle {\n\t\t${proxy}\n\t}`
      : `\thandle ${path}* {\n\t\t${proxy}\n\t}`;
  });
  return `# ${HEADER}
${table.domain ?? ":80"} {
${table.stripHeaders.map((h) => `\trequest_header -${h}`).join("\n")}

${handles.join("\n\n")}
}
`;
}

/**
 * nginx.conf: one keep-alive upstream per process.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function nginxConf(table: RoutingTable): string {
  const upstreams = table.upstreams.map(
    (u) =>
      `    upstream ${ident(u.name)} {\n        server ${u.address};\n        keepalive ${KEEPALIVE};\n    }`,
  );
  const locations = table.routes.map(
    ({ path, upstream }) =>
      `        location ${path} {\n            proxy_pass http://${ident(upstream)};\n        }`,
  );
  return `# ${HEADER}
events {}

http {
${upstreams.join("\n\n")}

    server {
        listen 80;
        server_name ${table.domain ?? "_"};

        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
${table.stripHeaders.map((h) => `        proxy_set_header ${h} "";`).join("\n")}

${locations.join("\n\n")}
    }
}
`;
}

/**
 * Traefik: the static config (`traefik.yml`) loads the routes from the file provider (`dynamic.yml`).
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function traefikConfig(table: RoutingTable): Record<string, string> {
  const tls = table.domain !== undefined;
  const entryPoint = tls ? "websecure" : "web";
  const routers = table.routes.map(({ path, upstream }, i) => {
    const rule = [
      tls ? `Host(\`${table.domain}\`)` : "",
      `PathPrefix(\`${path}\`)`,
    ]
      .filter(Boolean)
      .join(" && ");
    return `    ${upstream}:
      rule: "${rule}"
      service: ${upstream}
      entryPoints: [${entryPoint}]
      middlewares: [strip-brick-headers]
      priority: ${table.routes.length - i}${tls ? "\n      tls:\n        certResolver: brick" : ""}`;
  });
  const services = table.upstreams.map(
    (u) => `    ${u.name}:
      loadBalancer:
        servers:
          - url: "http://${u.address}"`,
  );
  const acme = tls
    ? `  websecure:
    address: ":443"

certificatesResolvers:
  brick:
    acme:
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web
`
    : "";
  return {
    "traefik.yml": `# ${HEADER}
entryPoints:
  web:
    address: ":80"
${tls ? `    http:\n      redirections:\n        entryPoint:\n          to: websecure\n          scheme: https\n` : ""}${acme}
providers:
  file:
    filename: /etc/traefik/dynamic.yml
`,
    "dynamic.yml": `# ${HEADER}
http:
  middlewares:
    strip-brick-headers:
      headers:
        customRequestHeaders:
${table.stripHeaders.map((h) => `          ${h}: ""`).join("\n")}

  routers:
${routers.join("\n\n")}

  services:
${services.join("\n\n")}
`,
  };
}

const yamlEnv = (env: Record<string, string>, indent: string) =>
  Object.entries(env).map(
    ([key, value]) => `${indent}${key}: ${JSON.stringify(value)}`,
  );

/**
 * Kubernetes: a Deployment and a Service per process, and an Ingress routing
 * by path. `BRICK_INTERNAL_TOKEN` comes from the Secret `brick`. The Ingress
 * API can't strip headers portably; the SDKs ignore `x-brick-*` without the
 * token, so that is the guard here.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function kubernetesYaml(table: RoutingTable): string {
  const docs = table.upstreams.flatMap((u) => {
    const env = Object.entries(u.env).map(([key, value]) =>
      // Without a domain the public URL is unknown: the issuer comes from the Secret too.
      key === "BRICK_INTERNAL_TOKEN" ||
      (key === "BRICK_JWT_ISSUER" && !table.domain)
        ? `            - name: ${key}
              valueFrom:
                secretKeyRef: { name: brick, key: ${key} }`
        : `            - name: ${key}
              value: ${JSON.stringify(value.replace(/\$\{BRICK_JWT_ISSUER:-(.*)\}/, "$1"))}`,
    );
    return [
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${u.name}
spec:
  replicas: 1
  selector:
    matchLabels: { app: ${u.name} }
  template:
    metadata:
      labels: { app: ${u.name} }
    spec:
      containers:
        - name: ${u.name}
          image: ${u.name}:latest
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: ${u.port}
          env:
${env.join("\n")}`,
      `apiVersion: v1
kind: Service
metadata:
  name: ${u.name}
spec:
  selector: { app: ${u.name} }
  ports:
    - port: ${u.port}
      targetPort: ${u.port}`,
    ];
  });
  const paths = table.routes.map(
    ({ path, upstream }) => `          - path: ${path}
            pathType: Prefix
            backend:
              service:
                name: ${upstream}
                port: { number: ${upstreamOf(table, upstream).port} }`,
  );
  const tls = table.domain
    ? `  tls:
    - hosts: [${table.domain}]
      secretName: brick-tls
`
    : "";
  docs.push(`apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: brick
spec:
${tls}  rules:
    - ${table.domain ? `host: ${table.domain}\n      ` : ""}http:
        paths:
${paths.join("\n")}`);
  return `# ${HEADER}
# Create the token first: kubectl create secret generic brick --from-literal=BRICK_INTERNAL_TOKEN=$(openssl rand -hex 24)${table.domain ? "" : " --from-literal=BRICK_JWT_ISSUER=https://<your public host>"}
# An Ingress can't remove request headers, so x-brick-* reaches the services: each
# one ignores them without BRICK_INTERNAL_TOKEN, and answers a wrong token with 401.
# To also strip them at the edge, route with the Gateway API and a RequestHeaderModifier.
${docs.map((doc) => `---\n${doc}\n`).join("")}`;
}

// The runtime image's Debian matches the toolchains', so a binary linked to glibc runs.
const TOOLCHAIN = { go: "golang:1.26-trixie", rust: "rust:1-trixie" };

/**
 * One Dockerfile per process. Bun builds from the project root; a Go or Rust
 * service from its `context`, copying only its own folder and its local
 * dependencies, so a `replace` or `path` outside the project builds too.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function dockerfile(table: RoutingTable, u: Upstream): string {
  if (u.language === "ts")
    return `# ${HEADER}
FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && ${table.app.build}
ENV NODE_ENV=production PORT=${u.port}
EXPOSE ${u.port}
CMD ["/bin/sh", "-c", ${JSON.stringify(table.app.start)}]
`;
  if (!u.build)
    throw new Error(
      `Brick: remote service "${u.name}" needs build.command and build.run for --deploy compose.`,
    );
  const sources = u.sources ?? [u.dir!];
  const dir = sources.at(-1)!;
  return `# ${HEADER}
FROM ${TOOLCHAIN[u.language]} AS build
WORKDIR /src
${sources.map((source) => `COPY ${source} ${source}`).join("\n")}
WORKDIR /src/${dir}
RUN ${u.build.command}

FROM debian:trixie-slim
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /src/${join(dir, u.build.run)} /usr/local/bin/service
ENV BRICK_HOST=0.0.0.0 BRICK_PORT=${u.port}
EXPOSE ${u.port}
CMD ["/usr/local/bin/service"]
`;
}

const PROXY_IMAGES = {
  caddy: {
    image: "caddy:2",
    volumes: ["../caddy/Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data"],
  },
  nginx: {
    image: "nginx:1.27",
    volumes: ["../nginx/nginx.conf:/etc/nginx/nginx.conf:ro"],
  },
  traefik: {
    image: "traefik:v3",
    volumes: [
      "../traefik/traefik.yml:/etc/traefik/traefik.yml:ro",
      "../traefik/dynamic.yml:/etc/traefik/dynamic.yml:ro",
      "traefik-acme:/letsencrypt",
    ],
  },
} as const;

/** @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release. */
export type ProxyTarget = keyof typeof PROXY_IMAGES;

/**
 * compose.yaml: Bun, every Go and Rust service, and the proxy, which alone publishes ports.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function composeYaml(table: RoutingTable, proxy: ProxyTarget): string {
  const services = table.upstreams.map(
    (u) => `  ${u.name}:
    build:
      context: ${join("../..", u.context ?? ".")}
      dockerfile: ${join(u.project ?? ".", "deploy/compose", `${u.name}.Dockerfile`)}
    restart: unless-stopped
    environment:
${yamlEnv(u.env, "      ").join("\n")}`,
  );
  const { image, volumes } = PROXY_IMAGES[proxy];
  const ports = table.domain ? ['"80:80"', '"443:443"'] : ['"80:80"'];
  // A TS-only app reads neither variable.
  const secrets = table.upstreams.some((u) => "BRICK_INTERNAL_TOKEN" in u.env)
    ? "# Set BRICK_INTERNAL_TOKEN (and BRICK_JWT_ISSUER, your public URL) in deploy/compose/.env.\n"
    : "";
  return `# ${HEADER}
${secrets}services:
${services.join("\n\n")}

  proxy:
    image: ${image}
    restart: unless-stopped
    ports: [${ports.join(", ")}]
    volumes:
${volumes.map((v) => `      - ${v}`).join("\n")}
    depends_on: [${table.upstreams.map((u) => u.name).join(", ")}]
${proxy === "nginx" ? "" : `\nvolumes:\n  ${proxy === "caddy" ? "caddy-data" : "traefik-acme"}:\n`}`;
}

/**
 * Every file of the targets, by path under `deploy/`. Compose brings the config of its proxy.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function deployFiles(
  table: RoutingTable,
  targets: readonly DeployTarget[],
): Record<string, string> {
  const files: Record<string, string> = {};
  const wanted = new Set(targets);
  const proxy =
    (["caddy", "nginx", "traefik"] as const).find((t) => wanted.has(t)) ??
    "caddy";
  if (wanted.has("compose")) wanted.add(proxy);
  if (wanted.has("routes")) files["routes/routes.json"] = routesJson(table);
  if (wanted.has("caddy")) files["caddy/Caddyfile"] = caddyfile(table);
  if (wanted.has("nginx")) files["nginx/nginx.conf"] = nginxConf(table);
  if (wanted.has("traefik"))
    for (const [name, source] of Object.entries(traefikConfig(table)))
      files[`traefik/${name}`] = source;
  if (wanted.has("kubernetes"))
    files["kubernetes/brick.yaml"] = kubernetesYaml(table);
  if (wanted.has("compose")) {
    files["compose/compose.yaml"] = composeYaml(table, proxy);
    for (const u of table.upstreams) {
      files[`compose/${u.name}.Dockerfile`] = dockerfile(table, u);
      // Docker reads <Dockerfile>.dockerignore: keep build output and host
      // installs (native modules built for another OS) out of the context.
      files[`compose/${u.name}.Dockerfile.dockerignore`] =
        u.language === "ts"
          ? "**/node_modules\n**/.git\ndist\ndeploy\n"
          : "**/target\n**/node_modules\n**/.git\n";
    }
  }
  return files;
}

/**
 * Parse `--deploy caddy,compose`.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function parseDeployTargets(value: string): DeployTarget[] {
  const targets = value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  for (const target of targets)
    if (!DEPLOY_TARGETS.includes(target as DeployTarget))
      throw new Error(
        `Brick: unknown deploy target "${target}". Use ${DEPLOY_TARGETS.join(", ")}.`,
      );
  return targets as DeployTarget[];
}

/**
 * Write the targets' files into `<root>/deploy/`, returning their paths.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export async function writeDeploy(
  app: BrickApp,
  options: DeployOptions & { targets: DeployTarget[]; root?: string },
): Promise<string[]> {
  const root = options.root ?? process.cwd();
  const files = deployFiles(
    routingTable(app, { ...options, cwd: root }),
    options.targets,
  );
  const written: string[] = [];
  for (const [path, source] of Object.entries(files)) {
    const file = join(root, "deploy", path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source);
    written.push(file);
  }
  return written;
}
