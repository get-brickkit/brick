import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { deployFiles, routingTable } from "../src/deploy";
import { DEPLOY_TARGETS } from "../src/config";
import { app, tsOnly } from "./fixtures/deploy/app";

const cwd = join(import.meta.dir, "fixtures/deploy");

describe("brick build --deploy", () => {
  it("routes /api/<service>/ to each Go and Rust service and the rest to Bun", () => {
    const table = routingTable(app, { cwd });
    expect(table.routes).toEqual([
      { path: "/api/billing/", upstream: "billing" },
      { path: "/api/fx-rates/", upstream: "fx-rates" },
      { path: "/", upstream: "app" },
    ]);
    expect(table.upstreams.map((u) => [u.name, u.address, u.language])).toEqual(
      [
        ["app", "app:3000", "ts"],
        ["billing", "billing:4001", "go"],
        ["fx-rates", "fx-rates:4002", "rust"],
      ],
    );
    expect(JSON.parse(table.upstreams[1]!.env.BRICK_SERVICES!)).toEqual({
      orders: "http://app:3000/_brick/call/orders",
      billing: "http://billing:4001",
      fxRates: "http://fx-rates:4002",
    });
    expect(table.upstreams[1]!.env.BRICK_CORS).toBe(
      '{"origin":["https://app.example.com"],"credentials":true}',
    );
  });

  it("writes every target", () => {
    const files = deployFiles(routingTable(app, { cwd }), DEPLOY_TARGETS);
    expect(Object.keys(files).sort()).toEqual([
      "caddy/Caddyfile",
      "compose/app.Dockerfile",
      "compose/billing.Dockerfile",
      "compose/compose.yaml",
      "compose/fx-rates.Dockerfile",
      "kubernetes/brick.yaml",
      "nginx/nginx.conf",
      "routes/routes.json",
      "traefik/dynamic.yml",
      "traefik/traefik.yml",
    ]);
    for (const [path, source] of Object.entries(files))
      expect(source).toMatchSnapshot(path);
  });

  it("adds HTTPS for a domain", () => {
    const files = deployFiles(
      routingTable(app, { cwd, domain: "app.example.com" }),
      ["caddy", "traefik", "kubernetes"],
    );
    for (const [path, source] of Object.entries(files))
      expect(source).toMatchSnapshot(`${path} (domain)`);
  });

  it("brings the chosen proxy's config with compose", () => {
    const files = deployFiles(routingTable(app, { cwd }), ["nginx", "compose"]);
    expect(Object.keys(files)).not.toContain("caddy/Caddyfile");
    expect(files["compose/compose.yaml"]).toContain("image: nginx:1.27");
    expect(
      Object.keys(deployFiles(routingTable(app, { cwd }), ["compose"])),
    ).toContain("caddy/Caddyfile");
  });

  it("routes a TS-only app entirely to Bun", () => {
    const files = deployFiles(routingTable(tsOnly, { cwd }), DEPLOY_TARGETS);
    expect(files["caddy/Caddyfile"]).toMatchSnapshot("ts-only Caddyfile");
    expect(files["compose/compose.yaml"]).toMatchSnapshot("ts-only compose");
    expect(Object.keys(files)).not.toContain("compose/billing.Dockerfile");
  });
});
