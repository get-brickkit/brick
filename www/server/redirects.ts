import { canonicalRedirect } from "../src/lib/redirects.ts";

export default function redirects(event: { url: URL }) {
  const target = canonicalRedirect(event.url.pathname);
  if (!target) return;
  return new Response(null, {
    status: 308,
    headers: { Location: `${target}${event.url.search}` },
  });
}
