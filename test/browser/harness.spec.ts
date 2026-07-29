import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chromium, type Browser } from "playwright";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { harnessConfig } from "../../playwright.config";

/**
 * Drives `/dev/harness` in a real browser and prints the numbers it produced.
 *
 * WHY IT IS OPT-IN. It boots `next dev`, launches Chromium and runs the whole pipeline — tens
 * of seconds, and a browser binary that a plain `vitest run` has no business requiring. Vitest
 * globs `**\/*.spec.ts` by default, so without the gate below this file would attach itself to
 * the unit suite. Run it deliberately:
 *
 *     HARNESS=1 npx vitest run test/browser/harness.spec.ts        (bash)
 *     $env:HARNESS=1; npx vitest run test/browser/harness.spec.ts  (PowerShell)
 *
 * WHY VITEST AND NOT @playwright/test. See the header of `playwright.config.ts` — only the
 * driver is installed, and one spec does not justify a second runner.
 *
 * WHAT IT ASSERTS. Only the things that would be a bug in any world: the page produced a
 * result, the geometry still lands on the reference crop, the file is 110 frames at 4cs
 * looping forever, and frame 0 is a complete resting picture. It does NOT assert a difference
 * threshold. Nobody has agreed what an acceptable browser-versus-ffmpeg gap is yet, and a
 * number invented here would quietly become the specification.
 */

const ENABLED = process.env.HARNESS === "1" || process.env.HARNESS === "true";

interface FrameDiff {
  mean: number;
  max: number;
  pctOver2: number;
}

interface Report {
  ok: boolean;
  error?: string;
  geometry: {
    cropRounded: { x: number; y: number; w: number; h: number };
    cropMatches: boolean;
    rest: number;
    windowH: number;
    restMatches: boolean;
    warnings: string[];
  };
  ours: { bytes: number; frames: number; delayCs: number | "mixed"; loopCount: number | null };
  reference: { bytes: number; frames: number };
  byteRatio: number;
  postQuant: { overall: FrameDiff; worst: { frame: number; mean: number }[] };
  preQuant: { overall: FrameDiff };
  loop: { frame0EqualsLast: boolean };
  palettes: { ours: number[]; reference: number[] };
  timings: Record<string, number>;
}

/** Ask the OS for a port nobody is using, then hand it straight to Next. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not obtain a port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(base: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(5_000) });
      // Any HTTP answer means the listener is up; Next's own 404s are still an answer.
      if (res.status > 0) return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`dev server did not answer within ${timeoutMs} ms (last: ${lastError})`);
}

/**
 * Kill the dev server and everything it spawned.
 *
 * `child.kill()` alone is not enough on Windows: Next forks a worker per route compiler, and
 * killing the parent leaves those holding the port, so the next run picks a different one and
 * the machine slowly fills with orphans.
 */
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
    setTimeout(resolve, 10_000);
  });
}

