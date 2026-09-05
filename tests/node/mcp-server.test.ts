import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { BetterWright } from "../../dist/src/client.js";
import {
  _createMcpHandlersForTest,
  contentForResult,
  downloadPolicyFromEnv,
  headlessFromEnv,
  LOGIN_INPUT_SCHEMA,
  liveViewFromEnv,
  loginOptionsFromArgs,
  policyFromEnv,
  timeoutFromEnv,
} from "../../dist/src/mcp-server.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("MCP omits and rejects browser_login when the vault is disabled", async () => {
  let fillCalls = 0;
  const browser = new BetterWright({ vault: false });
  browser.fillCredential = async () => {
    fillCalls += 1;
    return { ok: true };
  };
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
  });
  try {
    const listed = await handlers.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["browser", "browser_batch", "browser_download", "browser_record", "browser_handoff", "browser_doctor"],
    );

    const response = await handlers.callTool({
      params: { name: "browser_login", arguments: { username: "alice" } },
    });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Unknown tool: browser_login/);
    assert.equal(fillCalls, 0);
  } finally {
    await browser.close();
  }
});

test("MCP recording dispatches guarded session calls and retains video artifacts", async () => {
  const calls = [];
  const video = { kind: "recording", path: "/tmp/recording.mp4", mimeType: "video/mp4" };
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: false,
      async run(code, options) {
        calls.push({ code, options });
        return { ok: true, result: { state: "completed", path: video.path }, artifacts: [video] };
      },
    },
    downloadPolicy: "deny",
  });
  const listed = await handlers.listTools();
  const tool = listed.tools.find((entry) => entry.name === "browser_record");
  assert.deepEqual(tool.inputSchema.properties.action.enum, ["start", "stop", "status", "restart"]);
  assert.equal(tool.inputSchema.properties.fps.default, 60);
  for (const action of ["start", "restart", "status", "stop"]) {
    const starting = action === "start" || action === "restart";
    const common = {
      action,
      session: "demo",
      approvedDownloads: true,
      code: "throw new Error('injected')",
    };
    const args = starting
      ? { ...common, name: 'take"1.mp4', fps: 60, maxDurationMs: 2000 }
      : common;
    const response = await handlers.callTool({ params: {
      name: "browser_record",
      arguments: args,
    } });
    assert.equal(response.isError, undefined);
    assert.equal(response.content.length, 1);
    assert.deepEqual(JSON.parse(response.content[0].text).files, [video]);
    assert.deepEqual(calls.at(-1).options, { session: "demo" });
    assert.equal(calls.at(-1).code, starting
      ? `return recording.${action}(${JSON.stringify({ name: 'take"1.mp4', fps: 60, maxDurationMs: 2000 })});`
      : `return recording.${action}();`);
  }
});

test("MCP recording rejects invalid actions and options on stop/status before running", async () => {
  let runs = 0;
  const handlers = _createMcpHandlersForTest({
    browser: { vault: false, async run() { runs += 1; } },
    downloadPolicy: "deny",
  });
  for (const args of [
    { action: "start);process.exit()" },
    { action: "stop", fps: 60 },
    { action: "status", name: "unused.webm" },
    {},
  ]) {
    const result = await handlers.callTool({ params: { name: "browser_record", arguments: args } });
    assert.equal(result.isError, true);
  }
  assert.equal(runs, 0);
});

test("MCP recording returns worker failure details", async () => {
  const handlers = _createMcpHandlersForTest({
    browser: { vault: false, async run() { return { ok: false, error: "FFmpeg is unavailable" }; } },
    downloadPolicy: "deny",
  });
  const response = await handlers.callTool({ params: {
    name: "browser_record", arguments: { action: "start" },
  } });
  assert.deepEqual(JSON.parse(response.content[0].text), { ok: false, error: "FFmpeg is unavailable" });
});

test("MCP inlines the companion bytes of a proof screenshot, never the full path", async () => {
  const dir = makeTempDir("betterwright-mcp-");
  const full = path.join(dir, "proof.png");
  const inline = `${full}.inline.png`;
  fs.writeFileSync(full, "full fidelity bytes");
  fs.writeFileSync(inline, "inline bytes");
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: false,
      async run() {
        return {
          ok: true,
          artifacts: [
            { kind: "proof", path: full, media: `MEDIA:${full}`, inlinePath: inline },
          ],
        };
      },
    },
    downloadPolicy: "deny",
  });
  const response = await handlers.callTool({
    params: { name: "browser", arguments: { code: "return 1" } },
  });
  assert.equal(response.isError, undefined, response.content[0].text);
  const summary = JSON.parse(response.content[0].text);
  assert.equal(summary.ok, true);
  assert.equal(summary.files, undefined);
  assert.deepEqual(response.content.slice(1), [
    {
      type: "image",
      data: Buffer.from("inline bytes").toString("base64"),
      mimeType: "image/png",
    },
  ]);
});

test("MCP inlines the full proof screenshot when no companion was written", async () => {
  const dir = makeTempDir("betterwright-mcp-");
  const full = path.join(dir, "proof.png");
  fs.writeFileSync(full, "full fidelity bytes");
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: false,
      async run() {
        return {
          ok: true,
          artifacts: [{ kind: "proof", path: full, media: `MEDIA:${full}` }],
        };
      },
    },
    downloadPolicy: "deny",
  });
  const response = await handlers.callTool({
    params: { name: "browser", arguments: { code: "return 1" } },
  });
  assert.equal(response.isError, undefined, response.content[0].text);
  assert.deepEqual(response.content.slice(1), [
    {
      type: "image",
      data: Buffer.from("full fidelity bytes").toString("base64"),
      mimeType: "image/png",
    },
  ]);
});

