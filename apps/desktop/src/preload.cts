/**
 * Preload bridge.
 *
 * Deliberately tiny. The renderer is the same web app that runs in a browser, so it must
 * keep working with no Electron API at all -- everything here is an optional enhancement,
 * exposed through `contextBridge` so the page never touches Node directly.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('rockscord', {
  /** True when running inside the desktop app. The web build leaves this undefined. */
  isDesktop: true,

  /** Version, mode, data directory, and the last server used. */
  getInfo: (): Promise<{
    version: string;
    mode: string;
    remoteUrl: string;
    dataDir: string;
    platform: string;
  }> => ipcRenderer.invoke('rockscord:info'),

  /**
   * Check whether a server is reachable before committing to it.
   *
   * The probe runs in the main process rather than here: the connect page has a strict
   * CSP with no `connect-src`, and doing it main-side means one place understands what a
   * healthy RocksCord server looks like.
   */
  testServer: (
    url: string,
  ): Promise<{ ok: boolean; message: string; version?: string; database?: string }> =>
    ipcRenderer.invoke('rockscord:test-server', url),

  /** Switch to a shared server and reload into it. */
  useServer: (url: string): Promise<void> => ipcRenderer.invoke('rockscord:use-server', url),

  /** Switch to the built-in single-machine server and reload into it. */
  useLocal: (): Promise<void> => ipcRenderer.invoke('rockscord:use-local'),

  /**
   * Open another window with an isolated cookie jar, so a second account can be signed
   * in side by side. This is the multi-user testing affordance.
   */
  openSecondWindow: (): Promise<void> => ipcRenderer.invoke('rockscord:open-second-window'),

  /**
   * Route a `rockscord://` deep link, currently only invites.
   *
   * The main process resolves the link to an in-app path and sends it here; the page
   * navigates with its own router so the session and open state survive, which a full
   * `loadURL` would throw away.
   *
   * Returns an unsubscribe function. Without one the renderer would accumulate a listener
   * on every mount, and a single invite would fire navigation several times.
   */
  onNavigate: (handler: (path: string) => void): (() => void) => {
    const listener = (_event: unknown, path: unknown) => {
      if (typeof path === 'string') handler(path);
    };
    ipcRenderer.on('rockscord:navigate', listener);
    return () => {
      ipcRenderer.removeListener('rockscord:navigate', listener);
    };
  },
});
