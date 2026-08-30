/**
 * The optional Electron bridge.
 *
 * The same bundle runs in a browser and inside the desktop app, so everything here is an
 * enhancement rather than a dependency: in a browser `window.rockscord` is simply absent,
 * and every accessor answers with a null the caller is expected to handle.
 *
 * Typed here rather than as a global `declare`, so that reaching for a desktop-only
 * capability has to go through a function that can return nothing — which is the shape of
 * the actual problem.
 */

export interface DesktopInfo {
  /** The Electron shell's version, which is what the updater compares. */
  version: string;
  /** `remote` when pointed at a shared server, `local` when running its own. */
  mode: string;
  remoteUrl: string;
  dataDir: string;
  platform: string;
}

interface DesktopBridge {
  isDesktop: true;
  getInfo: () => Promise<DesktopInfo>;
  testServer: (
    url: string,
  ) => Promise<{ ok: boolean; message: string; version?: string; database?: string }>;
  useServer: (url: string) => Promise<void>;
  useLocal: () => Promise<void>;
  openSecondWindow: () => Promise<void>;
  onNavigate?: (handler: (path: string) => void) => () => void;
}

function bridge(): DesktopBridge | null {
  const candidate = (window as { rockscord?: DesktopBridge }).rockscord;
  return candidate?.isDesktop ? candidate : null;
}

/** True only inside the packaged desktop app. */
export function isDesktop(): boolean {
  return bridge() !== null;
}

/** Shell version, mode, and data directory. Null in a browser. */
export async function desktopInfo(): Promise<DesktopInfo | null> {
  const api = bridge();
  if (!api) return null;
  try {
    return await api.getInfo();
  } catch {
    // An older shell without this handler; treat it as a browser rather than failing.
    return null;
  }
}

/**
 * Subscribe to deep links opened while the app is running.
 *
 * Returns an unsubscribe function, and a no-op one in a browser -- so callers can wire
 * this into an effect without branching on whether they are in the desktop app.
 *
 * `onNavigate` is optional because the shell updates independently of the web client: a
 * copy installed before deep links existed has no such method, and asking for one would
 * throw on every launch of an older build.
 */
export function onDesktopNavigate(handler: (path: string) => void): () => void {
  const api = bridge();
  if (!api?.onNavigate) return () => {};
  try {
    return api.onNavigate(handler);
  } catch {
    return () => {};
  }
}
