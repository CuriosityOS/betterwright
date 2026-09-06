# Ad and tracker blocking

Ad blocking is **on by default**. No option is required. To disable it:

```ts
const browser = new BetterWright({ adBlock: false });
```

Or use the CLI:

```sh
betterwright run --no-ad-block -c 'await page.goto("https://example.com"); return await page.title()'
betterwright mcp --no-ad-block
```

`--ad-block` explicitly enables blocking. The environment setting
`BETTERWRIGHT_AD_BLOCK=0` disables it across the API, CLI, MCP, and Pi extension;
`1` enables it. An explicit constructor option or CLI flag takes precedence.
`runAgentTask({ adBlock: true })` applies it to a browser the agent creates;
when supplying an existing browser, configure that browser instead.

This is a browser-wide launch setting: every session, tab, popup, and nested
frame uses the same blocker. Restart an MCP/Pi host after changing its setting.
For a CLI session that is already running, use `betterwright close --all` before
switching modes so a newly configured daemon can own the profile. An incompatible
daemon is never silently reused. Close ends its live sessions. API callers can
close and construct a new browser, or change `browser.adBlock` before the next
call (this restarts the worker and closes its live tabs).

## Filtering

The pinned Ghostery engine uses its ads-and-tracking preset: EasyList,
EasyPrivacy, Peter Lowe's list, and uBlock Origin filters, privacy, resource-abuse,
quick-fix, and unbreak lists. It supports network rules, allow exceptions,
local replacement resources, cosmetic hiding, and scriptlets. Network blocking
prevents matching scripts and frames from loading; cosmetic hiding removes
remaining ad elements. This does not automatically accept cookie notices.

Filters and replacement resources download from Ghostery's GitHub repository on
first enabled use. The compiled engine is saved privately under
`<home>/browser/runtime/ad-blocker-2.18.2.bin`. Browser launches reuse that cache
for seven days, then try a refresh with a bounded download deadline. A failed
refresh keeps the last valid rules and reports a warning in browser results. If no valid
cache exists and downloading fails, launch reports an error instead of silently
running without the requested blocker. Disabled launches do not import the
engine, download lists, or read its cache. To force a refresh, close the browser
and remove that cache file.

The existing network policy runs before ad filtering. An ad-filter exception or
replacement cannot override a policy denial. The managed browser still uses the
SOCKS guard. New contexts disable service workers when blocking is enabled,
because service-worker responses can evade Playwright request routing.

The Playwright integration has limits: top-level navigations remain allowed by
the ad blocker (network policy still applies), WebSocket traffic is not ad
filtered, and cosmetics/scriptlets can be restricted by a site's CSP. Existing
remote CDP contexts may already have service workers; their intercepted traffic
cannot be guaranteed to pass through this blocker. Use a fresh provider context
for full HTTP request coverage. This is not a claim of parity with every browser
extension feature, or a guarantee that every ad or anti-adblock page is handled.

Blocking has a filter-engine memory cost. CPU savings depend on how much ad and
tracker code a page would otherwise run; simple pages may see little benefit.