test("MCP advertises and dispatches browser_login when a vault is available", async () => {
  const calls = [];
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: {},
      async fillCredential(options) {
        calls.push(options);
        return { ok: true, result: { filled: true } };
      },
    },
    server: {},
    downloadPolicy: "deny",
  });

  const listed = await handlers.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "browser_login"));

  const response = await handlers.callTool({
    params: { name: "browser_login", arguments: { username: "alice", submit: true } },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [
    { session: "default", generate: false, username: "alice", submit: true },
  ]);
  assert.equal(JSON.parse(response.content[0].text).result.filled, true);
});

test("loginOptionsFromArgs keeps recognized keys and drops the rest", () => {
  assert.deepEqual(
    loginOptionsFromArgs({
      passwordSelector: "#pw",
      currentPasswordSelector: "#old-pw",
      usernameSelector: "#user",
      confirmPasswordSelector: "#confirm-pw",
      submitSelector: "#go",
      id: "rec-1",
      generate: true,
      submit: true,
      length: "18",
      includeSymbols: false,
      matchMode: "exact-origin",
      code: "danger()",
      note: "ignored",
    }),
    {
      session: "default",
      passwordSelector: "#pw",
      currentPasswordSelector: "#old-pw",
      generate: true,
      usernameSelector: "#user",
      confirmPasswordSelector: "#confirm-pw",
      submitSelector: "#go",
      id: "rec-1",
      length: 18,
      includeSymbols: false,
      matchMode: "exact-origin",
      submit: true,
    },
  );
  // Defaults: session "default", generate false, no stray keys.
  assert.deepEqual(loginOptionsFromArgs({}), {
    session: "default",
    generate: false,
  });
  assert.deepEqual(loginOptionsFromArgs({ session: "work", submit: false }), {
    session: "work",
    generate: false,
    submit: false,
  });
  assert.deepEqual(LOGIN_INPUT_SCHEMA.properties.matchMode.enum, [
    "base-domain",
    "host",
    "exact-origin",
    "never",
  ]);
  assert.equal(
    LOGIN_INPUT_SCHEMA.properties.currentPasswordSelector.type,
    "string",
  );
  assert.throws(
    () => loginOptionsFromArgs({ generate: true, matchMode: "same-site" }),
    /matchMode.*exact-origin/,
  );
});

test("MCP browser_batch dispatches one guarded worker transaction", async () => {
  const calls = [];
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: false,
      async run(code, options) {
        calls.push({ code, options });
        return { ok: true, result: { protocol: "ui-batch/1", pageUpdated: true } };
      },
    },
    downloadPolicy: "deny",
  });

  const response = await handlers.callTool({
    params: {
      name: "browser_batch",
      arguments: {
        session: "form",
        note: "Submitting and verifying the form.",
        allowWrites: true,
        allowPasswords: true,
        minIntervalMs: 25,
        proof: true,
        operations: [
          { id: "name", action: "fill", target: { label: "Name" }, value: "Ada\u2028Lovelace" },
          { id: "submit", action: "click", target: { role: "button", name: "Submit" } },
          { id: "verify", action: "read", target: { text: "Received!", exact: true }, value: "Received!" },
        ],
      },
    },
  });

  assert.equal(response.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.session, "form");
  assert.equal(calls[0].options.note, "Submitting and verifying the form.");
  assert.match(calls[0].code, /controls\.batch/);
  assert.match(calls[0].code, /allowWrites/);
  assert.match(calls[0].code, /"allowPasswordFill":true/);
  assert.match(calls[0].code, /minIntervalMs/);
  assert.match(calls[0].code, /\\u2028/);
  assert.match(calls[0].code, /const \{ui, \.\.\.batch\} = outcome/);
  assert.match(calls[0].code, /screenshot\(\{kind:'proof'\}\)/);
  assert.equal(JSON.parse(response.content[0].text).result.protocol, "ui-batch/1");
});

test("MCP browser_batch rejects a mutation without asserted final state", async () => {
  const calls = [];
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: false,
      async run(code, options) {
        calls.push({ code, options });
        return {
          ok: true,
          result: {
            batch: { protocol: "ui-batch/1", pageUpdated: true },
            ui: { protocol: "betterwright-ui/1", controls: [] },
          },
        };
      },
    },
    downloadPolicy: "deny",
  });

  const response = await handlers.callTool({
    params: {
      name: "browser_batch",
      arguments: {
        allowWrites: true,
        operations: [
          { id: "submit", action: "click", target: { role: "button", name: "Submit" } },
        ],
      },
    },
  });

  assert.equal(response.isError, true);
  assert.equal(calls.length, 0);
  assert.match(response.content[0].text, /non-empty expected value/);
});

test("MCP browser_batch rejects a final read without an expectation", async () => {
  const calls = [];
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: false,
      async run(code) {
        calls.push(code);
        return { ok: true, result: { protocol: "ui-batch/1" } };
      },
    },
    downloadPolicy: "deny",
  });

  const response = await handlers.callTool({
    params: {
      name: "browser_batch",
      arguments: {
        allowWrites: true,
        operations: [
          { id: "load", action: "click", target: { role: "button", name: "Load" } },
          { id: "weak", action: "read", target: { css: "main" } },
        ],
      },
    },
  });

  assert.equal(response.isError, true);
  assert.equal(calls.length, 0);
  assert.match(response.content[0].text, /non-empty expected value/);
});

