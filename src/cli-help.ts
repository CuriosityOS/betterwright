// Help text for every `betterwright` subcommand.
//
// This exists because `--help` used to fall through to the command itself:
// `betterwright setup --help` downloaded a 200 MB browser, `run --help` blocked
// forever reading stdin, `close --help` closed your session, and `skill --help`
// printed nine kilobytes of agent instructions. Asking a tool what it does
// should never be the thing that does it, so the router in bin/betterwright.ts
// consults this table before dispatching.

export const MCP_REGISTER_COMMAND =
  "claude mcp add betterwright -- bunx betterwright mcp";

export const COMMAND_SUMMARIES = [
  ["init", "guided first-time setup — browser, agent wiring, verification"],
  ["setup", "download the managed browser for this host"],
  ["update", "download or refresh the managed browser for this host"],
  ["doctor", "check that everything needed is installed and reachable"],
  ["configure", "choose the browser backend: cloud provider, custom CDP, or managed"],
  ["boxes", "start, list, and stop cloud browser boxes"],
  ["cookies", "sync local browser cookies into a BetterWright profile"],
  ["run", "run one Playwright snippet in the persistent session"],
  ["record", "record the current tab as an MP4 or WebM video"],
  ["repl", "run blank-line-separated snippets from stdin"],
  ["exec", "hand a whole task to BetterWright's own browser agent"],
  ["vault", "read and manage saved passwords"],
  ["sessions", "list live browser sessions"],
  ["close", "close a session (--all stops every profile's daemon)"],
  ["models", "list models the configured backends expose"],
  ["view", "open a live web view of the browser"],
  ["auth", "sign in to a model backend (codex | grok)"],
  ["skill", "print or install the agent instructions"],
  ["skills", "read the on-demand site knowledge packs"],
  ["mcp", "serve the MCP stdio server"],
];

export const MAIN_USAGE = `betterwright — a persistent, policy-guarded browser for AI agents

Usage: betterwright <command> [options]
       betterwright                 interactive agent console (no command)

New here? Run \`betterwright init\`.

Commands:
${COMMAND_SUMMARIES.map(([name, summary]) => `  ${name.padEnd(10)} ${summary}`).join("\n")}

\`betterwright <command> --help\` explains one command.
Docs: https://github.com/BetterWright/betterwright#readme`;

/**
 * Per-command help. Any command absent from this table falls back to
 * MAIN_USAGE, which is still better than running the command by accident.
 */
