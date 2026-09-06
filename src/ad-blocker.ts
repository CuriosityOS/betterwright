// Loaded only when adBlock is enabled. Ghostery supplies EasyList, EasyPrivacy,
// Peter Lowe's list, uBlock filters/unbreak rules, redirects, and scriptlets.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PlaywrightBlocker,
  Request,
  type RequestType,
} from "@ghostery/adblocker-playwright";
import type { BrowserContext, Frame, Route } from "playwright-core";
import { mkdirPrivate, writePrivateBytes } from "./fs-private.js";

export const AD_BLOCK_CACHE_FILE = "ad-blocker-2.18.2.bin";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadAdBlocker(
  runtimeDir: string,
  { fetchImpl = fetch, warn = (message: string): void => { process.stderr.write(`${message}\n`); } } = {},
): Promise<PlaywrightBlocker> {
  const cache = path.join(runtimeDir, AD_BLOCK_CACHE_FILE);
  let cached: PlaywrightBlocker | undefined;
  try {
    const stat = fs.statSync(cache);
    if (stat.size <= 64 * 1024 * 1024) {
      cached = PlaywrightBlocker.deserialize(fs.readFileSync(cache));
      if (Date.now() - stat.mtimeMs < MAX_AGE_MS) return cached;
    }
  } catch {
    // A missing, old-format, or damaged cache is rebuilt from upstream lists.
  }
  // One deadline covers the complete refresh, including upstream retries.
  const signal = AbortSignal.timeout(15_000);
  let blocker: PlaywrightBlocker;
  try {
    blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(async (url) => {
      const response = await fetchImpl(url, { signal, redirect: "error" });
      if (!response.ok) throw new Error(`Filter download failed (${response.status}).`);
      return response;
    });
  } catch {
    if (cached) {
      warn("Ad blocker: filter refresh failed; using the last cached lists.");
      return cached;
    }
    throw new Error(
      "Ad blocker could not load its filter lists. Retry with network access, or disable adBlock / BETTERWRIGHT_AD_BLOCK.",
    );
  }
  const temporary = `${cache}.${randomUUID()}.tmp`;
  try {
    mkdirPrivate(runtimeDir);
    writePrivateBytes(temporary, blocker.serialize());
    fs.renameSync(temporary, cache);
  } catch {
    warn("Ad blocker: could not save the filter cache; blocking is active for this browser.");
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* cache writes are best-effort */ }
  }
  return blocker;
}

/** Called only AFTER the policy guard allows a request. Never continues it. */
export async function blockAdRequest(blocker: PlaywrightBlocker, route: Route): Promise<boolean> {
  const request = route.request();
  let frame: Frame;
  try {
    frame = request.frame();
  } catch {
    // Early popup navigations and service-worker requests may have no frame.
    // Policy has already allowed them; lacking an initiator is not an ad match.
    return false;
  }
  // SAFETY: Playwright resourceType() returns the documented Playwright types,
  // all of which are included in Ghostery's RequestType union.
  let type = request.resourceType() as RequestType;
  if (request.isNavigationRequest() && type === "document") {
    // Keep intentional top-level navigation usable, as Ghostery's adapter does.
    // A child's navigation is evaluated against its parent, not its old URL.
    if (!frame.parentFrame()) return false;
    frame = frame.parentFrame();
    type = "sub_frame";
  }
  while (frame.parentFrame() && !/^https?:/.test(frame.url())) frame = frame.parentFrame();
  const result = blocker.match(Request.fromRawDetails({
    url: request.url(), sourceUrl: frame.url(), type,
  }));
  if (result.redirect) {
    const { body, contentType } = result.redirect;
    const base64 = contentType.endsWith(";base64");
    await route.fulfill({
      body: base64 ? Buffer.from(body, "base64") : body,
      contentType: base64 ? contentType.slice(0, -7) : contentType,
    });
    return true;
  }
  if (result.match) {
    await route.abort("blockedbyclient");
    return true;
  }
  return false;
}

export function installAdBlockCosmetics(context: BrowserContext, blocker: PlaywrightBlocker): void {
  const attach = (page) => {
    // Use only upstream's cosmetic hook. enableBlockingInPage installs its own
    // route.continue handler, which would skip BetterWright's context guard.
    page.on("framenavigated", blocker.onFrameNavigated);
    page.on("domcontentloaded", () => void blocker.onFrameNavigated(page.mainFrame()));
    for (const frame of page.frames()) void blocker.onFrameNavigated(frame);
  };
  context.on("page", attach);
  for (const page of context.pages()) attach(page);
}