describe.runIf(ENABLED)("browser harness", () => {
  let server: ChildProcess;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    const port = harnessConfig.port || (await freePort());
    base = `http://127.0.0.1:${port}`;

    // Spawned as `node <next-cli> dev`, not as the `next` shim. The shim is `next.cmd` on
    // Windows, which needs a shell, and a shell between us and the server is one more process
    // that does not forward a kill.
    const require = createRequire(import.meta.url);
    const nextBin = require.resolve("next/dist/bin/next");

    // A PRODUCTION BUILD, NOT `next dev`, and this is not a preference.
    //
    // Under `next dev` with Turbopack the client bootstrap is delivered over the HMR websocket.
    // In this environment that socket cannot complete its handshake (ERR_INVALID_HTTP_RESPONSE),
    // so the page renders its server HTML, never hydrates, and the effect that runs the pipeline
    // never fires — the harness sat at its first phase for five minutes with no error to show
    // for it. `next start` serves the same chunks over plain HTTP with no socket involved.
    //
    // It is also simply the more honest place to measure: a rendering harness that depends on
    // hot reload is measuring the dev server as much as the code.
    const cwd = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const harnessEnv = { NEXT_PUBLIC_HARNESS: "1", HARNESS_ROUTES: "1" };

    await new Promise<void>((resolve, reject) => {
      const build = spawn(process.execPath, [nextBin, "build"], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...harnessEnv, FORCE_COLOR: "0" },
      });
      build.stdout?.on("data", (b: Buffer) => process.stdout.write(`[build] ${b}`));
      build.stderr?.on("data", (b: Buffer) => process.stderr.write(`[build] ${b}`));
      build.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`next build exited ${code}`)),
      );
    });

    server = spawn(process.execPath, [nextBin, "start", "--port", String(port)], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...harnessEnv, NODE_ENV: "production", FORCE_COLOR: "0" },
    });
    server.stdout?.on("data", (b: Buffer) => process.stdout.write(`[next] ${b}`));
    server.stderr?.on("data", (b: Buffer) => process.stderr.write(`[next] ${b}`));

    await waitForServer(base, harnessConfig.serverTimeout);
    browser = await chromium.launch({ headless: harnessConfig.headless });
  }, harnessConfig.serverTimeout + 300_000);

  afterAll(async () => {
    await browser?.close();
    if (server) await killTree(server);
  }, 30_000);

  it(
    "renders, encodes and diffs against the ffmpeg reference",
    async () => {
      const page = await browser.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") process.stderr.write(`[page] ${m.text()}\n`);
      });
      page.on("pageerror", (e) => process.stderr.write(`[page] ${e.message}\n`));

      // NEUTRALISE HOT RELOAD BEFORE ANY APP CODE RUNS.
      //
      // Next's dev client opens a websocket to /_next/webpack-hmr. Under this Chromium the
      // upgrade fails with ERR_INVALID_HTTP_RESPONSE, the client treats a dead socket as a lost
      // dev server, and RELOADS THE PAGE to recover. The harness needs about a minute of
      // uninterrupted work — decode a 2 MB PNG, grade it, rasterise 110 frames, build a palette
      // over 6.8 million pixels, encode, then decode two GIFs — so every retry threw the run
      // away and started again. Four page loads inside a five-minute timeout, and #harness-result
      // never appeared: it was never a slow pipeline, it was a pipeline that kept restarting.
      //
      // Stubbing the socket rather than the reload is deliberate. The dev client never learns it
      // failed, so it never schedules a recovery, and nothing in the application is aware a test
      // is running.
      await page.addInitScript(() => {
        const Real = window.WebSocket;
        class Quiet extends EventTarget {
          readyState = 0;
          close() {}
          send() {}
          addEventListener() {}
          removeEventListener() {}
        }
        // Only the HMR socket is silenced; anything the app itself opens must still work.
        window.WebSocket = new Proxy(Real, {
          construct(target, args: [string, ...unknown[]]) {
            const url = String(args[0] ?? "");
            if (url.includes("webpack-hmr") || url.includes("_next/hmr")) {
              return new Quiet() as unknown as WebSocket;
            }
            return Reflect.construct(target, args) as WebSocket;
          },
        }) as unknown as typeof WebSocket;
      });

      let loads = 0;
      page.on("load", () => {
        loads += 1;
        if (loads > 1) process.stderr.write(`[page] RELOADED (${loads}) — run restarted\n`);
      });

      await page.goto(`${base}${harnessConfig.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#harness-result", { timeout: harnessConfig.resultTimeout });

      const raw = await page.textContent("#harness-result");
      expect(raw, "#harness-result was empty").toBeTruthy();
      const report = JSON.parse(raw as string) as Report;

      // Printed before the assertions so a failing run still yields its numbers — the whole
      // reason this file exists is to get them out of the browser and into a terminal.
      process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n\n`);
      if (report.ok) process.stdout.write(summarise(report));

      expect(report.error ?? null, "harness reported an error").toBeNull();
      expect(report.ok).toBe(true);

      expect(report.geometry.cropMatches, "crop drifted from the reference").toBe(true);
      expect(report.geometry.restMatches, "rest/windowH drifted from the reference").toBe(true);

      expect(report.ours.frames).toBe(report.reference.frames);
      expect(report.ours.delayCs).toBe(4);
      expect(report.ours.loopCount).toBe(0); // 0 = loop forever
      expect(report.loop.frame0EqualsLast, "frame 0 is not the resting state").toBe(true);

      await page.close();
    },
    harnessConfig.resultTimeout + 60_000,
  );
});

function summarise(r: Report): string {
  const pct = (r.byteRatio * 100).toFixed(1);
  return [
    "──────────────────────────────────────────────────────────────",
    ` bytes            ${r.ours.bytes} vs ${r.reference.bytes} reference  (${pct} %)`,
    ` frames           ${r.ours.frames} at ${r.ours.delayCs} cs, loop ${r.ours.loopCount}`,
    ` diff  post-quant mean ${r.postQuant.overall.mean}  max ${r.postQuant.overall.max}  >2 ${r.postQuant.overall.pctOver2} %`,
    ` diff  pre-quant  mean ${r.preQuant.overall.mean}  max ${r.preQuant.overall.max}  >2 ${r.preQuant.overall.pctOver2} %`,
    ` worst frames     ${r.postQuant.worst.map((w) => `${w.frame}:${w.mean}`).join("  ")}`,
    ` palette          ${r.palettes.ours.length} greys vs ${r.palettes.reference.length}`,
    ` timings          ${Object.entries(r.timings)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ")}`,
    "──────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}
