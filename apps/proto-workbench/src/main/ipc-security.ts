import { pathToFileURL } from "node:url";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
export { validateChannelArguments as validateIpcArguments } from "../shared/ipc-channel-contracts.ts";

export interface RendererTarget {
  kind: "file" | "url";
  value: string;
  expectedUrl: string;
}

export function resolveRendererTarget(
  packaged: boolean,
  rendererEnvironmentUrl: string | undefined,
  rendererFile: string,
): RendererTarget {
  const fileUrl = pathToFileURL(rendererFile).href;
  if (packaged || !rendererEnvironmentUrl) {
    return { kind: "file", value: rendererFile, expectedUrl: fileUrl };
  }
  const url = new URL(rendererEnvironmentUrl);
  const loopbackHosts = new Set(["127.0.0.1", "[::1]"]);
  if (
    url.protocol !== "http:"
    || !loopbackHosts.has(url.hostname.toLowerCase())
    || !url.port
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error("ELECTRON_RENDERER_URL must be an exact HTTP loopback origin in development.");
  }
  return { kind: "url", value: url.href, expectedUrl: url.href };
}

export function assertPrivilegedIpcSender(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow | null,
  expectedRendererUrl: string | undefined,
): void {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || !event.senderFrame
    || event.senderFrame !== event.sender.mainFrame
    || !expectedRendererUrl
    || event.senderFrame.url !== expectedRendererUrl
  ) {
    throw new Error("Blocked privileged IPC from an untrusted renderer frame.");
  }
}
