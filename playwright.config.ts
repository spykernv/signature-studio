/**
 * Settings for the browser harness run (`test/browser/harness.spec.ts`).
 *
 * DELIBERATELY IMPORT-FREE. The obvious version of this file is
 * `import { defineConfig } from "@playwright/test"`, but only the `playwright` DRIVER is a
 * dependency of this project — the `@playwright/test` RUNNER is not installed, and adding a
 * second test runner beside vitest to run one spec is a poor trade. So the spec drives
 * `chromium` from the driver directly under vitest, and this file is the plain data both
 * halves agree on. It also means `tsc --noEmit` stays green without a package that is not
 * there.
 *
 * If the runner is ever adopted, this object maps onto `defineConfig` almost field for field
 * (`testDir`, `use.baseURL`, `timeout`, `webServer.command`) and that is why it is shaped
 * this way.
 */

export interface HarnessConfig {
  /** Where the spec lives, relative to the repository root. */
  testDir: string;
  /** Route under test. */
  path: string;
  /**
   * Port for the dev server. 0 asks the operating system for a free one, which is what keeps a
   * harness run from colliding with the `next dev` a developer already has open on 3000.
   */
  port: number;
  headless: boolean;
  /** How long to wait for `next dev` to answer its first request, in ms. */
  serverTimeout: number;
  /**
   * How long to wait for `#harness-result` to appear, in ms.
   *
   * Generous on purpose. The page decodes a 2 MB PNG, grades it through a Lanczos-3 resample,
   * rasterises 110 frames, builds a palette over 6.8 million pixels and then decodes two GIFs
   * — and the first hit also pays for Next compiling the route from cold.
   */
  resultTimeout: number;
}

export const harnessConfig: HarnessConfig = {
  testDir: "test/browser",
  path: "/dev/harness",
  port: 0,
  headless: true,
  serverTimeout: 120_000,
  resultTimeout: 300_000,
};

export default harnessConfig;