test("MCP browser_batch opens a URL without model-authored inspection", async () => {
  const calls = [];
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: false,
      async run(code, options) {
        calls.push({ code, options });
        return { ok: true, result: "https://example.com/form" };
      },
    },
    downloadPolicy: "deny",
  });

  const response = await handlers.callTool({
    params: {
      name: "browser_batch",
      arguments: { url: "https://example.com/form", session: "open" },
    },
  });

  assert.equal(response.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.session, "open");
  assert.equal(
    calls[0].code,
    'await page.goto("https://example.com/form"); return page.url();',
  );
  assert.doesNotMatch(calls[0].code, /snapshot|innerText|content/);
});

// The MCP tool list is re-sent on every request, so its size is permanent
// context overhead for every user of the server. This pins both halves of the
// bargain struck when descriptions were compressed on 2026-07-25 and again
// the budget stops prose creeping back, and directive assertions stop a future
// pass from buying room by dropping a rule instead of a redundant word.
test("the advertised MCP tool list stays inside its context budget", async () => {
  const handlers = _createMcpHandlersForTest({
    browser: { vault: {} },
    server: {},
    downloadPolicy: "ask",
  });
  const { tools } = await handlers.listTools();

  // Collapse runs of whitespace: line wrapping is nearly free in characters but
  // costs a token per line, so raw length would understate a rewrap regression.
  const size = JSON.stringify(tools.filter((tool) => tool.name !== "browser_record")).replace(/\s+/g, " ").length;
  assert.ok(size < 7_200, `MCP tool list grew to ${size} collapsed characters`);
  const recordingSize = JSON.stringify(tools.find((tool) => tool.name === "browser_record")).replace(/\s+/g, " ").length;
  assert.ok(recordingSize < 1_000, `recording tool grew to ${recordingSize} collapsed characters`);

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const text = (name) => byName[name].description.replace(/\s+/g, " ");

  // Reading and acting: the ref protocol is unusable if any of these literals
  // is paraphrased away.
  for (const literal of [
    "Plan then batch",
    "Never add sleeps",
    "snapshot({interactive: true})",
    "page.locator('aria-ref=eN')",
    "snapshot({diff: true})",
    "screenshot({kind: 'proof'})",
  ]) {
    assert.ok(text("browser").includes(literal), `browser lost ${literal}`);
  }
  assert.match(text("browser"), /article\/reference pages read a scoped DOM region directly/);
  assert.match(text("browser"), /inside the final verifying call/);
  assert.match(text("browser"), /Host cleanup is automatic/);
  assert.match(text("browser"), /closePage\(idOrIndex\?\)/);
  assert.match(text("browser"), /page\.on\('console'\|'pageerror', fn\)/);
  assert.match(text("browser"), /Restricted wrappers omit page\.route\/context\.route/);
  assert.match(text("browser"), /worker policy routing stays private/);
  assert.match(text("browser"), /addInitScript before goto/);
  assert.match(text("browser"), /setContent/);
  assert.match(text("browser"), /host fixture/);
  // Challenge limits are safety rules, not advice. Solving mechanics are
  // delivered just in time on the challenge report's advice field instead.
  assert.match(text("browser"), /three distinct challenge types/);
  assert.match(text("browser"), /Never duplicate a submission, purchase, or message/);
  assert.match(text("browser"), /webagents\.discover\(\)/);
  assert.match(text("browser"), /webagents\.batch\(\)/);
  assert.match(text("browser"), /allowWrites:true/);
  assert.match(text("browser"), /webmcp\.tools\(\)\/webmcp\.invoke\(\)/);
  assert.match(text("browser"), /autosubmit requires explicit opt-in/);
  assert.match(text("browser"), /use browser_batch/i);
  assert.match(text("browser"), /browser_batch \{url\}/i);
  assert.match(text("browser_batch"), /Default for ordinary forms/);
  assert.match(text("browser_batch"), /ordinary forms/);
  assert.match(text("browser_batch"), /role \(\+ name\), label, text/);
  assert.match(text("browser_batch"), /Mutating batches require allowWrites=true/);
  assert.match(text("browser_batch"), /Task-supplied passwords need allowPasswords=true/);
  assert.match(text("browser_batch"), /end in read\/readUrl with a non-empty expected value/);
  assert.deepEqual(byName.browser_batch.inputSchema.properties.operations.items.properties.action.enum, [
    "fill", "click", "select", "check", "uncheck", "press", "read", "readUrl",
  ]);

  // Downloads are gated to this tool; deny must stay discoverable.
  assert.match(text("browser_download"), /the browser tool cannot/);
  assert.match(text("browser_download"), /Autonomous by default/);
  assert.match(text("browser_download"), /BETTERWRIGHT_DOWNLOAD_POLICY=deny/);

  // The whole point of browser_login is that the secret stays out of the
  // transcript, and that a generated password is not saved until verified.
  assert.match(text("browser_login"), /never enters the conversation/);
  assert.match(text("browser_login"), /\[redacted\]/);
  assert.match(text("browser_login"), /credentials\.commitGenerated\(\{pendingId\}\)/);
  assert.match(text("browser_login"), /credentials\.discardGenerated\(\{pendingId\}\)/);
  assert.match(text("browser_login"), /Typing passwords in browser code is blocked/);

  // The live-view URL is a bearer capability, and agents have historically
  // claimed a view was running without ever starting one.
  assert.match(text("browser_handoff"), /VERBATIM/);
  assert.match(text("browser_handoff"), /never log or share it/);
  assert.match(text("browser_handoff"), /never claim a live view is running without this tool's URL/i);
  assert.match(text("browser_handoff"), /userChat/);

  // Selector fields went bare to save room; this one cannot be inferred from
  // its name, so it keeps its description.
  assert.match(
    byName.browser_login.inputSchema.properties.currentPasswordSelector.description,
    /rotation/,
  );
  // A viewer that can drive the browser is a different security posture than
  // one that can only watch.
  assert.match(byName.browser_handoff.inputSchema.properties.interactive.description, /control/);
});

test("policyFromEnv is open by default and hardens via BLOCK_* vars", () => {
  const open = policyFromEnv({});
  assert.equal(open.allowLoopback, true);
  assert.equal(open.allowPrivateNetwork, true);

  const hardened = policyFromEnv({
    BETTERWRIGHT_BLOCK_LOOPBACK: "1",
    BETTERWRIGHT_BLOCK_PRIVATE_NETWORK: "1",
    BETTERWRIGHT_ALLOW_HOSTS: "a.com, b.com,,",
    BETTERWRIGHT_BLOCK_HOSTS: "ads.com",
  });
  assert.equal(hardened.allowLoopback, false);
  assert.equal(hardened.allowPrivateNetwork, false);
  assert.deepEqual(hardened.allowHosts, ["a.com", "b.com"]);
  assert.deepEqual(hardened.blockHosts, ["ads.com"]);
});

test("downloadPolicyFromEnv defaults to ask and rejects junk", () => {
  assert.equal(downloadPolicyFromEnv({}), "ask");
  assert.equal(downloadPolicyFromEnv({ BETTERWRIGHT_DOWNLOAD_POLICY: "Allow" }), "allow");
  assert.throws(
    () => downloadPolicyFromEnv({ BETTERWRIGHT_DOWNLOAD_POLICY: "sometimes" }),
    /must be "ask", "allow", or "deny"/,
  );
});

test("headlessFromEnv defaults to auto and honors explicit values", () => {
  assert.equal(headlessFromEnv({}), "auto");
  assert.equal(headlessFromEnv({ BETTERWRIGHT_HEADLESS: "0" }), false);
  assert.equal(headlessFromEnv({ BETTERWRIGHT_HEADLESS: "true" }), true);
});

test("timeoutFromEnv defaults to 120 seconds and rejects junk", () => {
  assert.equal(timeoutFromEnv({}), 120);
  assert.equal(timeoutFromEnv({ BETTERWRIGHT_TIMEOUT_SECONDS: "180" }), 180);
  assert.throws(
    () => timeoutFromEnv({ BETTERWRIGHT_TIMEOUT_SECONDS: "4" }),
    /must be a number of seconds >= 5/,
  );
  assert.throws(
    () => timeoutFromEnv({ BETTERWRIGHT_TIMEOUT_SECONDS: "soon" }),
    /must be a number of seconds >= 5/,
  );
});

test("contentForResult separates screenshots from file paths", async () => {
  const shot = path.join(makeTempDir("bw-mcp-"), "proof.png");
  fs.writeFileSync(shot, Buffer.from("89504e470d0a1a0a", "hex"));
  const content = await contentForResult({
    ok: true,
    result: "Example Domain",
    console: ["hello"],
    artifacts: [
      { kind: "proof", path: shot, media: `MEDIA:${shot}` },
      { kind: "download", path: "/tmp/report.pdf" },
    ],
    pages: [{ url: "https://example.com" }],
    pendingCredential: {
      pendingId: "pending-1",
      origin: "https://example.com",
      matchMode: "host",
      username: "",
      label: null,
      secret: "generated-secret-that-must-not-leak",
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    challenges: [],
    warnings: [],
    durationMs: 12.3,
  });

  assert.equal(content[0].type, "text");
  const summary = JSON.parse(content[0].text);
  assert.deepEqual(Object.keys(summary), [
    "ok",
    "result",
    "pendingCredential",
    "console",
    "files",
    "pages",
    "duration_ms",
  ]);
  assert.equal(summary.ok, true);
  assert.equal(summary.duration_ms, 12.3);
  assert.equal(summary.pendingCredential.pendingId, "pending-1");
  assert.equal(Object.hasOwn(summary.pendingCredential, "secret"), false);
  assert.deepEqual(summary.files, [{ kind: "download", path: "/tmp/report.pdf" }]);
  assert.equal(content[1].type, "image");
  assert.equal(content[1].mimeType, "image/png");
});

test("contentForResult omits empty model-context fields", async () => {
  const [content] = await contentForResult({
    ok: true,
    result: "Example Domain",
    artifacts: [],
    durationMs: 7,
  });
  assert.equal(
    content.text,
    '{"ok":true,"result":"Example Domain","duration_ms":7}',
  );
});

test("contentForResult carries a discovered WebAgents directory", async () => {
  const [content] = await contentForResult({
    ok: true,
    result: "opened",
    webagents: { available: true, protocol: "webagents/0.1" },
  });
  assert.deepEqual(JSON.parse(content.text).webagents, {
    available: true,
    protocol: "webagents/0.1",
  });
});

test("contentForResult carries a synthesized compact UI directory", async () => {
  const [content] = await contentForResult({
    ok: true,
    result: "opened",
    ui: {
      protocol: "betterwright-ui/1",
      tool: "browser_batch",
      controls: [{ target: { role: "button", name: "Submit" }, actions: ["click", "read"] }],
    },
  });
  assert.equal(JSON.parse(content.text).ui.protocol, "betterwright-ui/1");
  assert.equal(JSON.parse(content.text).ui.tool, "browser_batch");
});

// The MCP layer renders action directories as one numbered text line per row;
// the worker's own result keeps the JSON object. Any row shape the renderer
// does not recognize fails safe: the whole directory stays JSON.
test("contentForResult renders action directories as numbered lines", async () => {
  const [content] = await contentForResult({
    ok: true,
    result: "opened",
    ui: {
      protocol: "betterwright-ui/1",
      tool: "browser_batch",
      controls: [
        {
          target: { role: "combobox", name: "Connection", exact: true },
          actions: ["select", "read"],
          value: "All",
          options: [["All", "All", true], ["USB-C", "USB-C", false], ["HDMI", "HDMI", false]],
        },
        {
          target: { label: "Maximum price ($)", exact: true },
          actions: ["fill", "read"],
          value: "500",
        },
        {
          target: { label: "In stock only", exact: true },
          actions: ["check", "read"],
          value: "on",
          checked: false,
        },
      ],
      truncated: false,
    },
  });
  assert.equal(
    JSON.parse(content.text).ui,
    [
      '1. combobox "Connection" value="All" options[All*|USB-C|HDMI] select,read',
      '2. label "Maximum price ($)" value="500" fill,read',
      '3. label "In stock only" unchecked check,read',
      '{"protocol":"betterwright-ui/1","tool":"browser_batch","truncated":false}',
    ].join("\n"),
  );
});

test("contentForResult renders option, state, disabled, and frame row parts in order", async () => {
  const [content] = await contentForResult({
    ok: true,
    result: "opened",
    ui: {
      controls: [
        {
          target: { role: "combobox", name: "Size", exact: true },
          actions: ["select", "read"],
          value: "10",
          options: [["Ten", "10", true], ["Twenty", "20", false]],
          disabled: true,
        },
        {
          target: { role: "checkbox", name: "Wrap", exact: true },
          actions: ["check", "read"],
          value: "yes",
          checked: true,
        },
        {
          target: { role: "button", name: "Pay", exact: true, frameUrlIncludes: "payments.example" },
          actions: ["click", "read"],
        },
      ],
    },
  });
  assert.equal(
    JSON.parse(content.text).ui,
    [
      '1. combobox "Size" value="10" options[10=Ten*|20=Twenty] disabled select,read',
      // A checkable row's value is the form-submission value; only state shows.
      '2. checkbox "Wrap" checked check,read',
      '3. button "Pay" f:"payments.example" click,read',
    ].join("\n"),
  );
});

test("contentForResult escapes quotes, newlines, and option delimiters", async () => {
  const [content] = await contentForResult({
    ok: true,
    result: "opened",
    ui: {
      controls: [
        {
          target: { role: "button", name: 'Say "hi"\nthen stop', exact: true },
          actions: ["click", "read"],
        },
        {
          target: { role: "combobox", name: "Pick", exact: true },
          actions: ["select", "read"],
          options: [["a|b", "a|b", false], ["star*", "star*", true], ["eq", "x=y", false]],
        },
      ],
    },
  });
  assert.equal(
    JSON.parse(content.text).ui,
    [
      '1. button "Say \\"hi\\"\\nthen stop" click,read',
      '2. combobox "Pick" options["a|b"|"star*"*|"x=y"=eq] select,read',
    ].join("\n"),
  );
});

test("contentForResult leaves non-conforming directories as JSON", async () => {
  const cases: [string, object][] = [
    ["empty controls", { protocol: "betterwright-ui/1", controls: [] }],
    ["unknown row field", {
      controls: [{ target: { role: "button", name: "Go", exact: true }, actions: ["click"], context: "nav" }],
    }],
    ["unknown target keyset", {
      controls: [{ target: { placeholder: "Search", exact: true }, actions: ["fill", "read"] }],
    }],
    ["non-exact target", {
      controls: [{ target: { role: "button", name: "Go", exact: false }, actions: ["click"] }],
    }],
    ["role-only target", {
      controls: [{ target: { role: "button", exact: true }, actions: ["click"] }],
    }],
    ["numbered target", {
      controls: [{ target: { role: "link", name: "Next", exact: true, nth: 1 }, actions: ["click", "read"] }],
    }],
    ["non-boolean checked", {
      controls: [{ target: { role: "checkbox", name: "Wrap", exact: true }, actions: ["check", "read"], checked: "yes" }],
    }],
  ];
  for (const [name, ui] of cases) {
    const [content] = await contentForResult({ ok: true, result: "opened", ui });
    assert.deepEqual(JSON.parse(content.text).ui, ui, name);
  }
});

test("contentForResult compacts a nested batch receipt's directory without mutating the worker result", async () => {
  const directory = {
    controls: [
      { target: { role: "textbox", name: "City", exact: true }, actions: ["fill", "read"], value: "Oslo" },
    ],
    truncated: true,
  };
  const receipt = { batch: { protocol: "ui-batch/1", pageUpdated: true }, ui: directory };
  const [content] = await contentForResult({ ok: true, result: receipt });
  const presented = JSON.parse(content.text).result;
  assert.equal(presented.ui, '1. textbox "City" value="Oslo" fill,read\n{"truncated":true}');
  assert.deepEqual(presented.batch, receipt.batch);
  // The worker's object keeps its identity and JSON shape.
  assert.equal(receipt.ui, directory);
  assert.deepEqual(directory.controls[0], {
    target: { role: "textbox", name: "City", exact: true },
    actions: ["fill", "read"],
    value: "Oslo",
  });
});

test("contentForResult compacts a directory returned directly as the result", async () => {
  const directory = {
    protocol: "betterwright-ui/1",
    tool: "browser_batch",
    controls: [
      { target: { label: "Search", exact: true }, actions: ["fill", "read"] },
    ],
    evidence: [],
    truncated: false,
  };
  const [content] = await contentForResult({ ok: true, result: directory });
  assert.equal(
    JSON.parse(content.text).result,
    '1. label "Search" fill,read\n{"protocol":"betterwright-ui/1","tool":"browser_batch","evidence":[],"truncated":false}',
  );
  assert.ok(Array.isArray(directory.controls));
});

test("MCP suppresses byte-identical pages and warnings on consecutive results", async () => {
  const makeResult = () => ({
    ok: true,
    pages: [{ url: "https://example.com", title: "Example" }],
    warnings: ["Software WebGL is deprecated"],
  });
  const results = [makeResult(), makeResult()];
  const handlers = _createMcpHandlersForTest({
    browser: { vault: false, async run() { return results.shift(); } },
    downloadPolicy: "deny",
  });
  const call = () =>
    handlers.callTool({
      params: { name: "browser", arguments: { code: "return 1", session: "main" } },
    });
  const first = JSON.parse((await call()).content[0].text);
  assert.deepEqual(first.pages, makeResult().pages);
  assert.deepEqual(first.warnings, makeResult().warnings);
  const second = JSON.parse((await call()).content[0].text);
  assert.equal(Object.hasOwn(second, "pages"), false);
  assert.equal(Object.hasOwn(second, "warnings"), false);
  assert.equal(second.pages_unchanged, true);
  assert.equal(second.warnings_unchanged, true);
});

test("MCP resumes full pages and warnings emission after a change", async () => {
  const results = [
    { ok: true, pages: [{ url: "https://a.example" }], warnings: ["one"] },
    { ok: true, pages: [{ url: "https://b.example" }], warnings: ["two"] },
    { ok: true, pages: [{ url: "https://b.example" }], warnings: ["two"] },
  ];
  const handlers = _createMcpHandlersForTest({
    browser: { vault: false, async run() { return results.shift(); } },
    downloadPolicy: "deny",
  });
  const call = () =>
    handlers.callTool({
      params: { name: "browser", arguments: { code: "return 1", session: "main" } },
    });
  await call();
  const changed = JSON.parse((await call()).content[0].text);
  assert.deepEqual(changed.pages, [{ url: "https://b.example" }]);
  assert.deepEqual(changed.warnings, ["two"]);
  assert.equal(Object.hasOwn(changed, "pages_unchanged"), false);
  assert.equal(Object.hasOwn(changed, "warnings_unchanged"), false);
  const settled = JSON.parse((await call()).content[0].text);
  assert.equal(settled.pages_unchanged, true);
  assert.equal(settled.warnings_unchanged, true);
});

test("MCP result compaction tracks sessions independently", async () => {
  const makeResult = () => ({
    ok: true,
    pages: [{ url: "https://example.com" }],
    warnings: ["one"],
  });
  const handlers = _createMcpHandlersForTest({
    browser: { vault: false, async run() { return makeResult(); } },
    downloadPolicy: "deny",
  });
  const call = (session) =>
    handlers.callTool({
      params: { name: "browser", arguments: { code: "return 1", session } },
    });
  const firstA = JSON.parse((await call("a")).content[0].text);
  const firstB = JSON.parse((await call("b")).content[0].text);
  assert.deepEqual(firstA.pages, makeResult().pages);
  assert.deepEqual(firstB.pages, makeResult().pages);
  assert.deepEqual(firstB.warnings, makeResult().warnings);
  const secondA = JSON.parse((await call("a")).content[0].text);
  const secondB = JSON.parse((await call("b")).content[0].text);
  assert.equal(secondA.pages_unchanged, true);
  assert.equal(secondB.pages_unchanged, true);
});

test("contentForResult without a tracker always emits full values", async () => {
  const makeResult = () => ({
    ok: true,
    pages: [{ url: "https://example.com" }],
    warnings: ["one"],
  });
  const [first] = await contentForResult(makeResult());
  const [second] = await contentForResult(makeResult());
  assert.equal(second.text, first.text);
  const summary = JSON.parse(second.text);
  assert.deepEqual(summary.pages, [{ url: "https://example.com" }]);
  assert.deepEqual(summary.warnings, ["one"]);
  assert.equal(Object.hasOwn(summary, "pages_unchanged"), false);
});

test("liveViewFromEnv defaults to LAN bind and disabled remote exposure", () => {
  assert.deepEqual(liveViewFromEnv({}, {}), {
    enabled: false,
    host: "0.0.0.0",
    port: 0,
    publicHost: undefined,
    expose: undefined,
    password: undefined,
    passwordHash: undefined,
  });
  assert.deepEqual(
    liveViewFromEnv(
      {
        BETTERWRIGHT_LIVE_VIEW: "1",
        BETTERWRIGHT_LIVE_VIEW_HOST: "0.0.0.0",
        BETTERWRIGHT_LIVE_VIEW_PORT: "8484",
        BETTERWRIGHT_LIVE_VIEW_PUBLIC_HOST: "192.168.0.2",
        BETTERWRIGHT_LIVE_VIEW_EXPOSE: "Tailscale",
        BETTERWRIGHT_LIVE_VIEW_PASSWORD: "s3cret",
      },
      {},
    ),
    {
      enabled: true,
      host: "0.0.0.0",
      port: 8484,
      publicHost: "192.168.0.2",
      expose: "tailscale",
      password: "s3cret",
      passwordHash: undefined,
    },
  );
  // config.json settings apply beneath the env: env wins where both are set.
  assert.deepEqual(
    liveViewFromEnv(
      { BETTERWRIGHT_LIVE_VIEW_EXPOSE: "lan" },
      { expose: "tailscale", passwordHash: `sha256:${"a".repeat(64)}`, port: 7100 },
    ),
    {
      enabled: false,
      host: "0.0.0.0",
      port: 7100,
      publicHost: undefined,
      expose: "lan",
      password: undefined,
      passwordHash: `sha256:${"a".repeat(64)}`,
    },
  );
});

interface HandoffBrowser {
  calls: {
    start: Array<{ host: string; port: number; interactive: boolean; session: string }>;
    stop: number;
    status: number;
  };
  vault: Record<string, never> | null;
  startLiveView(options: {
    host: string;
    port: number;
    interactive: boolean;
    session: string;
  }): Promise<{
    ok: boolean;
    url: string;
    host: string;
    port: number;
    token: string;
    interactive: boolean;
    running: boolean;
  }>;
  stopLiveView(): Promise<{ ok: boolean; running: boolean }>;
  liveViewStatus(): Promise<{
    ok: boolean;
    running: boolean;
    url: string;
    token: string;
    viewers: number;
    handoff: { active: boolean };
  }>;
  chatQueue?: Array<{ text: string; at: number }>;
  posted?: Array<{ text?: string; kind?: string }>;
  runs?: Array<{ code: string; options?: { session?: string } }>;
  liveViewDrainChat?: () => Promise<{ ok: boolean; messages: Array<{ text: string; at: number }> }>;
  liveViewPostChat?: (options: { text?: string; kind?: string }) => Promise<{ ok: boolean }>;
  run?: (code: string, options?: { session?: string }) => Promise<{ ok: boolean; result: string }>;
}

function handoffBrowser(): HandoffBrowser {
  const calls: HandoffBrowser["calls"] = { start: [], stop: 0, status: 0 };
  return {
    calls,
    vault: null,
    async startLiveView(options) {
      calls.start.push(options);
      return {
        ok: true,
        url: "http://127.0.0.1:4242/?t=secret",
        host: "127.0.0.1",
        port: 4242,
        token: "secret",
        interactive: true,
        running: true,
      };
    },
    async stopLiveView() {
      calls.stop += 1;
      return { ok: true, running: false };
    },
    async liveViewStatus() {
      calls.status += 1;
      return {
        ok: true,
        running: true,
        url: "http://127.0.0.1:4242/?t=secret",
        token: "secret",
        viewers: 1,
        handoff: { active: false },
      };
    },
  };
}

test("browser_handoff start returns the URL with relay instructions", async () => {
  const browser = handoffBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });
  const response = await handlers.callTool({
    params: { name: "browser_handoff", arguments: { reason: "solve the MFA" } },
  });
  assert.equal(response.isError, undefined);
  assert.match(response.content[0].text, /http:\/\/127\.0\.0\.1:4242\/\?t=secret/);
  assert.match(response.content[0].text, /solve the MFA/);
  assert.deepEqual(browser.calls.start, [
    { host: "127.0.0.1", port: 0, interactive: true, session: "default" },
  ]);
});