export const COMMAND_HELP = {
  record: `Usage: betterwright record start [name.mp4] [options]
       betterwright record restart [name.mp4] [options]
       betterwright record stop [--session <name>]
       betterwright record status [--session <name>]

Record the current tab without replacing its page or session state.
MP4/H.264 is the default; a .webm filename selects WebM/VP8.
Videos are saved in the session artifact directory. Use a filename, not a path.
start/restart options:
  --fps <n>           requested/output FPS, 1-60 (default 60)
  --max-width <px>    maximum video width (default 1280)
  --max-height <px>   maximum video height (default 720)
  --quality <n>       capture quality, 1-100 (default 80)
  --max-duration <s>  stop after this many seconds (default 300)
  --session <name>    browser session (default "default")
  --profile <name>    browser identity

Requires FFmpeg with libx264 (MP4) or libvpx (WebM) on PATH or BETTERWRIGHT_FFMPEG_PATH. Does not install it.
Actual motion cadence depends on page rendering and capture speed.
Captures the viewport without audio. Stop flushes the video and returns its path.
Requires the session daemon; --no-daemon and --close are not supported.
Details: docs/recording.md`,

  init: `Usage: betterwright init [options]

Guided first-time setup. Checks Bun, installs the managed browser if it is
missing, wires up whichever agent hosts it finds on this machine, and verifies
the whole path with a real page load.

Options:
  --yes            accept every default; never prompt (for scripts and CI)
  --skip-browser   do not download or verify the browser
  --skip-agents    do not touch any agent configuration

Safe to re-run: it reports what is already done and changes only what is not.`,

  setup: `Usage: betterwright setup [options]

Download native BetterChromium, the bundled browser on supported macOS arm64,
Linux x64, and Windows x64 hosts. On platforms with no published artifact,
setup has nothing to install — use --browser / the provider option to bring
your own Chromium binary or a cloud browser (docs/browser-providers.md).

Options:
  --force        re-download the managed browser even when already present

Also refreshes installed agent skill files. Run \`betterwright doctor\` afterwards.`,

  update: `Usage: betterwright update [options]

Download or refresh the managed browser: native BetterChromium when a pinned
artifact is published for this host.

Options:
  --force   re-download even if the pinned version is already installed`,

  doctor: `Usage: betterwright doctor [options]

Check that everything BetterWright needs is installed and reachable: the
runtime, the managed browser, the agent integrations you have wired up, a
usable model for \`exec\`, and the credential vault.

Options:
  --json   the raw report, for scripts
  --quiet  print only problems

Exit code is 0 when ready, 1 otherwise.`,

  configure: `Usage: betterwright configure
       betterwright configure --browser <name|wss-url|path> [--browser-key <key> | --key-env <NAME>]
       betterwright configure --connect <name> [--browser-key <key> | --key-env <NAME>]
       betterwright configure --show [--json]

Choose the browser every launch uses: the managed BetterChromium fork, a cloud
provider, any CDP endpoint, or your own Chromium binary. With no options on a
terminal it walks you through the choices and offers to connect once; the flags
do the same things without prompting. The choice is stored in the browser
section of <BETTERWRIGHT_HOME>/config.json, written owner-only.

--connect saves a provider API key without changing the launch default, so
\`betterwright boxes\` can start/list/stop sessions on that account. Setting
--browser <name> with a key also connects the account.

Options:
  --show                 print the current setting (the default with no terminal)
  --json                 machine-readable output for --show; stored keys are
                         masked either way
  --browser <value>      set the default. A provider name (browser-use, kernel,
                         browserbase, steel, anchor, hyperbrowser, browserless,
                         brightdata, oxylabs, or one you added), a wss:// CDP
                         endpoint, or an absolute path to a Chromium binary
  --browser-key <key>    store that provider's API key in the config file
  --key-env <NAME>       read that provider's API key from this environment
                         variable instead, so it never enters the file
                         (mutually exclusive with --browser-key)
  --connect <name>       save that built-in provider's key without making it
                         the launch default (alias: \`configure connect <name>\`)
  --disconnect <name>    forget a saved provider key (alias: disconnect)
  --managed, --reset     clear the default; launches use the managed fork again
  --add <name>           add a custom provider named <name>, with
    --cdp-url <template>   its connect URL, where \${apiKey} is replaced with
                           the key at launch
    --key-env <NAME> | --browser-key <key>   where its key comes from
    --docs <url>           where the service documents its endpoint
    --display-name <label> how menus and errors name it
  --remove <name>        delete a custom provider
  --test                 after setting (or on its own) connect to the configured
                         browser and print its version
  --no-test              do not offer the connection test in the interactive flow

Precedence at launch: --browser / the provider option, then
BETTERWRIGHT_CDP_URL, then this default, then the managed fork.
Exit code is 0 on success, 1 on a bad value or a failed connection test.
Details: docs/browser-providers.md`,

  boxes: `Usage: betterwright boxes <command>

  list [--browser <name>] [--status <s>]   boxes on a connected provider
  start [--browser <name>]                 create a box (REST providers only)
  show <id> [--browser <name>]             one box: status, live view, CDP
  stop <id> [--browser <name>]             release a box so it stops billing

Options:
  --json                 machine-readable output
  --browser <name>       which connected provider (kernel, browserbase, steel,
                         anchor, hyperbrowser, browser-use)
  --browser-key <key>    API key for this call only (not stored)
  --key-env <NAME>       read the API key from this environment variable
  --status <value>       passed through as the provider's list-status filter

Connect a provider first:
  betterwright configure --connect kernel --key-env KERNEL_API_KEY

Browserless, Bright Data, and Oxylabs have no session lifecycle — they are
connect-only. Details: docs/browser-providers.md`,

  cookies: `Usage: betterwright cookies browsers [--json]
       betterwright cookies profiles <browser> [--json]
       betterwright cookies sync <browser> (--domain <host>... | --all) [options]

Copy cookies from a local browser profile into the selected persistent
BetterWright profile. Sync merges cookies and can be run again safely.

Options for sync:
  --domain <host>          sync this domain, its subdomains, and applicable
                           parent-domain cookies. Repeat for more domains
  --all                    sync every compatible cookie in the source profile
  --source-profile <id>    source profile id or name from \`cookies profiles\`
  --include-session        include Firefox-family session-store cookies
  --allow-app-bound        on Windows, allow unprivileged browser-process
                           injection for Chrome App-Bound cookie decryption
  --profile <name>         target BetterWright identity
  --browser <name|url>     target cloud provider or CDP endpoint
  --browser-key <key>      target provider API key
  --session-id <id>        attach to an existing cloud browser
  --allow-cloud <target>   exact consent target printed by a refused attempt,
                           such as provider:browserbase or cdp:host:port
  --no-daemon              run without the target profile daemon
  --json                   machine-readable result

Cloud sync sends cookie plaintext through the encrypted CDP connection to the
provider. It does not enable provider profile persistence. Details:
docs/cookie-sync.md`,

  run: `Usage: betterwright run -c "<javascript>"
       betterwright run <file>
       betterwright run -            read the snippet from stdin

Run one snippet of async Playwright JavaScript in the persistent browser and
print one JSON object. A trailing expression, or an explicit \`return\`, is the
result. Globals include page, snapshot, screenshot, credentials, human, controls
(including one-call UI batches), site, webagents, and webmcp.

Options:
  --session <name>       which persistent session to use (default "default")
  --profile <name>       browser profile to act as — a separate identity with
                         its own cookies and its own daemon, at
                         browser/profiles/<name> (default: the shared profile;
                         BETTERWRIGHT_PROFILE sets one for the whole shell).
                         Use --session for parallel work as the same identity,
                         --profile for a different account.
  --ad-block             block ads/trackers (default on; also BETTERWRIGHT_AD_BLOCK=1)
  --no-ad-block           disable blocking, overriding the environment
  --headed               show the browser window
  --close                close the session after this call
  --approve-downloads    allow downloads for this one run
  --no-daemon            do not use the background session daemon
  --stealth              isolated-world driver (needs patchright-core)
  --browser <name|url>   use a cloud browser provider (browser-use, kernel,
                         browserbase, steel, anchor, hyperbrowser, browserless,
                         brightdata, oxylabs, or one added with
                         \`betterwright configure --add\`) or any wss:// CDP
                         endpoint instead of the managed BetterChromium fork.
                         \`betterwright configure\` sets a default so you do
                         not have to pass this every time
  --browser-key <key>    provider API key (or its env var, e.g.
                         BROWSERBASE_API_KEY); BETTERWRIGHT_CDP_URL is the
                         env shorthand for --browser <url>
  --session-id <id>      attach to an existing cloud box instead of minting a
                         new one (REST providers and Steel)

Network:
  --block-private-network   --block-loopback
  --allow-host <host>       --block-host <host>

Example:
  betterwright run -c "await page.goto('https://example.com'); return page.title()"`,

  repl: `Usage: betterwright repl [options]

--ad-block enables ad/tracker blocking; --no-ad-block overrides BETTERWRIGHT_AD_BLOCK.

Read blank-line-separated snippets from stdin and run each one against the same
live session, printing a JSON result per snippet. Ctrl-D quits.

Takes the same session, profile, network, and browser flags as \`betterwright run\`.

Example:
  printf '%s\\n\\n%s\\n' "await page.goto('https://example.com')" "return page.title()" \\
    | betterwright repl`,

  vault: null, // supplied by vault-cli.js so the text lives beside the command

  sessions: `Usage: betterwright sessions

List the browser sessions held by the background daemons, with how long each
has been idle and whether a task is running in it. Every profile in this home
is listed, one daemon per profile. Never starts a daemon.`,

  close: `Usage: betterwright close [name] [options]

Close a persistent browser session. Open tabs go away; the on-disk profile, and
therefore your logins, do not.

Options:
  --session <name>   the session to close (default "default")
  --profile <name>   close a session of that profile (default: the shared one)
  --all              close every session of every profile and stop each daemon`,

  models: `Usage: betterwright models [source] [options]

List the models reachable right now. With no source, probes the native backends
plus any local Ollama or vLLM server and OpenRouter when keyed.

Sources: openrouter | ollama | vllm

Options:
  --base-url <url>       an OpenAI-compatible endpoint to query
  --api-key-env <name>   environment variable holding its key
  --json                 machine-readable output`,

  view: `Usage: betterwright view [options]

Open a live, token-gated web view of the browser and hold it until Ctrl-C.
Attaches to the running session when there is one, so you see the same tabs the
agent is driving.

Options:
  --expose <preset>    lan (default) | local | tailscale
  --host <host>        bind address; overrides --expose
  --port <port>        bind port (default: ephemeral)
  --profile <name>     watch that profile's browser (default: the shared one)
  --watch-only         no takeover controls
  --set-password       store a password every viewer must enter
  --clear-password     remove that password

The printed URL embeds a capability token. Treat it like a password.`,

  auth: `Usage: betterwright auth --login <codex|grok>
       betterwright auth --status

Sign in to a model backend for BetterWright's own agent, using the provider's
OAuth flow rather than an API key. Tokens are stored under BETTERWRIGHT_HOME.

  --login codex   use a ChatGPT/Codex subscription
  --login grok    use an xAI account
  --status        show which backends are signed in

Anthropic models use ANTHROPIC_API_KEY instead; local models need no sign-in.`,

  skill: `Usage: betterwright skill [options]

Print the agent instructions that teach any shell-capable agent to drive
BetterWright. With no options, writes the browser skill to stdout for pasting.

Options:
  --install    write browser + e2e-review skills to ~/.claude/skills and ~/.agents/skills
  --all        with --install, also write ~/.cursor/skills
  --claude     print Claude-form browser SKILL.md (frontmatter included) to stdout
  --status     show where the skills are installed and whether they are current

The e2e-review skill is installed beside the browser skill. Hosts keep only
its description in context until the user asks for an end-to-end review.

Codex reads an instructions file instead (browser skill only):
  betterwright skill >> ~/.codex/AGENTS.md

\`betterwright init\` does this for you, for whichever hosts it finds.`,

  skills: `Usage: betterwright skills [list | show <name>]

Site and password-manager knowledge packs the agent reads on demand. Run
results hint at packs matching the open page; this is how you read one yourself.`,

  mcp: `Usage: betterwright mcp [--check] [--ad-block | --no-ad-block]

Serve BetterWright over the Model Context Protocol on stdio. Exposes browser,
browser_login, browser_download, browser_handoff, and browser_doctor.

  --check   verify the server can start, then exit — use this to debug a
            client that shows no BetterWright tools

Register it with a client, for example:
  ${MCP_REGISTER_COMMAND}

Needs the @modelcontextprotocol/sdk peer dependency. Policy comes from the
environment; see SETUP.md §6.`,

  exec: null, // EXEC_USAGE lives in the bin entrypoint beside its flag parsing
};

export const BOXES_USAGE = COMMAND_HELP.boxes;

/** Help text for a command, or the main usage when there is nothing specific. */
export function helpFor(command) {
  return COMMAND_HELP[command] || MAIN_USAGE;
}

/**
 * True when the tokens after the subcommand are asking for help.
 * Deliberately only the flag forms: a bare `help` would swallow legitimate
 * arguments such as `betterwright exec "help me find a flight"`.
 */
export function wantsHelp(tokens) {
  return tokens.some((token) => token === "--help" || token === "-h");
}
