import type { WebContents } from "electron";
import type { HostTarget } from "./host.js";

export type ExpectedInput =
  | { kind: "key"; key: string; alt: boolean; control: boolean; meta: boolean; shift: boolean }
  | { kind: "mouse"; type: "mouseDown" | "mouseWheel" | "contextMenu"; x: number; y: number; button?: "left" | "middle" | "right" };

export interface ElectronHostOptions {
  /** A page in a dedicated session. Do not share this session with unrelated windows. */
  contents: WebContents;
  /** Exact absolute files approved and staged by the trusted host. */
  uploadFiles?: readonly string[];
  /** Register expected native input, then unregister it after dispatch. */
  expectAgentInput?: (input: ExpectedInput) => (() => void) | undefined;
  /** A trusted host's takeover signal. Aborts automation without retrying. */
  signal?: AbortSignal;
}

/** Call before app.ready. Disables transports that bypass the mandatory proxy. */
export function configureElectronNetwork(): void;
/** Only the leased target is visible. Closing BetterWright disconnects, never closes the page.
 * The dedicated session stays fail-closed after disconnect until the next connection.
 */
export function createElectronHostTarget(options: ElectronHostOptions): HostTarget;