test("browser_handoff refuses a non-loopback host without the env opt-in", async () => {
  const browser = handoffBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "0.0.0.0", port: 0 },
  });
  const refused = await handlers.callTool({
    params: { name: "browser_handoff", arguments: {} },
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /BETTERWRIGHT_LIVE_VIEW=1/);
  assert.equal(browser.calls.start.length, 0);

  const allowed = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: true, host: "0.0.0.0", port: 0 },
  });
  const response = await allowed.callTool({
    params: { name: "browser_handoff", arguments: {} },
  });
  assert.equal(response.isError, undefined);
  assert.equal(browser.calls.start.length, 1);
});

test("browser_handoff status never echoes the token or URL back to the model", async () => {
  const browser = handoffBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });
  const response = await handlers.callTool({
    params: { name: "browser_handoff", arguments: { action: "status" } },
  });
  const status = JSON.parse(response.content[0].text);
  assert.equal(status.running, true);
  assert.equal(status.viewers, 1);
  assert.ok(!("token" in status));
  assert.ok(!("url" in status));

  const stop = await handlers.callTool({
    params: { name: "browser_handoff", arguments: { action: "stop" } },
  });
  assert.equal(JSON.parse(stop.content[0].text).running, false);
  assert.equal(browser.calls.stop, 1);
});

