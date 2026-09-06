# Changelog

All notable changes to BetterWright are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 1.1.3 predate this file; their notes live on the
[GitHub releases page](https://github.com/BetterWright/betterwright/releases).

## [Unreleased]

## [2.4.0] - 2026-09-06

### Added

- Ghostery ad and tracker blocking across API, CLI, MCP, Pi, and agent-created
  browser sessions, including nested frames and popup subresources. The
  maintained preset includes EasyList, EasyPrivacy, Peter Lowe, and uBlock
  filters, exceptions, local replacements, cosmetic hiding, and scriptlets.
- Compiled filter caching for seven days, bounded refresh downloads, and
  continued use of valid cached rules when a refresh fails.

### Changed

- Ad blocking is **on by default**. Disable it with `{ adBlock: false }`,
  `--no-ad-block`, or `BETTERWRIGHT_AD_BLOCK=0`. Explicit options and flags
  override the environment. First enabled use downloads the filter lists;
  new contexts disable service workers while blocking is enabled. Network
  policy remains authoritative. See [ad blocking](docs/ad-blocking.md).
- Reuse shared action-directory context within each synchronous frame scan,
  reducing repeated DOM work while retaining complete output.
- Limit SwiftShader to WebGL on GPU-less Linux, preserving existing renderer
  and recording memory bounds while reducing graphics overhead.

### Fixed

- Resolve child and nested frame snapshot references, including `aria-ref=`
  references, in `controls.batch` with existing validation and credential checks.
- Refresh action-directory context on every scan, including empty context.
- Key the CI browser cache by release tag and asset checksum so revised native
  builds cannot reuse an older browser with the same Chromium version.

## [2.3.0] - 2026-09-05

### Added

- Record the current tab through `betterwright record`, the `recording` snippet
  helper, or MCP `browser_record`. Start, stop, status, and restart preserve
  the page and elapsed time. Capture defaults to 60 FPS and MP4/H.264; an
  explicit `.webm` filename selects VP8. Recording requires FFmpeg only while
  active, with bounded frame queues, output size, and duration.

### Changed

- Skip unused page-event draining and redundant title reads between actions.
- Merge adjacent snapshot text in linear time while preserving existing output.
- Preserve complete action directories and valid JSON in large agent
  observations; compact Pi observations without removing content.
- Load CLI setup modules only when needed and skip default model discovery
  when a model is explicitly selected.

### Fixed

- Snapshot diffs use only output delivered to the caller and keep URL-mode
  histories separate. Refused output no longer becomes the next baseline.


## [2.2.0] - 2026-09-03

The project runtime is Bun 1.4.0. CLI, worker, tests, CI, and Cloud Agent
install run on Bun. The published library still loads under Node 22.

### Changed

- The project runtime is Bun 1.4.0. CLI, worker, tests, CI, and Cloud Agent
  install run on Bun. `betterwright doctor` reports Bun when that is the host.
  The published library still loads under Node 22 if a consumer imports it
  from Node; worker processes inherit the host's `process.execPath`.
  MCP registration uses `bunx betterwright mcp`. Install hints from `doctor`
  and missing optional peers suggest `bun add` when the host is Bun.
- `--version` and `--help` load a thin CLI router and skip `cli-main`.
  `bun test` runs the unit files in parallel.
- Cross-platform CI still reports the branch-protected
  `Cross-platform unit tests (<os>, 22|24)` names. Those jobs run Bun 1.4.

### Fixed

- The SOCKS guard maps RFC 6761 `localhost` / `*.localhost` names to
  `127.0.0.1` then `::1` without OS DNS, then still policy-checks every
  loopback literal. Chromium site-isolation hosts such as
  `signup.acme.localhost` work on glibc that does not resolve `.localhost`.
- Worker `--import` flags copied from `NODE_OPTIONS` under Bun now pass a
  filesystem path. Node's `pathToFileURL` percent-encodes `~`, and Bun then
  looks for a file that does not exist — Windows runners use the 8.3 home
  `RUNNER~1`.
- The session daemon is spawned through the thin CLI router
  (`dist/bin/betterwright.js`), not `cli-main`. After the router split,
  `cli-main` only exported `runCli`, so a fresh daemon child exited without
  creating its socket.
- Guard-proxy unit tests wait on a wall-clock deadline instead of a
  bounded `setImmediate` loop, so parallel `bun test` on a loaded macOS
  runner cannot miss the backoff delay hook.


## [2.1.0] - 2026-09-02

### Added

- **Cookie Sync.** The host SDK and `betterwright cookies` CLI can discover
  mainstream Chromium, Firefox-family, and Safari profiles and copy scoped
  cookies into local BetterChromium profiles on Windows, macOS, and Linux.
  Remote Chromium providers and explicit CDP endpoints are supported with
  exact per-call destination consent. Chromium partition, source-scheme, and
  source-port scope is preserved; unsupported Firefox isolation is skipped.
  Target quota preflight and readback verification prevent silent eviction and
  false success counts.

### Security

- Cookie values stay off command arguments and the profile-daemon socket.
  Raw Cookie and Set-Cookie header access and browser-context cookie mutation
  are absent from model snippets, while known synced values
  are redacted from result envelopes across profile restarts.

## [2.0.1] - 2026-09-01

A stability release for the SDK. A worker restart no longer surfaces as a
false "This browser has been closed." in other sessions, a worker that
cannot start is reported at once with the reason instead of after a timeout,
a dying worker can no longer crash the host process, and cloud-provider API
calls are bounded so `boxes` and provider launches cannot hang. The
provider-account and `boxes` work queued since 2.0.0 ships here as well.

### Added

- **Connected provider accounts.** `betterwright configure --connect <name>`
  saves a built-in provider's API key (or `--key-env`) in
  `browser.accounts` without changing the launch default, so the managed fork
  can stay the default while `boxes` talks to Kernel, Browserbase, Steel,
  Anchor, Hyperbrowser, or Browser Use. `--browser <name>` with a key
  connects the account as well. `--disconnect` forgets a saved key;
  `--managed` / `--reset` still only clears the launch default.
  `--show --json` reports connected accounts with stored keys masked.
- **`betterwright boxes`.** `start`, `list`, `show`, and `stop` drive the six
  SDK-backed providers' REST session APIs. Browserless, Bright Data, and
  Oxylabs stay connect-only and are refused with a clear message. Keys resolve
  from `--browser-key` / `--key-env`, then a saved account, then a matching
  launch default, then the provider's well-known env var. `--session-id` on
  `run` / `repl` / `exec` attaches to an existing box instead of minting,
  and disconnect does not stop that box.
- **SDK session helpers** on `betterwright/sdk`: `createProviderSession`,
  `listProviderSessions`, `getProviderSession`, `stopProviderSession`,
  `REST_BROWSER_PROVIDER_NAMES`, and `lifecycle` on `browserProviderInfo`.
- **`BETTERWRIGHT_WORKER_START_TIMEOUT_MS`** sets how long the client gives a
  freshly spawned worker to print its ready handshake (default 15 s). A cold
  disk or a small ARM board can need more; the timeout error now names the
  variable and carries the worker's last stderr lines.

### Changed

- Anchor sessions are released when the browser closes (`DELETE` on the
  session), matching Kernel / Browserbase / Hyperbrowser. Steel and Browser
  Use still launch through a connect URL; their REST APIs are used by
  `boxes` (and by `--session-id` attach).
- **Cloud-provider API calls are bounded.** Every REST call a provider launch
  or `betterwright boxes` makes (create, list, get, stop) times out after 30 s
  with a message that says so, instead of waiting on the provider forever. A
  network failure is reported by its cause (`getaddrinfo ENOTFOUND …`,
  `ECONNREFUSED`, a TLS error) rather than undici's bare `fetch failed`.

### Fixed

- **A worker restart no longer fails concurrent calls with "This browser has
  been closed."** An execution timeout, a worker-requested restart, or a
  reconfigure takes the worker down and the next call brings a replacement
  up. A call from another session that landed during that teardown was told
  the browser had been closed, although nothing had closed it. Only a final
  `close()` marks the client closed now; a call that arrives mid-restart waits
  for the replacement worker. Live-view revival after a crash is unchanged.
- **A worker that dies at boot fails the call immediately, with its stderr.**
  The client used to wait out the full start timeout before reporting
  "Worker did not start", with nothing about why. The call now rejects as
  soon as the process exits, and the `BrowserError` carries the exit code or
  signal and the last stderr lines (the missing module, the syntax error, the
  permission problem).
- **A worker that hangs at boot is killed, not kept.** When the handshake
  timed out, the unresponsive child stayed attached as the live worker, so the
  next call trusted it and only failed after a full execution timeout. The
  child is now killed at the start timeout and the next call spawns afresh.
- **Writing to a dying worker cannot crash the host.** The worker's stdin had
  no error listener, so a write that raced its exit raised EPIPE as an
  uncaught exception in the host process. The stream now has a listener; the
  exit path already reports the worker as gone. A spawn failure (`EAGAIN`,
  `EMFILE`) is reported as a `BrowserError` for the same reason.
- **`withBrowser` checks its arguments before constructing a client**, so a
  missing callback or a non-object options bag is a `TypeError` naming the
  fix, not a worker left behind. When the callback throws and `close()` then
  fails too, the callback's error is the one reported; a close failure after
  a successful callback still propagates.
- **A vault whose `redact()` returns a non-envelope withholds the result.**
  The client threw a `TypeError` out of `run()` while reading the returned
  value; it now fails closed the same way a throwing `redact()` does,
  returning `ok: false` with the redaction-failed error.

## [2.0.0] - 2026-08-31

BetterWright 2.0 contains no breaking changes: every 1.x API, CLI command,
flag, and config file keeps working unchanged. The major version marks the
new setup experience (first-run onboarding, `configure`, the SDK entrypoint)
rather than a compatibility break.

### Added

- **First-run onboarding.** A bare `betterwright` on a terminal with nothing
  installed now opens with a welcome card and offers the guided setup
  (`betterwright init`) before starting the console: browser download, agent
  wiring, and a verified page load. The offer happens at most once; declining
  is remembered in `<home>/first-run.json`, and installs done by hand are
  detected and never prompted. Scripted entry points (`exec`, `run`, `mcp`,
  pipes) are untouched.

- **`betterwright configure`** sets up the browser backend from the CLI: an
  interactive picker over the managed fork, the nine built-in cloud providers,
  a raw CDP URL, or a local binary, with non-interactive flags (`--browser`,
  `--browser-key`, `--key-env`, `--managed`, `--show`, `--test`) for scripts.
  The choice is persisted as `browser.default` in `<home>/config.json`
  (written owner-only) and applies to every entry point: the JS API, the CLI,
  MCP, and the daemon. Precedence for one launch: the explicit `provider`
  option, then `BETTERWRIGHT_CDP_URL`, then the configured default, then the
  managed fork.
- **Custom named providers.** `betterwright configure --add <name>` registers
  any CDP service under a name of your own, as a connect-URL template with an
  optional `${apiKey}` placeholder, headers, and a key or key-env var. The
  name then works everywhere a built-in provider name does, including
  `provider: { provider: "<name>" }` in code. `--remove <name>` deletes it.
- **An orange terminal theme.** The CLI paints its output when stdout is a
  color terminal: the wordmark, command names, flags, success marks, menu
  numbers, and quoted commands in BetterWright orange; failures stay red and
  warnings yellow. Applied across help, `doctor`, `init`, `configure`, and
  `vault`. Piped output, `--json`, NO_COLOR, and TERM=dumb get exactly the
  plain bytes they always did; FORCE_COLOR overrides in either direction.
- **A live working indicator.** While a task runs, the interactive console's
  steering prompt animates a spinner with the current phase and how long it
  has been in it ("reasoning · 12s", "browsing · 3s"), and `exec` shows the
  same spinner on stderr between step lines. Phases come from a new optional
  `onPhase` callback on `runAgentTask`, fired at the start of each model turn
  and each tool batch. TTY only; piped output is unchanged.
- **The `betterwright/sdk` entrypoint**, a curated TypeScript import for
  embedding: the client, policy, vault, agent, and provider helpers together,
  plus a new `withBrowser(options?, fn)` helper that constructs a client, runs
  the callback, and always closes it. The root `betterwright` export is
  unchanged.

### Fixed

- **The `ask` tool asks the person at the terminal.** When a host provides an
  `askUser` callback (the interactive console always does), the question goes
  there. It used to wait in the live-view chat whenever a live-view surface
  existed, even one nobody had open, so the console showed no question and
  swallowed replies as steering until the ask timed out.
- **`betterwright run --browser steel script.js` runs the file.** `--browser`
  and `--browser-key` were missing from the value-flag list, so the provider
  name was read as the script positional. Both now consume their value in
  every command's argument parsing.

## [1.11.0] - 2026-08-30

### Added

- **`betterwright vault type <id>`** types a stored password into the focused
  window as keystrokes, for destinations that swallow clipboard paste
  (Proxmox noVNC, some VNC/SPICE consoles). A 5-second countdown leaves time
  to click the target; `--delay` and `--key-delay` override the wait and the
  inter-key pace. The secret is piped on stdin so it never appears in `ps` or
  terminal scrollback. `paste` is an alias. Owner-only, audited, unreachable
  from the worker RPC — the same boundary as `vault copy`. A tool that starts
  and then fails is not retried, so a partial type is not duplicated. (#152)

## [1.10.3] - 2026-08-30

### Fixed

- **MCP and Pi now describe `page` and `context` as restricted Playwright
  wrappers.** Their live browser-tool descriptions name request routing as
  unavailable because it protects the network policy, and direct deterministic
  tests toward `page.addInitScript`, `page.setContent`, or a host-served local
  fixture instead of promising an API that fails only at runtime. (#150)

## [1.10.2] - 2026-08-27

### Changed

- **MCP snippets now have 2 minutes** before the worker restarts (was 30
  seconds). The JS API default is unchanged. Override with
  `BETTERWRIGHT_TIMEOUT_SECONDS` (minimum 5). (#145)

## [1.10.1] - 2026-08-26

### Fixed

- **`page.on("console")` and `page.on("pageerror")` work in MCP `browser`
  snippets.** The page global is still a restricted proxy — `route`, request
  events, and `removeAllListeners` stay forbidden so they cannot undo the
  worker's policy hooks — but the usual Playwright listeners now collect
  page-side console messages and uncaught exceptions for the current call.
  `once` / `off` match; listeners do not leak into the next snippet. (#143)

## [1.10.0] - 2026-08-20

### Added

- **Batch-native WebAgents workflows.** Participating sites can publish a
  compact action directory in `/webagents.md` (a fenced `webagents` JSON
  contract) or `/.well-known/webagents.json`. Browser snippets discover only
  the normalized directory with `webagents.discover()` and submit an entire
  validated dependency graph with one `webagents.batch()` call. Discovery is
  cached per page origin; raw prose never enters model context.
- **Conservative protocol boundaries.** Workflow endpoints must be same-origin,
  documents, schemas, actions, operation counts, and payloads are bounded, and
  undeclared actions, duplicate IDs, missing dependencies, and dependency
  cycles fail before a request is sent. Writes and irreversible actions require
  separate explicit per-call opt-ins. Responses remain untrusted page data and
  use the existing guarded, cookie-aware, redacted first-party request path.
- Sites may declare a bounded minimum operation interval and concurrency cap.
  BetterWright carries that normalized pacing contract in the single batch so
  site executors can protect downstream rate limits without restoring extra
  agent turns or UI round trips.
- **Compact semantic action directories on every ordinary website.** When no
  first-party workflow is published, BetterWright extracts visible controls,
  accessible names, current values, select options, duplicate-control context,
  iframe scope, and visible result evidence into a small `result.ui` directory.
  Models copy its normalized targets into `browser_batch`/`controls.batch()`
  instead of consuming a full accessibility snapshot or issuing one call per
  click. State changes briefly settle, then return a refreshed directory.
- **Guarded semantic UI batches.** The generic fast path executes up to 32
  role/label/text/ref/CSS-targeted interactions with auto-waiting, ambiguity
  rejection, bounded pacing, write/irreversible gates, password protection,
  and final visible verification. MCP can open a URL directly through
  `browser_batch`, eliminating a model-authored inspection on the first turn.

### Changed

- Agent, MCP, Pi, skill, and CLI guidance now checks WebAgents first, then uses
  WebMCP or the automatically synthesized semantic action directory. A full
  interactive snapshot is reserved for a target the compact directory omitted.
- Post-workflow refreshes use a bounded DOM/load settle rather than waiting
  forever for network-idle, so polling and streaming applications remain fast.

### Fixed

- **BetterChromium launches on Windows instead of failing with `spawn UNKNOWN`.**
  Chromium's Windows launcher depends on a version-named private assembly for
  `chrome_elf.dll`, but the `151.0.7922.108-r3` archive omitted its companion
  manifest. Managed installs now reconstruct and validate that deterministic
  manifest before launch; an install also missing the DLL is automatically
  downloaded again by ordinary setup. Packaging includes the manifest for
  future artifacts, and custom incomplete browser trees fail early with
  specific setup guidance.
  (#138)

## [1.9.9] - 2026-08-19

### Changed

- **MCP `browser_download` is autonomous.** Calling that tool grants the run
  permission to save a remote file. The `browser` tool still cannot download
  under the default `ask` worker policy. `BETTERWRIGHT_DOWNLOAD_POLICY=deny`
  disables downloads; `allow` also permits the `browser` tool to save files.
  MCP no longer depends on elicitation, which most hosts cannot present. (#134)

## [1.9.8] - 2026-08-19

### Changed

- **Faster browser-agent turns without changing the public tool surface.** MCP,
  Pi, the reusable operator prompt, and the built-in agent now tell models to
  plan a deterministic stretch, batch it into one browser call, read known
  article regions directly, inspect only unknown or failed UI, and capture
  final proof in the same call. They also make automatic host cleanup explicit
  so agents do not spend extra turns closing pages merely to finish. All tool
  names, input schemas, and JavaScript/TypeScript APIs remain compatible with
  1.9.7.
- **Less permanent model context.** The advertised MCP catalog is 5,342
  collapsed characters, down from 5,873 in 1.9.7 (9.0%), while regression
  assertions pin the locator, proof, challenge, download, credential, WebMCP,
  and handoff safety directives that must remain discoverable. The reusable
  operator prompt is also pinned below 4,000 characters.

### Fixed

- **Off-screen image-grid CAPTCHA tiles are clicked at their visible viewport
  coordinates.** Numbered captures can include tiles below the fold, but raw
  pointer input is viewport-relative. BetterWright now retains page-relative
  tile geometry, scrolls a selected tile into view when needed, and translates
  its box before clicking, so bottom-row picks are not silently dropped. Grid
  staleness checks also normalize for scrolling instead of treating the same
  challenge at a new scroll offset as a replacement grid.
- **A bad locator no longer consumes the entire browser-run deadline and
  destroys recoverable page state.** Ordinary Playwright actions now time out
  after 10 seconds while navigation keeps its 30-second allowance. A failed
  action returns early enough for the agent to inspect and retry, and the next
  call keeps the same live page instead of restarting the worker. A managed
  browser regression test covers both the bound and the preserved DOM.

## [1.9.7] - 2026-08-19

### Added

- **Typed first-party WebMCP page tools.** Browser snippets can discover a
  fresh, frame-aware tool snapshot with `webmcp.tools()` and invoke one with
  `webmcp.invoke()`. BetterWright enables the Chromium feature for local
  launches, keeps CDP worker-private, bounds schemas/inputs/outputs, marks all
  page-controlled results untrusted, fails closed on duplicate names across
  frames, requires explicit opt-in for tools declaring `autosubmit`, and
  requests cancellation when a terminal result times out. Attached and cloud
  browsers get an actionable launch-flag error when they do not expose the
  WebMCP domain.

## [1.9.6] - 2026-08-19

### Fixed

- **A failed upstream connect no longer poisons the guard proxy.** An
  `ENETUNREACH` from one IPv4 target — a dead TEST-NET address, a down
  service, a private range with no route — was cached as "IPv4 is
  unreachable" for 30 seconds. After that, unrelated reachable hosts,
  including a live loopback server, failed with `ERR_SOCKS_CONNECTION_FAILED`
  until the worker was restarted. Family-unreachability caching is now
  IPv6-only, where `ENETUNREACH` / `EAFNOSUPPORT` still mean the host has no
  IPv6. Connect timeouts are reported to Chromium as host-unreachable
  (SOCKS reply 4) rather than a general SOCKS server failure (reply 1), so
  the browser does not treat the proxy itself as dead. (#128)
- **`human.type` no longer reports success when the field stayed empty.**
  Rich-text editors such as Draft.js swallow synthetic key events, so
  typing resolved with `{ typed: N }` while the composer was still blank.
  After typing, `human.type` reads the field back and treats the action as
  landed only when the requested text was inserted in full — a prefix, an
  unchanged field, or an overlapping partial append is a miss. A failed
  append restores the original value before retrying, so a leaked prefix
  is not left behind. It then retries with `insertText` (then
  `document.execCommand` / `beforeinput`) and throws if the field still
  did not accept the text. (#129)

## [1.9.5] - 2026-08-17

### Added

- **End-to-end review skill, installed beside the browser skill.**
  `betterwright init` and `skill --install` now write
  `full-stack-e2e-review` next to `browser` in Claude Code, Agent Skills, and
  (with `--all`) Cursor skill directories. Hosts keep only the name and
  description in context; the playbook body loads when the user asks for an
  e2e review. It is not merged into MCP tool descriptions or the browser
  operator skill, and it has no `autoInject` keywords, so ordinary browsing
  and `betterwright exec` do not pay for it. `setup` / `update` backfill the
  companion next to an existing managed browser skill, and do not overwrite
  an unstamped user-authored playbook at that path. Adapted from
  [CuriosityOS/full-stack-e2e-review](https://github.com/CuriosityOS/full-stack-e2e-review).

## [1.9.3] - 2026-08-17

### Fixed

- **Do not click reCAPTCHA Skip after tile picks.** `#recaptcha-verify-button`
  is labeled Skip until a tile is selected; clicking it then requests a new
  puzzle instead of submitting. The solver waits until the control is actually
  Verify: a known Verify/Next name, or an unknown-locale Skip → Verify label
  change after a pick that started with no selected tiles. Replaying already
  selected tiles (Verify → Skip) is left alone. Agents are told that
  replacement photo grids are the same image-grid stage, so they keep picking
  instead of handing off after three photo swaps.

## [1.9.2] - 2026-08-17

### Fixed

- **Image-grid recapture after a selected reCAPTCHA tile.** Clicking a cell
  exposes a ~4px-inset selected-state wrapper. The tile cluster treated those
  inner boxes as extra cells, so a 3×3 recapture numbered 12 tiles and the
  overlay skipped indexes. Nested boxes are now collapsed and a regular
  photo-sized 3×3, 3×4, or 4×4 wins over a larger messy cluster. 2×2 and
  2×3 stay unboosted so widget chrome cannot outrank a real puzzle. A crop
  with no tiles no longer asks the host to pick numbered indexes.

## [1.9.1] - 2026-08-16

### Changed

- **Codebase-wide type-hygiene overhaul.** Adopted the anti-slop Oxlint plugin
  (vendored at `tools/oxlint/anti-slop/`, wired into `npm run lint`) and fixed
  all 607 findings it raised across `src/`, `bin/`, `types/`, tests, and
  benchmarks. Boundary parsing of hostile or dynamic values — page-derived
  data, model-authored tool arguments, persisted JSON, daemon protocol
  messages — is now centralized in `src/untrusted-value.ts` behind a named
  `UntrustedValue` contract with shared type guards and total readers, instead
  of ad-hoc inline `typeof` checks and `Record<string, any>` dictionaries.
  Every remaining type assertion carries a `SAFETY:` comment stating the
  invariant that justifies it. No intended behavior change; the full unit,
  type, and browser suites pass unchanged.
- **Renamed two exported CAPTCHA geometry helpers:** `findGrowingShape` is now
  `findGrowingRegion` and `locateGrowingShape` is now `locateGrowingRegion`.
  These are internal-leaning solver utilities; no other API changed.

### Fixed

- **Public type declarations now match the runtime.** `BetterWright.liveView`
  types `expose` as the runtime-validated string it actually is,
  `VaultAuditEntry` declares the `recovered`/`expired` fields the vault has
  always emitted, and open payloads (`fields`, artifact extras, vault
  request/response envelopes) are typed with the honest `UntrustedValue`
  contract instead of blanket `unknown` dictionaries.

## [1.9.0] - 2026-08-16

### Fixed

- **Headless launches on a GPU host now use the real GPU for WebGL.**
  Playwright's headless default silently appends `--use-angle=swiftshader-webgl`,
  which forced software GL even when hardware was present and tripped the fork's
  integrated-GPU spoof — so a headless run on a GPU machine reported an "Intel
  UHD 620" string that contradicted the desktop User-Agent, an inconsistency
  PixelScan-style checkers flag as "Masking detected." On a host with an
  accessible render device the managed args now bind `--use-gl=angle
  --use-angle=gl`, so the hardware backend wins and the genuine GPU is reported.
  GPU-less hosts keep the explicit SwiftShader binding unchanged.

### Added

- **`fingerprintNoise` option** (default `true`). The managed fork's
  per-profile canvas/audio/WebGL-readPixels farbling is keyed to the profile's
  `--fingerprint` seed. Keep it on for multi-account isolation (each profile
  gets a distinct, stable rendering fingerprint); set
  `new BetterWright({ fingerprintNoise: false })` when a single identity should
  present the host's genuine GPU rendering. Only affects the managed
  BetterChromium fork, not provider/remote browsers.

## [1.8.7] - 2026-08-16

Ships the release. 1.8.6 was tagged before the `credential-fill` gate fix
landed, and release tags are immutable after creation, so the publish workflow
re-ran the pre-fix suite and could not pass; the release ships as 1.8.7. This
adds the gate fix and the version bump on top of the (otherwise unchanged)
1.8.5/1.8.6 content.

### Fixed

- The `credential-fill` integration suite now skips cleanly when
  `BETTERWRIGHT_CHROMIUM_PATH/ROOT=off` (no managed browser) instead of
  failing at module load, so the publish workflow's final release verification
  passes.

## [1.8.6] - 2026-08-16

Releases the 1.8.5 content below. The 1.8.5 tag was cut before its squash merge
and pointed at a commit that is not an ancestor of `main`, so it could not pass
the publish workflow's provenance check; the release ships as 1.8.6. There are
no code changes from 1.8.5.

## [1.8.5] - 2026-08-16

A browser-platform release. The managed BetterChromium fork no longer
masquerades a Linux host as macOS — it presents its real host identity while
staying coherent as a desktop Linux browser, and adds a provider model for
bringing your own local binary or a cloud CDP browser.

### Changed

- BetterChromium presents the real host platform (a Linux host is a Linux
  browser) instead of masking as macOS. The platform/UA/WebGL macOS mask is
  now opt-in via `--fingerprint-platform=macos`, not the default.
- On an honest Linux identity the fork patches the like-headless tells
  CreepJS measures: Web Share, ContentIndex, ContactsManager, and
  NetInfoDownlinkMax are exposed as present (no desktop backends, matching
  real desktop Chrome); `ActiveText` maps to a system link color; and the
  launch context defaults to a dark color scheme. A GPU-less host no longer
  leaks "SwiftShader" as the WebGL renderer — it reports a common integrated
  GPU instead. CreepJS reports 0% like-headless / headless / stealth across
  GPU and GPU-less, headed and headless.
- CloakBrowser is removed. The managed fork is the default and only bundled
  browser.

### Added

- A `provider` option to connect your own browser: `{ executablePath }` for a
  local Chromium binary, `{ cdpUrl }` for a CDP endpoint, or
  `{ provider: "browserbase" | "browser-use" | "kernel" | ... }` for a cloud
  browser. See docs/browser-providers.md.
- Published BetterChromium `151.0.7922.108-r3` with the rebuilt Linux archive
  (the honest-identity fork above) and pinned setup/update to it. The macOS and
  Windows artifacts are unchanged from r2.

### Security

- A remote CDP provider must connect over `wss://`; plaintext `ws://` is now
  accepted only on loopback (`localhost`, `127.0.0.1`, `::1`), where the
  traffic never leaves the host.
- A session-minting cloud provider is released if the browser fails to connect
  or open a context, so a failed launch never leaves a metered session running.

## [1.8.3] - 2026-08-13

A browser-coherence and local challenge-solving release. BetterChromium derives
its default timezone from the browser's actual egress IP before web content
starts, and BetterWright adds bounded local motion, drag-fit, and numbered
image-grid CAPTCHA handling.

### Added

- Image-grid CAPTCHAs now return a tight numbered crop for a local
  `captcha.solve({ tiles: [indexes] })` or `captcha.clickTiles(indexes)` handoff.
  Stale picks are rejected when a challenge replaces its grid.
- `captcha.solve()` distinguishes hCaptcha motion and drag-to-fit puzzles from
  image grids. Automatic work remains bounded to at most three stages.

### Changed

- Published BetterChromium `151.0.7922.108-r2` and pinned setup/update to its
  immutable artifacts. The Linux archive includes all required resource packs
  and its wrapper launches the packaged `betterchromium` executable correctly.
- On Linux, BetterChromium resolves an IANA timezone through a bounded isolated
  Chromium preflight using Chromium's own system, PAC, and command-line proxy
  routing. `--bw-timezone` and `--fingerprint-timezone` always win; failed
  lookup does not block launch. Profile-installed proxy extensions are not
  loaded by the isolated preflight.
- The captured macOS identity now reports coherent outer-window geometry, dark
  appearance, macOS `ActiveText`, and native Web Share availability on Linux.
  These are Chromium-source changes gated by the managed identity, not
  detector-specific page scripts.

### Fixed

- Headed Chromium no longer shows Playwright's unsupported
  `--host-resolver-rules` infobar when using the SOCKS guard. The guard still
  resolves hostnames and re-validates every IP.
- CAPTCHA screenshots no longer wait 30 seconds for unsettled webfonts, and
  challenge crops prefer the puzzle iframe over the checkbox iframe.
- Widget clicks now prefer specific challenge controls, including closed-shadow
  iframe geometry, before host-page submit buttons.

### Verification

- Extracted Linux r2 reports the egress-derived timezone (`Asia/Singapore` in
  release validation), `navigator.webdriver = false`, no headless UA marker,
  and the captured macOS identity. `--bw-timezone=Europe/Berlin` overrides it.
- Live CreepJS reports 0% headless, 19% like-headless, and 0% stealth. The three
  remaining heuristics conflict with genuine macOS Chrome API availability and
  were intentionally not enabled merely to optimize the benchmark.


## [1.8.2] - 2026-08-12

A compatibility patch for the two regressions reported in
[#111](https://github.com/BetterWright/betterwright/issues/111). Existing
Chromium argument lists launch again, and container operators can make backend
selection deterministic instead of relying on a device-mount heuristic.

### Fixed

- `--disable-software-rasterizer` is now ignored with a result warning instead
  of throwing before browser launch. BetterWright still retains the software
  WebGL fallback required by the selected backend, but common headless-Chromium
  boilerplate no longer breaks an upgrade. Security boundaries such as proxy,
  remote-debugging, profile, and fingerprint switches remain hard errors.
- Added `BETTERWRIGHT_BACKEND=auto|chromium-fork|cloak`. The default `auto`
  policy is unchanged; `chromium-fork` overrides the Linux `/dev/dri` probe for
  bubblewrap, containers, and other mount namespaces where the host's device
  tree is hidden. A forced native backend still fails closed if the artifact is
  missing. `cloak` selects the compatibility backend directly.
- Runtime result warnings now expose every non-default routing decision, and
  `betterwright doctor --json` always exposes the selected backend and exact
  reason. Human-readable doctor output calls out automatic render-device
  fallback, forced native selection, and forced Cloak selection with the
  corresponding fix or tradeoff.
- `setup` and `update` honor the same explicit backend selector as runtime and
  doctor, including conflicts and unsupported-platform failures.

### Measured impact

- The deterministic regression in #111 changes from 0/5 pre-launch failures to
  5/5 successful forced-BetterChromium launches in the local macOS arm64
  regression repetition, with the caller's incompatible flag removed and both
  decisions reported. Linux x64 remains covered by the release workflow; this
  5/5 result is compatibility evidence, not a cross-platform speed benchmark.
- Backend selection performs one environment-value parse in addition to the
  existing startup-only `/dev/dri` probe. It adds no per-page script, network
  hop, or persistent process, so 1.8.2 makes no new speed or RSS claim.
- The speed and memory table in #111 was collected after 1.8.1 had silently
  selected CloakBrowser. Those numbers are not presented as BetterChromium
  gains in this release.

## [1.8.1] - 2026-08-12

A cross-platform compatibility and graphics fix for 1.8.0. BetterChromium
remains the default wherever a pinned native artifact exists; unsupported hosts
once again launch managed CloakBrowser without requiring an undocumented
environment override.

### Fixed

- Linux arm64 systems, including Raspberry Pi, now automatically select
  CloakBrowser because no BetterChromium artifact is published for that target.
  The same routing applies to every unsupported OS/architecture pair.
- `betterwright setup`, `betterwright update`, `betterwright init`, and
  `betterwright doctor` now agree on the selected backend: unsupported hosts
  install, update, verify, and report CloakBrowser without requiring
  `BETTERWRIGHT_CHROMIUM_ROOT=off`.
- Fixed [#109](https://github.com/BetterWright/betterwright/issues/109):
  GPU-less Linux hosts now automatically use the managed CloakBrowser backend,
  whose packaged software renderer keeps standard WebGL available instead of
  presenting a macOS browser identity with the graphics surface blocked.
  GPU-capable hosts retain native BetterChromium. The browser-level regression
  test runs against whichever backend `doctor` selects and requires a real
  context, extensions, pixel readback, and a coherent UA/platform/GPU identity.
- Supported hosts with a missing BetterChromium install still fail closed with
  setup guidance. Invalid explicit paths and roots remain errors rather than
  silently switching browsers.
- If BetterChromium 151 already upgraded a persistent profile, the older Cloak
  backend uses a stable nested compatibility profile instead of crashing on a
  forbidden profile downgrade. The original profile and logins stay untouched;
  the compatibility profile maintains its own persistent sign-ins.

### Security and performance

- The fallback reuses the existing managed CloakBrowser launcher and keeps all
  browser traffic on BetterWright's SOCKS guard; no direct or unguarded launch
  path was added.
- GPU-capable BetterChromium launches do not take a new compatibility path.
  GPU detection is one bounded `/dev/dri` directory check at startup and adds
  no per-page work or page-world scripts.
- On the same GPU-less Linux container that reproduces BetterChromium's blocked
  WebGL, the automatic Cloak fallback created WebGL, exposed 33 extensions, and
  completed pixel readback correctly. Its first diagnostic launch took 8.76 s;
  that single cold run validates compatibility and is not a speed benchmark.
  1.8.1 makes no new memory or speed claim for this fallback.
- A fresh-profile CreepJS verification completed its fingerprint in 2.27 s with
  WebGL available, the captured Apple M4 Pro renderer, 0% `headless`, and 0%
  `stealth`. Its `like headless` heuristic was 31%; because that check ran on a
  different host from the issue's 44% report, this is recorded as validation,
  not claimed as a comparable score reduction.

## [1.8.0] - 2026-08-12

A native-browser overhaul centered on BetterChromium 151. Public archives for
all three supported platforms are published and SHA-256 pinned.

### Added

- Added reproducible BetterChromium 151 build and packaging definitions for
  macOS arm64, Linux x64, and Windows x64, plus verified archives in the public
  download manifest.
- Added a browser-process benchmark harness for cold and warm startup,
  navigation, process-tree memory and CPU, renderer counts, and long-session
  growth, including native idle-page lifecycle measurements.
- Added sequential `browser_evidence` checklists for issue
  [#106](https://github.com/BetterWright/betterwright/issues/106), requiring
  atomic task requirements to be initialized, visibly proved, and audited
  before an agent can finish.

### Changed

- Renamed the Chromium fork and its release/artifact identity to
  BetterChromium, pinned to Chromium 151.
- Removed Obscura and made native BetterChromium the required/default backend
  on supported hosts. CloakBrowser remains an explicit compatibility opt-out
  and is never selected as a silent fallback.
- Centralized the captured macOS identity so launch flags, browser contexts,
  rendering surfaces, and WebGPU report one versioned hardware profile.
- BetterChromium now uses a soft two-renderer ceiling, which still permits
  security-required site-isolated renderers but no longer retains Chromium
  151's unused spare process. Proof screenshots encode at CSS-pixel scale while
  the page continues to expose and render with its captured DPR-2 identity. A
  default benchmark proof falls from 3600x2164 to 1800x1082 encoded pixels.
  In seven-run Apple M4 Max measurements against the pre-optimization 1.8.0
  code, warm startup improved **7.3%**, navigation-plus-proof improved
  **21.2%**, cold/warm peak process-tree RSS fell **12.0%**, active CPU fell
  **31.4%**, and active renderers fell from **3 to 2**. Cold startup improved
  **0.8%** and 100-turn RSS growth improved **4.6%**.
- Against the standard 1.7.2 installation in the same seven-run harness, cold
  and warm startup improved **22.4%** and **21.2%**, and navigation-plus-proof
  improved **91.3%**. Cold/warm peak RSS was **1.9%/1.5% higher**. The native
  browser remains resident, so idle RSS is higher than 1.7.2's Obscura-backed
  idle state; the peak figures compare the periods when both versions are
  actively producing browser proofs.
- Idle pages now use Chromium's native frozen/active lifecycle with reversible
  animation scheduling, preserving timers and `requestAnimationFrame` state
  across parking.
- Hardened the encrypted Stealth Bench runner to require and fingerprint the
  intended BetterChromium binary, sanitize proxy metadata, reject CAPTCHA and
  screenshot paths, and fail closed on backend drift. A three-task sample
  passed **2/3**; this is a sample result, not a full-benchmark score.

### Fixed

- Issue [#106](https://github.com/BetterWright/betterwright/issues/106) browser
  tasks no longer complete from an ungrounded aggregate assertion: evidence is
  collected in checklist order and completion remains blocked while any
  required item lacks current-page proof.

## [1.7.2] - 2026-08-11

The stable boundary-validation fix for
[#103](https://github.com/BetterWright/betterwright/issues/103), promoted from
`1.7.2-beta.0` after beta testing. There are no public API removals or behavior
changes for valid arguments.

In the issue reproduction on a warm managed browser, the invalid role-name
call now fails in 5 ms instead of exhausting the 30,000 ms run timeout. The
invalid page-handle call fails in 4 ms.

### Fixed

- `getByRole(role, {name})` now rejects object-valued names before Playwright
  builds an internal selector. The error identifies the argument and received
  type (`name must be a string or RegExp, received object`) instead of emitting
  an `InvalidSelectorError` containing `[object Object]` or consuming the
  action/run timeout. Cross-realm `RegExp` matchers are preserved rather than
  being flattened to `{}`, so valid calls such as `{name: /email/i}` continue
  to work.
- `usePage(handle)` and `closePage(handle)` now reject non-string/non-number
  handles at the helper boundary with the received type. Objects no longer
  become misleading `Unknown page [object Object]` messages or silent
  `{closed: false}` results; page ID strings, numeric indexes, and the omitted
  current-page argument retain their existing behavior.

## [1.7.1] - 2026-08-09

A token, CPU, and memory efficiency patch. There are no client API removals;
model-facing optional result fields are now omitted when empty and retain the
same names and values whenever present.

### Added

- Added `benchmarks/efficiency`, a deterministic, browser-free comparison
  harness for the model observation, long-transcript, and snapshot-diff paths.
  The recorded figures compare five fresh-process samples of 1.7.0 (`273e51d`)
  and 1.7.1 on an Apple M4 Pro with Node v24.16.0.

### Changed

- Built-in-agent and MCP observations no longer repeat null placeholders and
  empty arrays on every browser call. A minimal successful observation is 53
  serialized characters instead of 174 in the built-in agent and 168 over MCP;
  with `js-tiktoken@1.0.21` `cl100k_base`, that is **44 → 15 tokens (65.9%
  fewer)** and **43 → 15 (65.1% fewer)** respectively. Non-empty errors,
  console lines, pages, challenges, skill hints, warnings, files, screenshots,
  and pending-credential metadata are still returned. Across the 2,000-turn
  harness workload, the accumulated transcript is **750,009 → 476,009
  characters (36.5% smaller)**.

- The built-in agent now accounts for each appended transcript message once
  instead of serializing the complete, growing history before every turn. The
  no-I/O 2,000-turn harness falls from **906.3 ms to 17.2 ms (52.8× faster)**,
  with process peak RSS down **81.1 → 77.3 MiB (4.8%)**. Real model and browser
  latency reduces the end-to-end percentage, but the removed CPU work and
  temporary strings do not return.

- Snapshot diffs detect wholly replaced line sets in linear time and reconstruct
  other LCS diffs from sparse checkpoints plus one reusable 64-row block. At
  the public 3,000-line cap, retained DP storage falls from **18,012,002 bytes
  to under 700 KiB** while randomized differential tests keep output
  byte-for-byte identical to 1.7.0. A wholesale replacement improves from
  **18.8 → 1.3 ms (14.6×)** and **66.0 → 45.9 MiB peak RSS (30.4% lower)**.
  An adversarial input sharing only one displaced line uses **51.1 MiB instead
  of 66.3 MiB (22.9% lower)** but takes 33.9 ms instead of 15.7 ms because it
  recomputes bounded row blocks; ordinary snapshot diffs first trim their large
  common prefix and suffix and operate on a much smaller changed region.

## [1.7.0] - 2026-08-07

A browser and agent-efficiency release.

### Added

- Added the frozen, same-origin `site` surface for inspecting application
  assets and request metadata, reading bounded text excerpts, and issuing
  cookie-bearing requests. This provides general client-app tooling without
  embedding site-specific endpoints or puzzle instructions.
- **Live view is now a real browser.** The viewer grew full browser chrome:
  an editable address bar (omnibox rules — URLs pass through, bare hosts get
  `https://`, anything else becomes a search; only `http(s)` schemes are
  accepted, enforced server-side), back / forward / reload wired to the
  page's real CDP history (buttons enable from actual history state), a
  **+** button that opens a new tab in the viewed session (adopted exactly
  like an agent page — limits, listeners, and policy included), and per-tab
  close (× or middle-click). Keyboard shortcuts while controlling:
  Ctrl/Cmd+L focuses the address bar, Alt+←/→ navigate, Ctrl/Cmd+R reloads.
  Every new control sits behind the same server-side gate as mouse/keyboard
  input — watch-only viewers get read-only chrome — and viewer navigation
  flows through the policy proxy like any other navigation.

### Changed

- The generated browser skill is 647 words instead of 1,434. The concise form
  won the Qwen 3.8 Max evaluation with 23.1% fewer reported tokens, 19.9% less
  wall time, fewer browser calls, and no browser failures while retaining the
  authorization, exactness, credential, CAPTCHA, download, proof, and handoff
  rules as tested invariants.

- **Live-view chat and handoff UI revamp.** Chat moved out of the bottom
  dock (which ate up to a third of the window) into a collapsible side panel
  with an unread badge, so the stream gets the full viewport. `handoff` and
  `ask` now elevate into a prominent action bar under the toolbar — handoff
  shows the reason with **Done — resume agent** / **Cancel step** and an
  optional note field; ask shows the question with its choice chips and a
  reply box — instead of being folded into the chat composer.

### Fixed

- `site.read()` and `site.request()` cap response bytes while streaming,
  including chunked responses, rather than buffering an unbounded body before
  truncation.
- Cloak 145 headed windows on macOS now use a coherent viewport instead of
  occasionally reporting a viewport taller than the advertised screen.

## [1.6.3] - 2026-08-03

A performance release, continuing 1.6.2. No API changes: 1.6.3 is a drop-in
replacement for 1.6.2. The theme is round trips — between the worker and the
client, and between the worker and the browser.

### Added

- `benchmarks/perf`, a regression harness for this work: per-action latency
  with an adjacent late-session control so per-session drift is not charged to
  the thing being measured, guard RPCs counted at the client boundary and
  bucketed by origin, and the challenge-scan tax at 10 and 24 genuinely
  cross-site frames. Fixture servers count their own requests and the run fails
  if a load is not exactly the expected size, so a browser-cache artifact cannot
  be mistaken for a win.

### Changed

- Guard decisions are cached in the worker. Every browser connection previously
  cost a full RPC to the client process per policy check — one per HTTP request,
  plus one per hostname and one *serial* RPC per resolved IP in the SOCKS guard.
  For a stock `NetworkPolicy` the verdict is a pure function of scheme, host and
  port, so those answers are now cached (5 s, 2048 entries). On a 50-subresource
  page load: **95 guard RPCs to 1**.

  The client, which is the only process the policy lives in, decides per
  response whether it may be cached at all — a `custom` hook, a subclass, an
  instance-patched `check` or any other object is never eligible, checked per
  RPC rather than once at construction. Full-URL checks (navigations, documents,
  downloads, websockets) are never cached in either direction, and a failed
  check is never cached, so the transport still fails closed on retry.
  Mutating `allowHosts`/`blockHosts` mid-session takes up to 5 s to apply to a
  host already contacted; installing a `custom` hook empties the cache instead,
  so it governs hosts already seen. See "Decision caching" in
  `docs/network-policy.md`.

- Resolved addresses are validated in one parallel wave rather than serially.
  Every address is still decided before any connect, and failures are reported
  in address order rather than settle order, so which error a caller sees does
  not depend on guard timing.

- Challenge detection is now staged. Every `run()` still reads the main frame's
  title, text and provider response tokens, but the per-frame walk — one round
  trip per frame, previously paid on every action — runs only when something
  already points at a challenge: a provider URL, matching main or same-origin
  frame text, a recent 403/429/503 document response, a challenge left
  unresolved by the previous action, or an unreadable cross-origin frame.
  Benign iframes no longer tax every agent action. `captcha.solve()` and
  `captcha.detect()` are unchanged and always read every frame. See
  "When detection runs" in `docs/captcha.md`, including the one accepted
  limitation: a page with more than three opaque cross-origin frames where the
  challenge is identifiable only by the text inside one of them.

  On the benchmark fixture the per-action iframe tax falls from **+27–30 ms to
  +1.5–1.7 ms at 10 cross-site frames**, and from **+54–60 ms to +2.4–4.1 ms at
  24**. Stage 2 also dropped from about five round trips per frame to two, and
  now reads frame text and checked state through utility-world locators, so page
  script cannot shape what the detector sees — detection is harder to fool than
  it was before, not just cheaper.

- The sandbox no longer recompiles its constant realm factory on every execute;
  the `vm.Script` is built once at module load. Snippet compilation moved to
  `src/compile-code.ts`, which tries the statement form first for snippets that
  cannot begin an expression. Which form runs is unchanged — including the
  sloppy-mode cases where `let` is an identifier (`let.x`, `let in o`,
  `let instanceof X`), which must stay expression-first — and a seeded
  differential corpus evaluates both orders to prove it.

  This shows up on trivial snippets rather than real ones: on a quiet page,
  per-action latency is unchanged within noise, because a snippet that touches
  the page is dominated by its round trip rather than by compilation.
## [1.6.2] - 2026-08-02

A performance release. No API changes: 1.6.2 is a drop-in replacement for
1.6.1.

### Changed

- `NetworkPolicy.check` — the per-request hot path behind the guard proxy —
  no longer re-parses its private/loopback CIDR literals on every call: the
  ranges are parsed once at module load. Allow/block host entries are parsed
  (lowercase, trim, port split, bracket strip) once and cached in a bounded
  map instead of on every host check, and the scheme test uses a `Set` rather
  than allocating an array per call. Measured at 300k checks: 409 ms → 311 ms.
- `filterInteractive` replaces its backwards ancestor scan — quadratic on
  large snapshots, because every interactive line rescanned toward the root —
  with parent links from a single monotonic-stack pass, stopping early on
  ancestors already kept. Indents and property-line tests are computed once
  per line instead of inside two inner loops. A 3000-line snapshot filters in
  0.3 ms instead of 22 ms; output is unchanged, verified line for line against
  the previous implementation by a randomized differential suite.

## [1.6.1] - 2026-07-31

A performance release. No API removals and no behavior flags to set: 1.6.1 is a
drop-in replacement for 1.6.0.

### Added

- **Idle sessions no longer burn CPU.** A headless Chromium target never becomes
  hidden — `document.visibilityState` stays `"visible"` for the life of the page
  — so every open page kept its frame loop running at the host refresh rate
  (measured at ~120 fps) whether or not anything was driving it. A session with
  five ordinary animated tabs burned **~110% CPU while completely idle**, and
  four agents made that four times over. BetterWright now parks a session's
  pages once its last execution unwinds — page script is disabled and animation
  timelines are set to rate zero — and restores them before the next execution
  begins, so the quiet window is exactly the model's thinking time.

  Measured on the pinned fork (150.0.7871.129), idling with tabs open:

  | scenario | 1.6.0 | 1.6.1 |
  | --- | --- | --- |
  | 1 session, 5 tabs | 97% CPU, 1845 MB | **25% CPU, 1709 MB** |
  | 4 sessions, 3 tabs each | 129% CPU, 3805 MB | **53% CPU, 3529 MB** |

  Parking never applies in headed mode or while a live view is streaming — a
  frozen page is a bug when a human is watching one — and it waits for the
  session to be genuinely idle (750 ms), so an agent's back-to-back calls never
  pay for it. Pages with credential capture in flight are left running, because
  the vault sensor lives in an isolated world and script execution is disabled
  per renderer, not per world. Turn it off with `parkBackgroundPages: false` or
  `BETTERWRIGHT_PARK_BACKGROUND_PAGES=0`.

  The one behavior change: a page animated by a `requestAnimationFrame` chain
  does not resume that chain after being parked, because the pending callback
  never fires and so nothing re-registers it. Everything else — in-page state,
  `setInterval`/`setTimeout`, CSS and Web Animations, clicks, typing,
  navigation, screenshots, network, newly registered `requestAnimationFrame`
  callbacks — resumes normally.

### Changed

- `diffSnapshots` interns snapshot lines before building its LCS table, so the
  inner loop compares integers instead of strings, and stores the table as
  `Uint16Array` rather than `Uint32Array` — subsequence lengths are bounded by
  the 3000-line cap, so the wider type was never needed. A one-sided change
  (everything added, or everything removed) now skips the table entirely. At
  the size cap the transient allocation drops from 34 MB to 17 MB per call.
  Output is unchanged: a randomized suite checks it line for line, tie-breaks
  included, against the 1.6.0 implementation.

### Fixed

- Parking exposed, and this release fixes, an ordering hazard in how the worker
  brackets executions: work queued as one execution unwinds could land after
  the next one had already started. Park/wake now reconcile toward a recorded
  intent rather than deciding from the state at call time, so whoever asks last
  wins regardless of the order the CDP traffic lands in.

## [1.6.0] - 2026-07-31

### Added

- `CODE_OF_CONDUCT.md`, GitHub issue forms, a pull-request template, and
  `CODEOWNERS`.
- A cross-platform CI job covering Linux, macOS, and Windows on Node 22 and 24,
  an advisory dependency-audit job, per-job timeouts, and cancellation of
  superseded pull-request runs. All six platform legs gate merges.
- `.nvmrc` and `.gitattributes`, the latter pinning LF so the byte-exact
  `SKILL.md` test passes in a Windows working tree.

### Changed

- `engines.node` is now `>=22.18.0`, the version the shipped TypeScript
  examples already required. CI and the publish workflow build on that same
  version, which previously differed from each other.
- Documented benchmark results now carry their methodology: the Online-Mind2Web
  figure is labelled self-judged and best-validated rather than one-shot, and
  the unsubstantiated observation-token claim was replaced with a description
  of what the snapshot compressor actually prunes.
- Operator and research tooling moved from `scripts/` to `research/`, which is
  documented as unsupported and is not part of the build.
- Documentation images are referenced by absolute URL so they render from the
  published npm tarball, which does not ship them.

### Fixed

- The credential vault's multi-process lock now works on Windows, where a
  directory cannot be renamed while any handle is open to a file inside it and
  a file cannot be renamed over a destination another process holds open. The
  lease opens after the publish rename there (ownership is re-proven by token
  and file identity), lock retirement and vault writes briefly outlast
  concurrent readers pinning their destination, and a quarantine blocked by a
  live owner's open lease keeps waiting instead of crashing. The recorded
  filesystem evidence lives in `research/windows-fs-probe.mjs`, and the entire
  unit suite that surfaced this — 49 failing tests at first contact — now
  passes and gates on Windows.
- `human.type` actually clears the field before typing on the default
  BetterChromium fork. Its clear step pressed `Control+A` and trusted
  the browser to select-all, but the fork does not run the select-all editing
  command for synthesized keyboard events, so typed text landed in front of
  the old value. The clear now selects through the element itself, which works
  on every browser build, inside iframes, and for contenteditables.
- The live view no longer delivers the same frame to the same viewer twice
  when a visibility repaint races the broadcast; every delivery path now goes
  through one per-client gate.
- `mkdirPrivate` tightens permissions only on directories it actually creates.
  It previously re-chmodded a pre-existing directory to `0700` — for the
  profile lock, that directory is wherever the user pointed the profile,
  silently revoking access the user had deliberately granted.
- The JWT payload decoder names `base64url` explicitly instead of relying on
  Node's lenient `base64` decoder accepting the URL-safe alphabet.
- `NetworkPolicy.checkHost`, `downloadPolicyFromEnv`, and the daemon's identity
  platform are typed against the published declarations, so an implementation
  that drifts from `types/` now fails the build.

## [1.5.2] - 2026-07-30

### Changed

- The Linux x64 Chromium fork now uses file-backed FontDataService transport
  and a four-renderer soft limit. These reduce summed Chromium PSS by at least
  25% at 1, 5, 10, and 20 same-site tabs in the validated four-vCPU workload,
  while preserving full Site Isolation, process locks, fingerprint output,
  and an explicit `--renderer-process-limit` override.

### Fixed

- Chromium-only GitHub Releases no longer start the npm publishing job; only
  package release tags beginning with `v` may enter Trusted Publishing.

## [1.5.1] - 2026-07-28

### Fixed

- Managed Cloak sessions now allow native service-worker registration, matching
  the Chromium-fork path and ordinary Chrome behavior while keeping all worker
  traffic behind the policy guard proxy.
- Dormant CAPTCHA providers preloaded in hidden or zero-size iframes no longer
  appear as active challenges. A visible widget or blocking verification prompt
  is still detected and follows the existing solve/handoff flow.

### Changed

- Completed the repository-wide TypeScript migration for build and release
  scripts, tests, benchmarks, and shipped examples. Published examples now live
  under `examples/typescript/*.ts` and are type-checked against the public
  declarations; runtime package exports remain ordinary JavaScript.

### Added

- The pinned BetterChromium 150 fork now ships for Windows x64 in
  addition to macOS arm64 and Linux x64. `betterwright setup` and
  `betterwright update` verify and install the Windows artifact using the
  built-in `tar.exe`, then select it as the zero-configuration default.
  CloakBrowser remains the explicit or automatic fallback when the fork is
  disabled or absent. Windows doctor output also avoids the Linux-only
  fontconfig warning because Windows uses DirectWrite.
- Named browser profiles: `profile` on the `BetterWright` constructor,
  `--profile <name>` on the CLI, and `BETTERWRIGHT_PROFILE` for the MCP server
  and any shell (the flag wins). A
  profile is a separate identity inside one home — its own cookie jar at
  `browser/profiles/<name>`, its own profile lock, its own session daemon
  (`daemon-<name>.sock`), and its own `exec` transcripts — so two identities
  run at the same time and both stay signed in. `--session` remains the way to
  run parallel work as the *same* identity. `betterwright sessions` now lists
  every profile's daemon and `close --all` stops all of them; anything narrower
  acts only on the selected profile.
- Omitting `profile` changes nothing on disk: the same `browser/profile`
  directory, the same lock, the same `daemon.sock`, and the same
  `sessions/<name>/` transcripts. There is no migration. Upgrading while a
  daemon is running restarts that daemon once (its config signature now
  records the profile), as any flag change does.

## [1.5.0] - 2026-07-25

### Changed

- Migrated all runtime and CLI source files to TypeScript 7.0.2. The package
  now compiles NodeNext ESM into `dist/` and publishes ordinary JavaScript, so
  consumers need no TypeScript loader and existing imports, CLI commands, and
  public type declarations remain compatible.
- Tests, benchmarks, the Pi extension manifest, CI, and the npm release
  workflow now exercise the compiled artifacts instead of bypassing the build.
- Refreshed CloakBrowser's compatible `tar` transitive dependency to 7.5.22,
  including the fix for crafted-archive stack exhaustion.

### Added

- A no-emit typecheck and fail-closed TypeScript build with missing-import,
  switch-fallthrough, unreachable-code, and incomplete-return checks.
- Build-layout and package-contract gates that prove every TypeScript source
  emits JavaScript, every package export resolves, relative runtime imports are
  complete, CLI/worker entrypoints are executable, and no TypeScript source is
  included in the npm tarball.

No direct runtime dependency or public API changes.

## [1.4.0] - 2026-07-25

Getting started is one command, and the vault is no longer a one-way door.

### Added

- **`betterwright init`** — guided first-time setup. Checks Node, downloads the
  managed browser if it is missing, installs the agent skill into whichever
  hosts it detects (`~/.claude`, `~/.agents`, `~/.cursor`, and `~/.codex`'s
  `AGENTS.md` between managed markers), offers MCP registration when the Claude
  CLI is present, and finishes by loading a real page — because "installed" and
  "working" are different claims. Idempotent; `--yes` for scripts, plus
  `--skip-browser` / `--skip-agents`.
- **`betterwright vault`** — the human-facing view of the credential vault:
  `list`, `show`, `copy`, `rm`, `audit`, `path`. A password the agent generated
  during a signup or captured from a login you typed was previously
  unreachable, because every existing vault path is site-scoped and
  metadata-only by design.
  - `--reveal` is required to print a secret, and refuses any destination that
    is not a terminal so a redirect, a pipe, or a captured stdout cannot
    collect one by accident (`--force` /
    `BETTERWRIGHT_VAULT_ALLOW_NON_INTERACTIVE=1` overrides).
  - `vault copy` sends the password to the system clipboard, so it never
    enters terminal scrollback or shell history.
  - Every reveal is written to the metadata-only audit log.
- `LocalCredentialVault` owner-only methods behind those commands: `ownerList`,
  `ownerReveal`, `ownerRemove`, `ownerAudit`. They are deliberately **not**
  routable through `handleRequest`, the only surface the browser worker — and
  therefore model-authored snippet code — can address, so the model-facing
  boundary is unchanged. Declared in `types/vault.d.ts`.
- `betterwright/vault` subpath export, so a trusted JS host can use those
  owner-only methods (and the `VaultOwnerListResult` / `VaultRevealedRecord` /
  `VaultAuditEntry` types) without reaching into `src/`.
- `betterwright skill --status` reports where the agent skill is installed and
  whether each copy matches this package version.
- `betterwright mcp --check` verifies the MCP server can start (SDK peer plus
  browser) without going through a client that swallows the error.
- `betterwright doctor --json` and `--quiet`; the report now also covers which
  agent hosts are wired, whether the MCP SDK is present, which model backends
  are usable, and where the vault lives.
- `chromiumArgs` client option and `BETTERWRIGHT_CHROMIUM_ARGS` for appending
  Chromium switches to the managed launch — `--disable-gpu` on a GPU-less host
  being the motivating case ([#56]). Switches BetterWright owns (proxy
  selection, remote debugging, profile directory, and the `--fingerprint*` /
  `--lang` / `--bw-timezone` / `--headless` identity family) are rejected with a
  `TypeError`. A switch already in the managed list is dropped rather than
  appended, because Chromium resolves duplicate switches last-wins, and the drop
  is reported in the next result's `warnings`.
- `types/agent.d.ts` now declares `sealTranscript`, the `signal` run option, the
  `interrupted` and `no_progress` result reasons, and the `endpointSourceName` /
  `endpointDiscoverySources` / `discoveryTimeoutMs` helpers, all of which the
  runtime already exported.

### Performance

- **The CLI no longer loads the browser/worker/agent stack to talk to a running
  daemon.** `daemon.mjs` constructed a `BetterWright` at import, so any client
  that imported it for a socket path or config signature pulled the whole
  browser graph (~20 ms) with it; the CLI entrypoint compounded this by
  importing the agent and browser modules statically. The browser stack is now
  loaded on first construction and the daemon builds its browser lazily, so the
  hot `run` / `close` / `vault` / `sessions` / `view` paths — which only send an
  RPC to an already-running daemon — skip it. Cold CLI start dropped from
  ~46 ms to ~39 ms, a saving paid on every invocation, and the daemon-client
  import graph shrank from ~16 ms to ~5 ms.

### Changed

- **`--help` no longer runs the command.** `setup --help` downloaded a 200 MB
  browser, `update --help` downloaded the Chromium fork, `run --help` blocked
  forever reading stdin, `close --help` closed your session, `view --help`
  started a live-view server, and `skill --help` printed nine kilobytes of
  agent instructions. Every subcommand now has real help, resolved before
  dispatch, and `-h` works wherever `--help` does. `betterwright help <command>`
  is equivalent.
- `betterwright doctor` prints a grouped report — runtime, browser, agent
  integration, built-in agent, credentials — where each line carries `✓`/`!`/`✗`
  and every failure names the command that fixes it. The previous flat
  key/value dump is still available verbatim under `--json`.
- The default model for `exec` and the interactive console follows what is
  actually configured rather than always being `claude-opus-4-8`. A user who
  had signed in with `auth --login codex` — the sign-in the README recommends
  first — previously hit "@anthropic-ai/sdk is not installed" on their first
  task with a working backend already available. When no backend is configured
  at all, both paths now say so up front, with the four ways to fix it, instead
  of failing inside the model adapter.
- The agent skill tells agents that `betterwright vault` is the user's command,
  not theirs: `vault list` is fine, `show --reveal` / `copy` / `rm` are not.
- `import "betterwright/worker"` no longer starts a worker process. The subpath
  resolves to a side-effect-free constants module; `METADATA_RESOLVER_RULES` is
  unchanged.
- `LocalCredentialVault` constructed without `dir` or `home` now honors
  `BETTERWRIGHT_HOME` instead of hard-coding `~/.betterwright`, matching every
  other component. Callers that pass an explicit `home` are unaffected.

### Fixed

- **`vault get --reveal` no longer bypasses the non-terminal reveal gate.**
  `get` is an alias of `show`, but the guard keyed on the subcommand name, so
  `vault get <id> --reveal > file` printed a secret to a pipe with no `--force`
  — the one spelling with no gate. Every path that puts plaintext on stdout is
  now gated; only `vault copy` (clipboard, never stdout) is exempt.
- **Browser capture no longer duplicates — or silently widens the scope of, or
  drops — a credential during a generated signup.** `generateAndFill` types its
  secret into the page, so the capture sensor saw an ordinary accepted
  submission and saved it a second time, leaving two records per agent signup;
  the duplicate used capture's `base-domain` default, widening a credential
  scoped to `host` / `exact-origin` across the whole registrable domain. The
  suppression now happens inside the vault, keyed on whether the submitted
  password *is* the pending generated secret (a constant-time compare) rather
  than on a username guess — so a *different* password typed at the same site
  during the pending window (a failed fill retried by hand, or a headed user's
  own "Save password?") is still saved instead of being silently lost.
- **A configured model backend is no longer refused by `exec`.** The default
  model and `doctor`'s readiness check resolved the optional `@anthropic-ai/sdk`
  peer only next to the package, missing a project-local copy — so a global
  install with `ANTHROPIC_API_KEY` and the SDK in the project (which worked
  before) hit exit 1 with "install a package you already installed". Both now
  use the same working-directory-aware resolution the model adapter uses.
  `doctor` and `exec` also agreed to disagree about OpenRouter/Ollama/API-key
  backends: `exec` refused what `doctor` called ready. `exec` now accepts a
  plain `OPENAI_API_KEY` / `XAI_API_KEY`, and for a source with no default
  model id (OpenRouter, Ollama) it prints "name one with `--model source/id`"
  instead of the false "no backend configured".
- **`betterwright init` is safe to re-run and survives a bad host.** Editing
  `~/.codex/AGENTS.md` refused to guess when its markers were not a clean pair
  (an orphaned marker used to splice out the user's text on the second run) and
  writes atomically; its block now carries a version stamp so an upgrade
  replaces it instead of appending. One unwritable agent host no longer aborts
  the whole run before verification; a network failure at the verify step warns
  instead of failing after everything installed; a run that verified nothing
  (`--skip-browser`) no longer claims "ready"; and `-y` works as `--yes`.
- **A deep or symlinked `BETTERWRIGHT_HOME` no longer costs you session
  persistence.** Beyond the socket-length fallback below, the fallback
  directory hardening no longer runs against — or chmods — the user's own home
  on the natural path (it applies only to the shared-tmpdir fallback), the home
  hash resolves symlinks so two spellings of one home share one daemon, and a
  programmatic `connectSessionDaemon({home})` now pins that home into the
  spawned daemon so client and daemon bind the same socket.
- `types/vault.d.ts`: `VaultRevealedRecord` and `ownerRemove`'s return no
  longer require `id`/`updatedAt`, which a revealed or removed *pending* signup
  does not carry.
- **A deep `BETTERWRIGHT_HOME` no longer costs you session persistence.** A
  unix socket path is capped by `sockaddr_un.sun_path` (104 bytes on macOS, 108
  on Linux) and the kernel rejects a longer one with `EINVAL`, so a home under
  a long path — a CI workspace, a deep project directory, a container mount —
  killed the session daemon on `listen`. Every `run`/`exec` then fell back to a
  private browser, reporting only "the session daemon did not start". Such a
  home now binds a short owner-only socket derived from it, in a `0700`
  directory whose ownership is verified before use.
- A literal NUL in a skill `autoInject` url pattern was translated into `.*`,
  letting a pattern match paths it did not describe. NULs are now stripped
  before glob translation.
- Host-side secret redaction fails closed: if redaction throws, the result
  envelope is withheld rather than returned unredacted.

[#56]: https://github.com/BetterWright/betterwright/issues/56

## [1.3.1] - 2026-07-24

Credential automation now recovers cleanly when a busy or hostile page
renderer stops answering.

### Fixed

- Explicit credential target document and origin validation is bound to the
  existing credential scan budget, so a wedged renderer cannot stall the call.
- Trusted credential filling no longer runs page-defined element classification
  or `blur()` hooks, closing an avenue for hostile pages to observe the fill.
- Post-fill validation is triggered with bounded trusted keyboard input.
- Failures on busy, blocked, or continuously rendering pages return clearer
  recovery guidance.

No public API or type changes.

## [1.3.0] - 2026-07-24

Released as 1.3.0 rather than 1.2.0: `1.2.0` was published to npm by the
managed-relay release that was later withdrawn, and npm never allows a version
number to be reused.

### Added

- Session daemon protocol 2: every run carries an id, a monotonic `seq`, and a
  bounded replay ring, so a reconnecting client reattaches from its cursor and
  is told plainly when it fell behind.
- `interrupt` op that threads an `AbortSignal` through the agent loop. Ctrl-C
  during `betterwright exec` stops the run and keeps the transcript, so the
  next `exec` on that session resumes from there.
- Orphan detection: a run whose last subscriber leaves is interrupted after a
  grace period (`BETTERWRIGHT_ORPHAN_GRACE_SECONDS`, default 30, `0` disables).
- No-progress guard in the agent loop: three identical consecutive browser
  failures warn the model to change approach; five end the run with
  `reason: "no_progress"`.
- [docs/sessions.md](docs/sessions.md) covering persistence, concurrency,
  interrupting a run, and reconnecting.

### Changed

- Separate sessions now run concurrently (per-session lanes replace the
  client's global queue); calls within one session stay strictly ordered, and
  the browser-wide download permission became a reference-counted gate.
- Credential probes carry a per-frame deadline and an overall scan budget; a
  frame that misses either is named in the failure reason instead of hanging
  the call or being silently absent.
- Transcripts are sealed on interrupt and timeout, so no dangling tool call
  reaches the next provider request.
- Daemon crash hygiene: backpressure drops subscribers that stopped reading,
  oversized request lines are refused, `unhandledRejection` is survived, and
  `uncaughtException` closes gracefully with exit 1.

## [1.2.0] - 2026-07-24 [YANKED]

### Added

- A Cloudflare-hosted managed Live View relay with account keys, quotas, and
  billing safeguards. Withdrawn by 1.1.4; the version number is retired on npm.

## [1.1.4] - 2026-07-24

### Removed

- The managed Live View relay and BetterWright account/API-key flows shipped in
  1.2.0, restoring the 1.1.3 local-only Live View behavior. Users on 1.2.0
  should update.

## [1.1.3] - 2026-07-24

### Added

- Live view and handoff can be opened mid-session, not only at process or task
  start, in every agent mode: `browser_handoff` (MCP), a new `live_view` tool
  and interactive `/live` (standalone), and `betterwright view`, which attaches
  to the session daemon (CLI + skill). Snippets still cannot start the viewer.
- Agent skill sync: `betterwright skill --install` writes the Claude Code and
  Agent Skills directories (`--all` also writes Cursor); `setup` and `update`
  refresh already-installed skill files but never create new ones; `doctor`
  tips when a managed skill is stale.

[Unreleased]: https://github.com/BetterWright/betterwright/compare/v2.4.0...HEAD
[2.4.0]: https://github.com/BetterWright/betterwright/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/BetterWright/betterwright/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/BetterWright/betterwright/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/BetterWright/betterwright/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/BetterWright/betterwright/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/BetterWright/betterwright/compare/v1.11.0...v2.0.0
[1.11.0]: https://github.com/BetterWright/betterwright/compare/v1.10.3...v1.11.0
[1.10.3]: https://github.com/BetterWright/betterwright/compare/v1.10.2...v1.10.3
[1.10.2]: https://github.com/BetterWright/betterwright/compare/v1.10.1...v1.10.2
[1.10.1]: https://github.com/BetterWright/betterwright/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/BetterWright/betterwright/compare/v1.9.9...v1.10.0
[1.9.9]: https://github.com/BetterWright/betterwright/compare/v1.9.8...v1.9.9
[1.9.8]: https://github.com/BetterWright/betterwright/compare/v1.9.7...v1.9.8
[1.9.7]: https://github.com/BetterWright/betterwright/compare/v1.9.6...v1.9.7
[1.9.6]: https://github.com/BetterWright/betterwright/compare/v1.9.5...v1.9.6
[1.9.5]: https://github.com/BetterWright/betterwright/compare/v1.9.3...v1.9.5
[1.9.3]: https://github.com/BetterWright/betterwright/compare/v1.9.2...v1.9.3
[1.9.2]: https://github.com/BetterWright/betterwright/compare/v1.9.1...v1.9.2
[1.9.1]: https://github.com/BetterWright/betterwright/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/BetterWright/betterwright/compare/v1.8.7...v1.9.0
[1.8.7]: https://github.com/BetterWright/betterwright/compare/v1.8.6...v1.8.7
[1.8.6]: https://github.com/BetterWright/betterwright/compare/v1.8.5...v1.8.6
[1.8.5]: https://github.com/BetterWright/betterwright/compare/v1.8.3...v1.8.5
[1.8.3]: https://github.com/BetterWright/betterwright/compare/v1.8.2...v1.8.3
[1.8.2]: https://github.com/BetterWright/betterwright/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/BetterWright/betterwright/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/BetterWright/betterwright/compare/v1.7.2...v1.8.0
[1.7.2]: https://github.com/BetterWright/betterwright/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/BetterWright/betterwright/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/BetterWright/betterwright/compare/v1.6.3...v1.7.0
[1.6.3]: https://github.com/BetterWright/betterwright/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/BetterWright/betterwright/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/BetterWright/betterwright/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/BetterWright/betterwright/compare/v1.5.2...v1.6.0
[1.5.2]: https://github.com/BetterWright/betterwright/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/BetterWright/betterwright/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/BetterWright/betterwright/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/BetterWright/betterwright/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/BetterWright/betterwright/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/BetterWright/betterwright/compare/v1.1.4...v1.3.0
[1.2.0]: https://github.com/BetterWright/betterwright/releases/tag/v1.2.0
[1.1.4]: https://github.com/BetterWright/betterwright/releases/tag/v1.1.4
[1.1.3]: https://github.com/BetterWright/betterwright/compare/v1.1.2...v1.1.3
