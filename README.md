<div align="center">

<img src="https://raw.githubusercontent.com/BetterWright/betterwright/main/docs/assets/logo.png" alt="BetterWright" width="96" />

# BetterWright

**The token-efficient browser for AI agents.**

[![npm](https://img.shields.io/npm/v/betterwright?color=cb3837&logo=npm)](https://www.npmjs.com/package/betterwright)
[![CI](https://github.com/BetterWright/betterwright/actions/workflows/ci.yml/badge.svg)](https://github.com/BetterWright/betterwright/actions/workflows/ci.yml)
[![bun](https://img.shields.io/badge/bun-1.4-fbf0df?logo=bun&logoColor=black)](#install)
[![license](https://img.shields.io/npm/l/betterwright)](LICENSE)

One persistent, policy-guarded browser your agent returns to turn after turn.
Drive it from your own agent (skill, MCP, or JS API) — or hand whole tasks to
its built-in browser agent and just read the answer.

</div>

```bash
bun install -g betterwright && betterwright init

betterwright run -c "await page.goto('https://example.com'); return page.title()"
# {"ok": true, "result": "Example Domain", ...}
```

`init` downloads the browser, wires up whichever agents it finds on your
machine, and proves it works by loading a real page. One command, no choices to
make up front.

**Compressed snapshots** instead of raw HTML or a full accessibility dump ·
read-only tasks finish in **one model turn** · persistent sessions so you
don't re-pay login and navigation cost every step.

---

## Two ways to use it

Embedding a browser in a desktop app? See the optional
[Electron host adapter](docs/electron-host.md).

|  | You want… | You get… |
| --- | --- | --- |
| **[Integrated](#1-integrated--your-agent-drives-the-browser)** | your agent (Claude Code, Codex, Pi, any MCP client, your own code) to browse as one part of a bigger job | a skill, MCP server, or JS API through which *your* agent mans the browser step by step |
| **[Standalone agent](#2-standalone--betterwright-is-the-browser-agent)** | to hand over a whole browser task and read back one answer | `betterwright exec "<task>"` — BetterWright's own browser-tuned agent loop does the driving; you (or your agent) get one JSON result |

They share everything — the same persistent sessions, vault, network policy,
and snapshots — so you can start with one and mix in the other later.

### 1. Integrated — your agent drives the browser

Any agent that can run a shell command can drive the browser.
`betterwright skill` prints the instructions that teach it how — CLI usage
plus operator guidance. No server, no SDK, no glue code.

```bash
# The short version: init detects your agent hosts and wires them all.
betterwright init

# Or do it by hand, one host at a time:
betterwright skill --install       # ~/.claude/skills + ~/.agents/skills (browser + e2e-review)
betterwright skill --install --all # also ~/.cursor/skills
betterwright skill --status        # where it landed, and whether it is current
betterwright skill >> ~/.codex/AGENTS.md   # Codex reads an instructions file

# Any custom agent — the same instructions ship as SKILL.md in this repo
# and the npm package (node_modules/betterwright/SKILL.md); copy it wherever
# your agent reads skills, or print it with `betterwright skill`.

# MCP (stdio server: browser, browser_login, browser_download, browser_handoff, browser_doctor)
bun add -g betterwright @modelcontextprotocol/sdk
claude mcp add betterwright -- bunx betterwright mcp
betterwright mcp --check           # why does my client show no tools?

# Pi Coding Agent (native persistent tools, trusted login, approval-gated downloads)
pi install npm:betterwright
```

After a package upgrade, `setup` / `update` refresh already-installed skill files,
and `doctor` says so if one is still stale.

Or drive it from your own code:

```js
import { BetterWright } from "betterwright";

const bw = new BetterWright();
await bw.run("await page.goto('http://localhost:5173')", { session: "dev" });
const title = await bw.run("return page.title()", { session: "dev" });
console.log(title.result);
await bw.close();
```

`run()` takes a string of async Playwright JavaScript with sandboxed globals —
`page`, `snapshot`, `screenshot`, `human`, `credentials`, and friends — and
returns one result envelope. Full API: [docs/javascript.md](docs/javascript.md)
· [docs/browser-api.md](docs/browser-api.md).

`betterwright/sdk` is the same API as a curated entrypoint, with a
`withBrowser(fn)` helper that closes the client for you when your callback
returns or throws: [docs/sdk.md](docs/sdk.md).

`page` and `context` are restricted Playwright wrappers. Request interception
(`page.route`, `context.route`, `unroute`, and `routeFromHAR`) is unavailable
because BetterWright's worker-owned routing enforces network policy. For
deterministic page tests, install in-page mocks with `page.addInitScript`
before navigation, use `page.setContent`, or serve a host-side local fixture.
See [What is removed](docs/browser-api.md#what-is-removed) for the complete
model-visible boundary.

**[SETUP.md](SETUP.md)** is the full integration guide, written to be followed
by an AI agent — point your coding agent at it and it wires any host end to end.

### 2. Standalone — BetterWright *is* the browser agent

BetterWright ships its own browser-tuned agent loop. Plug in a model, hand it
a task in plain language:

```bash
betterwright auth --login codex     # OAuth sign-in, no API key to paste
betterwright exec "find the top Hacker News story and give me its title and points" --model gpt-5.6-sol
```

The loop observes with compressed snapshots, acts, verifies, captures a proof
screenshot, and prints **one JSON object** — answer, steps, token usage,
proof path.

**Models are selected by real id**, not by adapter nickname. Pass the model
id you want (`gpt-5.6-sol`, `claude-opus-5`, `qwen3.8:27b`, …). BetterWright
probes running local servers (Ollama, vLLM), OpenRouter when keyed, and native
Claude / Codex / Grok routes; if exactly one source exposes that id, it uses
it. Prefix the source only to pin a collision (`ollama/qwen3.8:27b`). The words
`claude`, `codex`, and `grok` alone are **not** model shortcuts.

| You have… | Typical start |
| --- | --- |
| ChatGPT / Codex subscription | `betterwright auth --login codex` → `--model gpt-5.6-sol` |
| OpenAI API key with [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) access | `OPENAI_API_KEY=…` → `--model gpt-6-astra --protocol responses` |
| Anthropic API key | `ANTHROPIC_API_KEY=…` → `--model claude-opus-5` |
| xAI (OAuth or API key) | `betterwright auth --login grok` or `XAI_API_KEY` → `--model grok-4.6` |
| Local [Ollama](https://ollama.com) | `ollama pull qwen3.8:27b` → `--model qwen3.8:27b` or `ollama/qwen3.8:27b` |
| Local vLLM | serve with tool-calling enabled → `--model <id>` or `vllm/<id>` |
| [OpenRouter](https://openrouter.ai) | `OPENROUTER_API_KEY=…` → `--model <author/model>` |
| Any OpenAI-compatible `/v1` | `--base-url https://host/v1 --model <id>` |

Examples checked September 2026: [Claude Opus 5 and Sonnet 5](https://platform.claude.com/docs/en/models/overview),
[Grok 4.6](https://docs.x.ai/developers/models/grok-4.6), and
[Qwen3.8 27B](https://ollama.com/library/qwen3.8:27b). GPT-5.6 Sol remains the
subscription quick-start model. For the optional GPT-6 Astra API example,
tool calling requires `--protocol responses`; see the
[OpenAI model guide](https://developers.openai.com/api/docs/guides/latest-model).
The Ollama example downloads
about 18 GB of model weights; allow additional memory for the context and browser.

```bash
# Discover what is available (native defaults + reachable endpoints)
betterwright models
betterwright models ollama

# Local Ollama — no API key; default base http://127.0.0.1:11434/v1
ollama pull qwen3.8:27b
betterwright exec "check example.com" --model ollama/qwen3.8:27b

# GPT-6 Astra — requires model access and Responses for tool calling
OPENAI_API_KEY=… betterwright exec "check example.com" \
  --model gpt-6-astra --protocol responses

# OpenRouter — bare author/model id when unambiguous
OPENROUTER_API_KEY=… betterwright exec "check example.com" \
  --model anthropic/claude-sonnet-5

# Custom OpenAI-compatible endpoint
BETTERWRIGHT_MODEL_API_KEY=… betterwright exec "check example.com" \
  --base-url https://models.example/v1 --model <model-id>
```

The model must support **function / tool calling** well enough to drive the
browser tools — text-only chat models are not enough. Full flags, env vars,
and troubleshooting: [docs/agent.md](docs/agent.md).

Run bare **`betterwright`** for the interactive console: one browser session
across tasks, steps streaming as they happen, `/model`, `/endpoint`, and
`/models`, plus an `ask` tool so the agent can check with you before
consequential choices.

**Use it as a sub-agent.** Because `exec` is one shell command in and one JSON
object out, a *coding* agent can delegate entire browser tasks to it:

```bash
betterwright exec "log in to staging and download this month's invoice" --model gpt-5.6-sol
```

The whole browsing transcript — every snapshot, every retry — stays inside the
sub-agent. A 30-turn checkout costs your main agent **one tool call**, not
30 pages of context. Programmatic equivalent: `runAgentTask()` from
`betterwright/agent`.

## Tokens are the bottleneck

An agent's browser loop is *observe → decide → act*, and the observe step is
where context windows go to die. Raw HTML dumps, full accessibility trees, and
screenshot-only loops burn thousands of tokens per turn — so tasks hit context
limits, costs climb, and the model drowns in markup it never needed.

BetterWright's whole observation stack is built around that problem:

| Mechanism | Token effect |
| --- | --- |
| **Compressed agent snapshots** | Playwright's `mode: "ai"` accessibility tree with everything an agent cannot act on pruned out — `/url` property lines, refs on non-actionable roles, bare `generic` wrappers, duplicated text, names past 100 characters — leaving `[ref=eN]` markers the model acts on directly instead of re-deriving selectors |
| **Diff mode** | After an action, return **only what changed** — not the page again |
| **Interactive-only filter** | Drop static text nodes; keep what the agent can click, fill, or read |
| **Scoped truncation** | Hints about *where* to look next instead of a silently clipped wall |
| **Single-call finish** | Read-only tasks complete in **one model turn** — the code returns `{finalAnswer}` and the loop ends, no confirmation round-trip |
| **Persistent session** | One long-lived browser: no re-login, no re-navigation, no re-paying the token cost of getting back to where you were |
| **Sub-agent delegation** | `betterwright exec` keeps the entire browsing transcript out of your main agent's context — a whole task costs it one tool call |

## Watch it, coach it, take the wheel

Every run can carry a self-hosted [live view](docs/live-view.md): a web page
showing the browser in real time, with chat to guide the agent between turns
and a **handoff** flow for the moments automation shouldn't finish alone —
MFA, a resistant CAPTCHA, a consequential click. The agent pauses, you take
the controls, hit **Done**, and it resumes with your note.

```bash
betterwright exec "…" --live-view          # watch the whole run
betterwright view --expose tailscale       # drive a headless VPS browser from your laptop
betterwright view --set-password           # lock every viewer behind a password
```

Hosting is one word (`lan`, `local`, `tailscale`), auth is a capability token
plus an optional config-stored password, and nothing live-view-related is
reachable from model code.

## Why not just Playwright?

Playwright is built for tests: trusted scripts, known selectors, teardown at
the end. An agent is the opposite — untrusted model output deciding its next
step from what it sees, in a browser that must still be there next turn:

|  | Playwright | BetterWright |
| --- | --- | --- |
| **Observations** | Raw accessibility tree or DIY HTML | Compressed, diffable, redacted snapshots priced for a context window |
| **Session** | Browser per script | One persistent managed browser — logins survive turns, days, restarts |
| **Trust** | Full API access | Model code runs sandboxed: no file, process, or network-routing APIs |
| **Network** | Any URL | Every request policy-checked (DNS-rebinding-proof); cloud metadata endpoints always blocked |
| **Secrets** | Passwords in the script | AES-256-GCM vault; forms are detected and filled without the secret ever entering the conversation |
| **Evidence** | Assertions | `screenshot({kind: 'proof'})` — tagged artifacts the agent cites as proof of work |
| **CAPTCHAs** | Out of scope | Local `captcha.solve()` — checkbox, Turnstile, slider; vision handoff for image grids |
| **First-party tools** | No discovery API | `webmcp.tools()` / `webmcp.invoke()` — typed page capabilities, frame-safe discovery, autosubmit gate, timeout cancellation |
| **Human in the loop** | Out of scope | Token-gated [live view](docs/live-view.md): watch, chat, answer `ask`, or take over on `handoff` |

## What's in the box

| Piece | What it gives you |
| --- | --- |
| [**Agent snapshots**](docs/browser-api.md#reading-the-page) | The token-efficiency core: compressed tree, `[ref=eN]` actions, diff and interactive-only modes, password redaction |
| [**Built-in agent loop**](docs/agent.md) | `betterwright exec` / the interactive console / `runAgentTask()` — model-first selection across Claude, Codex, Grok, OpenRouter, Ollama, vLLM, and any OpenAI-compatible endpoint |
| [**Credential vault**](docs/credentials.md) | AES-256-GCM outside the profile; PSL site matching, selector-free login detection, metadata-only account choice |
| [**Cookie Sync**](docs/cookie-sync.md) | Merge selected cookies from local Chrome, Edge, Brave, Firefox, Safari, and other desktop browsers into BetterChromium or an explicitly approved cloud browser |
| [**Live view & handoff**](docs/live-view.md) | Watch and coach the agent live; token + optional password gated; `handoff` pauses for human hands and resumes on Done |
| [**Recording**](docs/recording.md) | Record the current tab to MP4 (or WebM) at up to 60 FPS through the CLI, snippet helpers, or MCP |
| [**Network policy**](docs/network-policy.md) | Every navigation, subresource, WebSocket, and raw TCP connection checked; metadata endpoints always blocked |
| [**CAPTCHA helpers**](docs/captcha.md) | Local solving for checkbox/Turnstile/slider; image grids hand off to the agent's own vision with tile crops |
| [**Human-shaped input**](docs/browser-api.md#human-shaped-interactions) | Curved pointer movement, paced typing, eased wheel — no extra dependency |
| [**WebMCP page tools**](docs/browser-api.md#page-published-webmcp-tools) | Discover and invoke typed first-party page capabilities; fresh frame-aware lookup, bounded input/output, explicit autosubmit opt-in, and automatic timeout cancellation |
| [**Launch identity**](docs/launch-identity.md) | Coherent native identity: build-specific viewport, locale, timezone, optional geo-matched egress. No page-world shims; the two public reCAPTCHA v3 score-detector demos in the stealth report return a server-verified 0.9 headed and headless |
| [**BetterChromium**](docs/chromium-fork.md) | Default browser on supported macOS arm64, Linux x64, and Windows x64 hosts: per-profile-stable canvas/audio farbling, no OS masquerade (Linux runs as Linux). Bring your own executable, CDP endpoint, or cloud browser via the [provider option](docs/browser-providers.md) |
| [**Browser providers**](docs/browser-providers.md) | Managed fork by default; attach a local executable, a raw CDP endpoint, or a named cloud browser. `configure --connect` saves API keys; `betterwright boxes` starts/lists/stops sessions on the six SDK-backed providers |
| [**Skill packs**](docs/skills.md) | Per-site and per-password-manager guidance the driving agent reads on demand — your own or the built-in loop — surfaced automatically when an open page matches |
| [**Download approval**](docs/browser-api.md) | Denied by default; a trusted host approves one download run at a time |
| [**Operator guidance**](docs/agent-prompt.md) | `betterwright skill` / `agentSystemPrompt()` — decisive action on authorized tasks, with optional confirmation/spending guardrails |

## Install

Requires **Bun 1.4**. Setup downloads the pinned native BetterChromium
browser for this host; GPU-less Linux runs it with the SwiftShader software
renderer.
Nothing is downloaded as an npm lifecycle side effect, so installs stay
predictable with `--ignore-scripts`.

```bash
bun install -g betterwright
betterwright init      # guided: browser + agent wiring + a real page load
```

`init` is safe to re-run and reports what is already done. The steps it runs
are all available on their own:

```bash
betterwright setup     # install the managed browser for this host
betterwright update    # refresh the managed browser for this host
betterwright doctor    # what is installed, what is missing, how to fix it
betterwright configure # default browser, connected provider API keys
betterwright boxes     # start / list / stop cloud browser sessions
```

## Getting a password back out

The vault fills logins without ever handing a secret to model code — which
would leave *you* locked out of a password your agent generated during a
signup. So there is a separate, human-only door:

```bash
betterwright vault list                # metadata: site, username, when
betterwright vault copy <id>           # password → clipboard, never the screen
betterwright vault type <id>           # type into the focused window (Proxmox / VNC)
betterwright vault show <id> --reveal  # print it (refuses to a pipe or a file)
betterwright vault audit               # every read and write, metadata only
```

`--reveal` writes plaintext only to a terminal; redirect it and it fails closed.
These commands live on an owner-only API that the browser worker — and so
model-authored snippet code — cannot reach. See
[SECURITY.md](SECURITY.md#the-shell-is-a-trusted-channel) for what that does
and does not protect.

## How it works

The CLI (or your JS host) owns one long-lived worker process. The worker holds
the persistent browser context and exposes sandboxed globals to model code; it
calls back to the host to authorize requests and resolve credentials without
putting secrets in results. CDP and raw browser handles stay worker-internal.
The security model — what the sandbox removes, why the metadata floor cannot
be lifted, and where it does *not* claim to be a boundary — is in
[docs/architecture.md](docs/architecture.md).

## Sessions and profiles

All state lives under `$BETTERWRIGHT_HOME` (default `~/.betterwright`): the
persistent browser profile, the credential vault, and artifacts. Two knobs
divide work up, and they are different axes:

- `--session <name>` — parallel lanes in **one** browser, sharing one cookie
  jar. Same identity, no launch cost, no queueing behind each other.
- `--profile <name>` — a **separate identity**: its own cookie jar at
  `browser/profiles/<name>`, its own session daemon, its own `exec` history.
  Two profiles run at once and both stay signed in.

```js
new BetterWright({ profile: "social" }); // the posting account
new BetterWright({ profile: "review" }); // the reading account, concurrently
```

Omitting `profile` keeps the single default profile, unchanged. The vault and
artifacts are shared across profiles, so a credential saved once fills
anywhere. CLI: `--profile <name>` or `BETTERWRIGHT_PROFILE`, which the MCP
server reads too. See
[docs/sessions.md](docs/sessions.md#sessions-vs-profiles).

## Docs

| Start here | Capabilities | Under the hood |
| --- | --- | --- |
| [Getting started](docs/getting-started.md) | [Credential vault](docs/credentials.md) | [Architecture & security model](docs/architecture.md) |
| [Integration guide (SETUP.md)](SETUP.md) | [Live view & handoff](docs/live-view.md) | [Launch identity](docs/launch-identity.md) |
| [The built-in agent](docs/agent.md) | [CAPTCHA helpers](docs/captcha.md) | [Chromium fork](docs/chromium-fork.md) |
| [JavaScript API](docs/javascript.md) | [Network policy](docs/network-policy.md) | [Headed / headless](docs/attach-mode.md) |
| [Browser API (snippet globals)](docs/browser-api.md) | [BetterChromium](docs/chromium-fork.md) | [Browser providers](docs/browser-providers.md) |
| [CAPTCHA recipes](docs/browser-recipes.md) | [Cookie Sync](docs/cookie-sync.md) | Benchmarks: [Online-Mind2Web, 92.7% self-judged](benchmarks/online-mind2web/REPORT.md) · [agent head-to-head](benchmarks/exec-headtohead/REPORT.md) |

The Online-Mind2Web figure is 278/300 on the pinned 2025-11-23 snapshot, scored
by BetterWright's own strict multimodal judge — **not** an official
Online-Mind2Web human evaluation or leaderboard result. It is also an iterative
best-validated campaign, combining retained validated outcomes across targeted
reruns, rather than a one-shot 300-task run. The
[report](benchmarks/online-mind2web/REPORT.md) states the method, the dataset
and manifest hashes, and the failed task ids.

## Scope and responsible use

BetterWright automates a browser under your direction, including signing in
and interacting with simple CAPTCHAs on sites you are authorized to use. It is
not built for bulk account creation, credential stuffing, or scraping behind
anti-bot walls at scale; its helpers exist to unblock a task you legitimately
own, not to repeatedly defeat a site that is telling automation to stop. No
browser configuration can guarantee undetectability or challenge acceptance.
See [the security model](docs/architecture.md#security-model) for the
boundaries the code does and does not enforce.

## Project identity and attribution

The official BetterWright project lives at
[github.com/BetterWright/betterwright](https://github.com/BetterWright/betterwright).
Forking, modification, integration, and commercial use are welcome under the
MIT License. Distributed copies or substantial portions must retain the
copyright and permission notice in [LICENSE](LICENSE).

Public source forks are asked to identify themselves as based on BetterWright
and use a distinct name and visual identity so users do not mistake them for
the official project. This does not restrict using BetterWright as a component
inside a larger product. See [NOTICE.md](NOTICE.md) and
[TRADEMARKS.md](TRADEMARKS.md).

## License

MIT. See [LICENSE](LICENSE).

### Ad blocking

Ghostery ad and tracker blocking is **on by default**, across tabs and frames.
Use `new BetterWright({ adBlock: false })`, `betterwright run --no-ad-block`, or
`BETTERWRIGHT_AD_BLOCK=0` (also applies to MCP and Pi) to disable it. Explicit
constructor options and CLI flags override the environment. See [ad blocking](docs/ad-blocking.md)
for cache updates, switching an existing session, and coverage limits.
