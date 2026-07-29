import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Serves the regression fixtures to the browser harness, in development only.
 *
 * The harness needs the 2 MB source photograph and the reference GIF that ffmpeg produced, so
 * that a GIF built in the browser can be diffed against the one that was signed off. Putting
 * them in `public/` would ship both to every visitor of a page that has no use for them; this
 * route keeps a single copy in `test/fixtures/` — where the unit tests already read it — and
 * hands it out only while developing.
 *
 * The allowlist is not decoration. This route joins a path segment onto a directory, which is
 * the canonical shape of a traversal bug, and `..%2f` survives more layers of decoding than
 * people expect. Only these exact names resolve.
 */
const ALLOWED: Record<string, string> = {
  "source-portrait.png": "image/png",
  "expected-graded.png": "image/png",
  "reference-sig-a.gif": "image/gif",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  // The harness cannot run on `next dev` in every environment: where the HMR websocket cannot
  // complete its handshake, Turbopack's client bootstrap never finishes, the page never
  // hydrates, and the measurement never starts. A measurement harness has no business depending
  // on hot reload anyway, so it runs against a real production build — which means this route
  // needs an opt-in that survives NODE_ENV=production.
  //
  // It is an explicit environment variable rather than a header or a query flag so that it can
  // only ever be turned on by whoever starts the process. Nothing sets it in deployment.
  if (process.env.NODE_ENV === "production" && process.env.HARNESS_ROUTES !== "1") {
    return new Response("Not found", { status: 404 });
  }

  const { name } = await params;
  const type = ALLOWED[name];
  if (!type) return new Response("Not found", { status: 404 });

  try {
    const bytes = await readFile(join(process.cwd(), "test", "fixtures", name));
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": type, "cache-control": "no-store" },
    });
  } catch {
    return new Response("Fixture missing", { status: 404 });
  }
}
