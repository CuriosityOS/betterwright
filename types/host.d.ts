import type { RunResult } from "./common.js";

export interface HostConnection {
  /** A capability-authenticated CDP endpoint exposing exactly one tab. */
  provider: { cdpUrl: string; headers?: Record<string, string> };
  /** Revoke input authority, disconnect and drain pending commands. Never close the page. */
  close(): Promise<void>;
}

export interface HostTarget {
  /** Configure the dedicated session to use this SOCKS guard before exposing the tab. */
  connect(options: { proxyUrl: string }): Promise<HostConnection>;
  /** Optional host input/focus lease; abort its signal to hand control back to the human. */
  run?(operation: (signal?: AbortSignal) => Promise<RunResult>): Promise<RunResult>;
}