function chatBrowser() {
  const browser = handoffBrowser();
  browser.chatQueue = [];
  browser.posted = [];
  browser.runs = [];
  browser.liveViewDrainChat = async () => {
    const messages = browser.chatQueue.splice(0);
    return { ok: true, messages };
  };
  browser.liveViewPostChat = async (options) => {
    browser.posted.push(options);
    return { ok: true };
  };
  browser.run = async (code, options) => {
    browser.runs.push({ code, options });
    return { ok: true, result: "done" };
  };
  return browser;
}

test("viewer chat rides back on browser results while a live view runs", async () => {
  const browser = chatBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });

  // Before any live view starts, nothing is drained or posted.
  browser.chatQueue.push({ text: "too early", at: 1 });
  const quiet = await handlers.callTool({
    params: { name: "browser", arguments: { code: "1", note: "first step" } },
  });
  assert.equal(quiet.isError, undefined);
  assert.ok(!quiet.content.some((block) => /too early/.test(block.text || "")));
  assert.equal(browser.posted.length, 0);

  await handlers.callTool({ params: { name: "browser_handoff", arguments: {} } });
  browser.chatQueue.push({ text: "use the cheaper GPU", at: 2 });
  const response = await handlers.callTool({
    params: { name: "browser", arguments: { code: "2", note: "comparing GPUs" } },
  });
  assert.equal(response.isError, undefined);
  const chatBlock = response.content.find((block) =>
    /live-view chat/.test(block.text || ""),
  );
  assert.ok(chatBlock, "drained chat should be appended to the result");
  assert.match(chatBlock.text, /use the cheaper GPU/);
  assert.match(chatBlock.text, /fresh user instructions/);
  // The step note was mirrored into the viewer chat.
  assert.deepEqual(browser.posted, [
    { role: "agent", text: "comparing GPUs", kind: "step" },
  ]);
});

