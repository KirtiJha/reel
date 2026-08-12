import type { BrowserContext } from "playwright-core";
import type { LoadedSpec } from "../spec/load.js";
import { resolveOutput } from "../spec/load.js";
import type { Mock } from "../spec/schema.js";
import { log } from "../util/log.js";

/**
 * Deterministic data: pin network responses so the demo shows clean, stable
 * content regardless of backend state (no `test123`, no empty states, no flaky
 * live data). Replays a HAR and/or fulfills specific routes with fixtures.
 */
export async function applyMocks(
  context: BrowserContext,
  mock: Mock,
  loaded: LoadedSpec,
): Promise<void> {
  if (mock.har) {
    const harPath = resolveOutput(loaded, mock.har);
    await context.routeFromHAR(harPath, { update: false, notFound: "fallback" });
    log.debug(`mocking network from HAR: ${harPath}`);
  }

  for (const r of mock.routes) {
    await context.route(r.url, async (route) => {
      await route.fulfill({
        status: r.status,
        contentType: r.contentType ?? (r.json !== undefined ? "application/json" : undefined),
        body: r.json !== undefined ? JSON.stringify(r.json) : r.body,
      });
    });
  }
  if (mock.routes.length) log.debug(`stubbing ${mock.routes.length} route(s)`);
}
