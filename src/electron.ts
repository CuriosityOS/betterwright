import path from "node:path";
import { app, webContents } from "electron";
import type { ElectronHostOptions } from "../types/electron.js";
import type { HostTarget } from "../types/host.js";
import { openBetterwrightConnection } from "./electron-connection.js";
import { isString } from "./untrusted-value.js";

export function configureElectronNetwork(): void {
  if (app.isReady()) throw new Error("Configure the browser network before app.ready.");
  app.commandLine.appendSwitch("disable-quic");
  app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
}

const leasedSessions = new WeakSet<object>();

export function createElectronHostTarget(options: ElectronHostOptions): HostTarget {
  const { contents, signal, expectAgentInput } = options;
  const uploadFiles = [...(options.uploadFiles ?? [])];
  if (uploadFiles.some(file => !isString(file) || !path.isAbsolute(file))) {
    throw new Error("Approved upload files must be absolute paths.");
  }
  return {
    async connect({ proxyUrl }) {
      if (signal?.aborted) throw new Error("Browser control was interrupted.");
      if (!/^socks5:\/\/127\.0\.0\.1:\d+$/.test(proxyUrl)) throw new Error("Invalid guard proxy.");
      if (!app.commandLine.hasSwitch("disable-quic") ||
          app.commandLine.getSwitchValue("force-webrtc-ip-handling-policy") !== "disable_non_proxied_udp") {
        throw new Error("Call configureElectronNetwork before app.ready.");
      }
      if (contents.isDestroyed() || !contents.getURL() || leasedSessions.has(contents.session) ||
          webContents.getAllWebContents().some(other => other !== contents && !other.isDestroyed() && other.session === contents.session)) {
        throw new Error("A dedicated, unleased browser session is required.");
      }
      const session = contents.session;
      leasedSessions.add(session);
      const denyDownload = (event: Electron.Event) => event.preventDefault();
      session.on("will-download", denyDownload);
      try {
        await session.setProxy({ proxyRules: proxyUrl, proxyBypassRules: "<-loopback>" });
        await session.closeAllConnections();
        const connection = await openBetterwrightConnection(contents, undefined, uploadFiles, false, expectAgentInput);
        let closing: Promise<void> | undefined;
        return {
          provider: connection.provider,
          close() {
            closing ??= connection.close().finally(() => {
              session.removeListener("will-download", denyDownload);
              leasedSessions.delete(session);
            });
            return closing;
          },
        };
      } catch (error) {
        session.removeListener("will-download", denyDownload);
        leasedSessions.delete(session);
        throw error;
      }
    },
    async run(operation) {
      if (contents.isDestroyed()) throw new Error("Browser target is unavailable.");
      const throttled = contents.getBackgroundThrottling();
      contents.setBackgroundThrottling(false);
      try { return await operation(signal); }
      finally { if (!contents.isDestroyed()) contents.setBackgroundThrottling(throttled); }
    },
  };
}