test("browser_handoff status carries drained viewer chat and stop ends mirroring", async () => {
  const browser = chatBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });
  await handlers.callTool({ params: { name: "browser_handoff", arguments: {} } });
  browser.chatQueue.push({ text: "done with MFA", at: 3 });
  const status = await handlers.callTool({
    params: { name: "browser_handoff", arguments: { action: "status" } },
  });
  const parsed = JSON.parse(status.content[0].text);
  assert.deepEqual(parsed.userChat, ["done with MFA"]);
  assert.ok(!("token" in parsed));

  await handlers.callTool({
    params: { name: "browser_handoff", arguments: { action: "stop" } },
  });
  browser.chatQueue.push({ text: "gone", at: 4 });
  const after = await handlers.callTool({
    params: { name: "browser", arguments: { code: "3", note: "next" } },
  });
  assert.ok(!after.content.some((block) => /gone/.test(block.text || "")));
  assert.equal(browser.posted.length, 0);
});

function downloadBrowser() {
  const runs = [];
  return {
    vault: null,
    runs,
    async run(code, options) {
      runs.push({ code, options });
      return { ok: true, result: "saved" };
    },
  };
}

async function callDownload(handlers, args = {}) {
  return handlers.callTool({
    params: { name: "browser_download", arguments: { code: "return 1", ...args } },
  });
}

