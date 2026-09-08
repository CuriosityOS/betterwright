# Embedded browser verification

Verified locally on macOS on September 9, 2026, using Bun 1.4.0 and the
Synara (Dev) Electron runtime with an isolated test app. The user's Synara
application and real account credentials were not used by these tests.

## Results

| Check | Result |
| --- | --- |
| Full managed-browser suite (`BETTERWRIGHT_REQUIRE_BROWSER=1 bun run test`) | 1,124 passed; 3 skipped; 0 failed |
| Release checks (`bun run release:check`) | Passed: versions, lint, types, build, unit tests, public types, package consumer smoke test |
| Release unit suite | 1,035 passed; 3 skipped; 0 failed |
| Final focused Node regressions with coverage | 68 passed; 0 failed |
| Native Electron fixture | Passed |
| Actual ASAR-packaged Electron fixture | Passed |
| Whitespace check (`git diff --check`) | Passed |

The final focused tests and both native runs include the last cancellation
regression fix. The full managed suite and release unit suite ran before that
final focused regression was added.

## Native acceptance coverage

- Hidden host tab, 125% zoom, batched input, and empty array results.
- Shortcut denial, modifier recovery, and host-owned tab lifetime.
- Real system clipboard copy and paste, restoring the prior clipboard privately.
- Exact staged uploads; rejection of unapproved paths and in-memory payloads.
- Network guard rejection of renderer requests outside the allowed sandbox.
- Cancellation cleanup without closing the host's page.
- Authenticated, single-tab CDP access; rejection of unauthenticated access.
- Synthetic credential capture, metadata-only native save prompt, and sensor disposal.
- Nonblank native screenshot saved to `artifacts/electron-e2e/native-browser.png`.

Run the reproducible fixtures with `bun run test:electron` and
`bun run test:electron:packaged`. See [host integration](electron-host.md) for
setup and ownership requirements.

## Limits

The three skipped tests require opt-in live CAPTCHA services. Native Electron
acceptance was not run on Windows or Linux. The fixtures do not prove a real
Firecrawl or Google account login, nor every external site's OAuth behavior.

The focused Node coverage run is not whole-project coverage. It covers the new
tool guidance at 100% lines, cookie error handling at 100%, keyboard policy at
94%, and capture lifecycle at 89.89%; native adapter behavior is exercised by
the Electron fixtures rather than that Node coverage process.

Leaner discovery guidance is tested for content and prompt budget, not a measured
Astra token reduction. Synara chat rendering, preview layout, and subagent
scheduling remain host responsibilities. This verification is not a guarantee
of zero bugs, and these changes have not been published.
