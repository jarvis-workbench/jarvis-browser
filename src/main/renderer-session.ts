import { isIP } from "node:net";
import type { Session } from "electron";

/** Keep local dev UI requests out of system PAC/WPAD discovery (which can stall for 60s). */
export async function configureLocalRendererSession(
  targetSession: Pick<Session, "setProxy">,
  devServerUrl: string,
) {
  const url = new URL(devServerUrl);
  const host = url.hostname;
  const isLoopback = host === "localhost"
    || host === "[::1]"
    || (isIP(host) === 4 && host.startsWith("127."));

  if ((url.protocol === "http:" || url.protocol === "https:") && isLoopback) {
    // This is the BrowserWindow shell session, not any site's isolated browsing session.
    // Configure it before loadURL; bypass rules alone still wait for PAC initialization.
    await targetSession.setProxy({ mode: "direct" });
  }
}