test("browser_download ask-mode grants the run without elicitation", async () => {
  const browser = downloadBrowser();
  let elicited = 0;
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {
      async elicitInput() {
        elicited += 1;
        throw new Error("MCP downloads must not wait on elicitation");
      },
    },
    downloadPolicy: "ask",
  });

  const response = await callDownload(handlers, { note: "Save the report" });
  assert.equal(response.isError, undefined);
  assert.equal(JSON.parse(response.content[0].text).result, "saved");
  assert.equal(elicited, 0);
  assert.deepEqual(browser.runs, [
    { code: "return 1", options: { session: "default", note: "Save the report", approvedDownloads: true } },
  ]);
});

test("browser_download ignores model-supplied approval flags and still grants", async () => {
  const browser = downloadBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "ask",
  });

  const response = await callDownload(handlers, { approvedDownloads: true, approved: true });
  assert.equal(response.isError, undefined);
  assert.deepEqual(browser.runs[0].options, {
    session: "default",
    note: undefined,
    approvedDownloads: true,
  });
});

test("browser_download allow-mode grants the run", async () => {
  const browser = downloadBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "allow",
  });

  const response = await callDownload(handlers);
  assert.equal(response.isError, undefined);
  assert.equal(browser.runs[0].options.approvedDownloads, true);
});

