import type { BrowserContext, Page } from "playwright-core";
import type { VaultMatchMode } from "./vault.js";
import type { UntrustedValue } from "./untrusted-value.js";

export interface CaptureOptions {
  vaultCallAtOrigin(session: CaptureSession, origin: string, action: string, payload: Record<string, UntrustedValue>): Promise<{ credentials?: Array<{ username: string }> }>;
  sessionForPage(page: Page): CaptureSession;
  trackSecret(value: string): void;
  isHeaded(): boolean;
  lastModelActivity(page: Page, origin: string): number;
  matchMode?: VaultMatchMode;
  /** Trusted host callback only. Captured passwords must never enter agent context. */
  shouldCapture?(capture: { page: Page; origin: string; username: string; password: string }): boolean | Promise<boolean>;
  /** Host-native save UI receives metadata, never a password. */
  requestSave?(request: { page: Page; origin: string; username: string; mode: "save" | "update" }): Promise<"save" | "dismiss" | "never">;
  onReady?(): void;
  onError?(error: Error): void;
  prefsPath?: string;
  gateMs?: number;
  confirmMs?: number;
  promptTtlMs?: number;
  modelWindowMs?: number;
}

export interface CaptureSession { id: string }
export function httpOrigin(url: UntrustedValue): string;
/** One capture owner per context. Await disposal before attaching a replacement. */
export function installVaultCapture(context: BrowserContext, options: CaptureOptions): {
  dispose(): Promise<void>;
  isBusy(page: Page): boolean;
};