test("browser_download deny-mode refuses before the run", async () => {
  const browser = downloadBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
  });

  const response = await callDownload(handlers);
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /BETTERWRIGHT_DOWNLOAD_POLICY=deny/);
  assert.equal(browser.runs.length, 0);
});

test("the browser tool never sets approvedDownloads", async () => {
  const browser = downloadBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "ask",
  });

  const response = await handlers.callTool({
    params: {
      name: "browser",
      arguments: { code: "return 1", approvedDownloads: true },
    },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(browser.runs[0].options, { session: "default", note: undefined });
});

async function loadMcpSdk() {
  const [{ Client }, { Server }, { InMemoryTransport }, types] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  return { Client, Server, InMemoryTransport, types };
}

async function connectDownloadServer({ downloadPolicy, clientCapabilities = {} }) {
  const sdk = await loadMcpSdk();
  const browser = downloadBrowser();
  const server = new sdk.Server(
    { name: "betterwright-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  const handlers = _createMcpHandlersForTest({ browser, server, downloadPolicy });
  server.setRequestHandler(sdk.types.ListToolsRequestSchema, handlers.listTools);
  server.setRequestHandler(sdk.types.CallToolRequestSchema, handlers.callTool);

  const client = new sdk.Client(
    { name: "test-host", version: "0.0.0" },
    { capabilities: clientCapabilities },
  );
  const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    browser,
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test("MCP protocol roundtrip: browser_download is autonomous without elicitation", async () => {
  const session = await connectDownloadServer({ downloadPolicy: "ask" });
  try {
    const result = await session.client.callTool({
      name: "browser_download",
      arguments: { code: "return 1", note: "Save the image" },
    });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.equal(JSON.parse(result.content[0].text).result, "saved");
    assert.equal(session.browser.runs[0].options.approvedDownloads, true);
    assert.equal(session.browser.runs[0].options.note, "Save the image");
  } finally {
    await session.close();
  }
});

test("MCP protocol roundtrip: deny still blocks browser_download", async () => {
  const session = await connectDownloadServer({ downloadPolicy: "deny" });
  try {
    const result = await session.client.callTool({
      name: "browser_download",
      arguments: { code: "return 1" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /BETTERWRIGHT_DOWNLOAD_POLICY=deny/);
    assert.equal(session.browser.runs.length, 0);
  } finally {
    await session.close();
  }
});
