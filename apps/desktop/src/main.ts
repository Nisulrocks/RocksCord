/**
 * Electron main process.
 *
 * The desktop app is not a second implementation of anything: it boots the *same*
 * `buildApp()` factory the web server uses, in this process, and points a BrowserWindow at
 * it. That is the whole design. Double-click the exe and you have a working server and a
 * client, with no install, no configuration, and no internet connection required.
 *
 * Two modes:
 *   embedded (default)  runs the server in-process against a local database file
 *   remote              skips the server and connects to a deployed instance
 *
 * Mode is chosen by `config.json` in Electron's userData directory, or the `--server=URL`
 * command-line flag.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  session,
  shell,
} from 'electron';
import { getLogPath, installCrashHandlers, log, setLogFile, startLog } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Injected by esbuild at build time. See BAKED_SERVER_URL below. */
declare const __ROCKSCORD_BAKED_SERVER_URL__: string | undefined;

installCrashHandlers();
// Move the log next to the app's data as soon as that path is resolvable.
try {
  setLogFile(path.join(app.getPath('userData'), 'desktop.log'));
} catch {
  // Stay in the temp directory.
}
startLog({
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
  cwd: process.cwd(),
  portable: process.env.PORTABLE_EXECUTABLE_DIR ?? '(not portable)',
});

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

interface DesktopConfig {
  /** 'embedded' runs the server here; 'remote' connects to `remoteUrl`. */
  mode: 'embedded' | 'remote';
  remoteUrl: string;
  /**
   * Whether the person has actually picked a server yet.
   *
   * Distinguishes "defaulted to local" from "chose local", so the picker is shown once on
   * a fresh install and never nags afterwards.
   */
  chosen?: boolean;
  /** Port for the embedded server. 0 lets the OS choose a free one. */
  port: number;
  /**
   * Persisted signing key for the embedded server.
   *
   * Without persisting this, every launch would generate a new secret and silently sign
   * everyone out -- which looks exactly like a bug to the person using it.
   */
  jwtSecret: string;
  windowBounds?: { width: number; height: number; x?: number; y?: number };
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig(): DesktopConfig {
  const defaults: DesktopConfig = {
    mode: 'embedded',
    remoteUrl: '',
    port: 0,
    jwtSecret: randomBytes(48).toString('base64url'),
  };

  try {
    if (existsSync(configPath())) {
      const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<DesktopConfig>;
      return { ...defaults, ...parsed, jwtSecret: parsed.jwtSecret || defaults.jwtSecret };
    }
  } catch {
    // A corrupt config should not stop the app from starting.
  }

  return defaults;
}

function saveConfig(config: DesktopConfig): void {
  try {
    mkdirSync(path.dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    log.warn('could not save config:', error);
  }
}

/** `--server=https://example.com` overrides the stored mode for this launch. */
function remoteFromArgv(): string | null {
  const flag = process.argv.find((arg) => arg.startsWith('--server='));
  return flag ? flag.slice('--server='.length).replace(/\/+$/, '') : null;
}

/**
 * A server address baked in at build time.
 *
 * Set ROCKSCORD_SERVER_URL when running `npm run build:exe` and the resulting executable
 * points at that server out of the box -- so the copy you hand to a friend connects to
 * your server on first launch with nothing to configure.
 *
 * Replaced by esbuild's `define`; the literal below is the fallback when unset.
 */
const BAKED_SERVER_URL: string = (
  typeof __ROCKSCORD_BAKED_SERVER_URL__ === 'string' ? __ROCKSCORD_BAKED_SERVER_URL__ : ''
).replace(/\/+$/, '');

/* -------------------------------------------------------------------------- */
/* Embedded server                                                             */
/* -------------------------------------------------------------------------- */

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Start the API + realtime gateway in this process.
 *
 * Environment variables are set *before* the server module is imported, because its
 * config is read at import time. That is why this uses a dynamic `import()` rather than a
 * static one -- a static import would be hoisted above these assignments.
 */
async function startEmbeddedServer(config: DesktopConfig): Promise<RunningServer> {
  const dataDir = path.join(app.getPath('userData'), 'data');
  mkdirSync(dataDir, { recursive: true });

  process.env.NODE_ENV = 'production';
  process.env.HOST = '127.0.0.1';
  process.env.PORT = String(config.port);
  process.env.DATABASE_URL = `file:${path.join(dataDir, 'rockscord.db').replace(/\\/g, '/')}`;
  process.env.UPLOAD_DIR = path.join(dataDir, 'uploads');
  process.env.JWT_SECRET = config.jwtSecret;
  process.env.STORAGE_DRIVER = 'local';
  process.env.SERVE_CLIENT = 'true';
  process.env.LOG_LEVEL = 'warn';
  // Loopback only: the embedded server must not be reachable from the network unless
  // the user deliberately runs the standalone server instead.
  process.env.CORS_ORIGIN = '*';

  const { buildApp } = await import('@rockscord/server/app');

  const built = await buildApp();
  await built.app.listen({ port: config.port, host: '127.0.0.1' });

  const address = built.app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://127.0.0.1:${port}`;

  // PUBLIC_URL is used to build attachment URLs; it is only known after binding a port.
  process.env.PUBLIC_URL = url;

  /*
   * Publish the URL to a file next to the data directory.
   *
   * The embedded server binds an OS-assigned port, so there is otherwise no way to know
   * where it is. Writing it down lets you open the same server in a browser -- which is
   * how you sign in as a second and third user for testing without a second machine.
   */
  try {
    writeFileSync(path.join(app.getPath('userData'), 'server-url.txt'), `${url}
`, 'utf8');
  } catch (error) {
    log.warn('could not write server-url.txt:', error);
  }

  log.info(`embedded server listening on ${url}`);
  return { url, close: built.close };
}

/* -------------------------------------------------------------------------- */
/* Splash                                                                      */
/* -------------------------------------------------------------------------- */

let splashWindow: BrowserWindow | null = null;

/** How long to wait before admitting that a sleeping free-tier server is the hold-up. */
const COLD_START_HINT_MS = 8_000;
let coldStartTimer: NodeJS.Timeout | null = null;

/**
 * Show the startup window.
 *
 * The main window is created hidden and only revealed once it has painted, which on a
 * cold remote server can be the better part of a minute. Without something on screen for
 * that stretch, double-clicking the icon appears to do nothing at all and people click
 * again, so this is load-bearing rather than decorative.
 */
function openSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) return;

  splashWindow = new BrowserWindow({
    width: 420,
    height: 290,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    center: true,
    // Above the (still empty) main window, but not above every other app on the desktop.
    alwaysOnTop: true,
    // Kept in the taskbar deliberately: it is the only evidence the app is launching.
    skipTaskbar: false,
    title: 'RocksCord',
    icon: path.join(here, 'icon.png'),
    // No preload and no Node: the page is static, and status text arrives via
    // executeJavaScript from this process.
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  splashWindow.on('closed', () => {
    splashWindow = null;
  });

  void splashWindow.loadFile(path.join(here, 'splash.html'));
  log.info('splash shown');
}

/** Update the line of text under the progress bar. Safe to call at any time. */
function setSplashStatus(text: string, patient = false): void {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  // JSON.stringify does the escaping; every caller passes a literal anyway.
  const script = `window.__rockscordStatus && window.__rockscordStatus(${JSON.stringify(
    text,
  )}, ${JSON.stringify(patient)})`;
  splashWindow.webContents.executeJavaScript(script).catch(() => {
    // The window can be torn down mid-call; there is nothing useful to do about it.
  });
}

function closeSplash(): void {
  if (coldStartTimer) {
    clearTimeout(coldStartTimer);
    coldStartTimer = null;
  }
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    log.info('splash dismissed');
  }
  splashWindow = null;
}

/**
 * After a few seconds of nothing, say why.
 *
 * Render's free tier stops the service after 15 minutes idle and takes ~50 seconds to
 * wake. Naming that turns "this app is broken" into "this app is waiting", which is the
 * difference between someone waiting and someone force-quitting.
 */
function disarmColdStartHint(): void {
  if (coldStartTimer) {
    clearTimeout(coldStartTimer);
    coldStartTimer = null;
  }
}

function armColdStartHint(): void {
  if (coldStartTimer) clearTimeout(coldStartTimer);
  coldStartTimer = setTimeout(() => {
    setSplashStatus(
      'Still waking the server. The free tier sleeps when idle, so this first connection can take up to a minute.',
      true,
    );
  }, COLD_START_HINT_MS);
}

/* -------------------------------------------------------------------------- */
/* Waiting for a sleeping host                                                 */
/* -------------------------------------------------------------------------- */

/** Give up waiting and try to load anyway, so a real outage still reaches the error UI. */
const SERVER_WAKE_TIMEOUT_MS = 150_000;
const SERVER_POLL_INTERVAL_MS = 1_500;
/** Per-attempt cap. A sleeping host accepts the connection and then just sits there. */
const HEALTH_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Block until the server is genuinely serving RocksCord.
 *
 * This exists because "the page loaded" is not the same question as "the app is up". A
 * host whose service is asleep answers the very first request with its own branded
 * holding page -- HTTP 200, valid HTML, paints immediately -- which fires `ready-to-show`
 * and would otherwise dismiss the splash onto somebody else's loading screen.
 *
 * `/health` separates the two cleanly: RocksCord answers it with `{"status":"ok"}` as
 * JSON, and a holding page cannot, whatever status code it returns. Requesting it is also
 * what wakes the service, so the wait happens behind the splash rather than in front of
 * the user.
 */
async function waitForServerAwake(baseUrl: string): Promise<boolean> {
  const deadline = Date.now() + SERVER_WAKE_TIMEOUT_MS;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);

      const response = await fetch(`${baseUrl}/health`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      clearTimeout(timer);

      if (response.ok) {
        // Parsed rather than pattern-matched: an interstitial that happens to mention
        // "ok" in its markup must not read as a healthy server.
        const body = (await response.json().catch(() => null)) as { status?: string } | null;
        if (body?.status === 'ok') {
          log.info(`server healthy after ${attempts} attempt(s)`);
          return true;
        }
      }
    } catch {
      // Refused, timed out, or DNS still cold. Any of these just means "not yet".
    }

    await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
  }

  log.warn(`server never reported healthy after ${attempts} attempt(s)`);
  return false;
}

/* -------------------------------------------------------------------------- */
/* Window                                                                      */
/* -------------------------------------------------------------------------- */

let mainWindow: BrowserWindow | null = null;
let server: RunningServer | null = null;
let config = loadConfig();
/** True when this launch came from `--server=`, whose choice must not be persisted. */
let launchedWithServerOverride = false;

function createWindow(targetUrl: string): BrowserWindow {
  const bounds = config.windowBounds ?? { width: 1280, height: 820 };

  const window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 940,
    minHeight: 560,
    // Matches the app's darkest surface, so there is no white flash before first paint.
    backgroundColor: '#08090d',
    show: false,
    autoHideMenuBar: true,
    title: 'RocksCord',
    icon: path.join(here, 'icon.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      // The renderer is a normal web app; it must not have Node access.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: true,
    },
  });

  /*
   * Keep the window and taskbar saying "RocksCord".
   *
   * Chromium adopts whatever <title> the loaded page carries, so an interstitial served
   * by the host would rename the app in the taskbar. The client never sets a title of its
   * own, so there is nothing legitimate being suppressed here.
   */
  window.on('page-title-updated', (event) => event.preventDefault());

  // Avoid a flash of empty window while the SPA boots. The splash covers this gap, and
  // is only dismissed once there is something real to replace it with.
  window.once('ready-to-show', () => {
    closeSplash();
    window.show();
    window.focus();
  });

  window.on('close', () => {
    if (window.isDestroyed()) return;

    const { width, height, x, y } = window.getBounds();
    const windowBounds = { width, height, x, y };
    config = { ...config, windowBounds };

    /*
     * `--server=` is documented as winning for one launch only, and it has to actually
     * behave that way: saving the whole in-memory config here would quietly write the
     * override to disk, so a single test run against another address would become the
     * app's permanent server. Re-reading what is on disk keeps the flag ephemeral while
     * still remembering where the window was.
     */
    saveConfig(
      launchedWithServerOverride ? { ...loadConfig(), windowBounds } : config,
    );
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the real browser, never inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !url.startsWith(targetUrl)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(targetUrl)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void window.loadURL(targetUrl);

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, failedUrl) => {
    // -3 is ERR_ABORTED, which fires on ordinary client-side navigations.
    if (errorCode === -3) return;
    log.error(`failed to load ${failedUrl}: ${errorDescription}`);
    // Otherwise the always-on-top splash sits over the dialog asking what to do about it.
    closeSplash();
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'Could not connect',
      message: 'RocksCord could not reach its server.',
      detail:
        config.mode === 'remote'
          ? `Tried to connect to ${config.remoteUrl}.\n\n${errorDescription}`
          : `The built-in server did not respond.\n\n${errorDescription}`,
      buttons: ['Retry', 'Quit'],
    }).then((result) => {
      if (result.response === 0) {
        openSplash();
        setSplashStatus('Retrying…');
        armColdStartHint();
        // Same reasoning as the first load: reach the app, not an interstitial.
        void waitForServerAwake(targetUrl).then(() => {
          disarmColdStartHint();
          setSplashStatus('Loading RocksCord…');
          void window.loadURL(targetUrl);
        });
      } else {
        app.quit();
      }
    });
  });

  return window;
}

/* -------------------------------------------------------------------------- */
/* Server picker                                                               */
/* -------------------------------------------------------------------------- */

let connectWindow: BrowserWindow | null = null;

/**
 * Show the "choose a server" page.
 *
 * This is a plain local HTML file, not part of the React client -- it has to work before
 * any server is known, which is precisely when the client cannot load.
 */
function openConnectWindow(): void {
  if (connectWindow && !connectWindow.isDestroyed()) {
    connectWindow.focus();
    return;
  }

  connectWindow = new BrowserWindow({
    width: 560,
    height: 660,
    resizable: false,
    backgroundColor: '#14161f',
    autoHideMenuBar: true,
    title: 'RocksCord — Choose a server',
    icon: path.join(here, 'icon.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  connectWindow.on('closed', () => {
    connectWindow = null;
    // Closing the picker with nothing else open would leave a running app and no window.
    if (BrowserWindow.getAllWindows().length === 0) app.quit();
  });

  void connectWindow.loadFile(path.join(here, 'connect.html'));
}

/**
 * Apply a server choice and restart into it.
 *
 * Switching between embedded and remote changes whether a server is running in this
 * process, so the cleanest transition is to tear down and relaunch rather than try to
 * mutate a half-built app in place.
 */
async function applyServerChoice(next: Partial<DesktopConfig>): Promise<void> {
  config = { ...config, ...next, chosen: true };
  saveConfig(config);
  log.info(`server choice: mode=${config.mode} url=${config.remoteUrl || '(embedded)'}`);

  if (server) {
    try {
      await server.close();
    } catch {
      // Shutting down regardless.
    }
    server = null;
  }

  app.relaunch();
  app.exit(0);
}

/* -------------------------------------------------------------------------- */
/* Menu                                                                        */
/* -------------------------------------------------------------------------- */

function buildMenu(targetUrl: string): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open a second window (test another account)',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => openAdditionalWindow(targetUrl),
        },
        { type: 'separator' },
        {
          label: 'Connect to a different server…',
          click: () => openConnectWindow(),
        },
        { type: 'separator' },
        {
          label: 'Open data folder',
          click: () => void shell.openPath(path.join(app.getPath('userData'), 'data')),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About RocksCord',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'About RocksCord',
              message: `RocksCord ${app.getVersion()}`,
              detail:
                `Mode: ${config.mode}\n` +
                `Server: ${targetUrl}\n` +
                `Data: ${path.join(app.getPath('userData'), 'data')}\n\n` +
                'Real-time chat, voice, and communities. Runs entirely on your machine.',
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * A second window in a *separate session partition*.
 *
 * This is what makes multi-account testing possible in one app: each partition has its
 * own cookie jar, so window A can be signed in as one user and window B as another. In a
 * single browser profile they would share the refresh cookie and fight over the session.
 */
let extraWindowCount = 0;

function openAdditionalWindow(targetUrl: string): void {
  extraWindowCount += 1;
  const partition = `persist:rockscord-user-${extraWindowCount}`;

  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    backgroundColor: '#08090d',
    autoHideMenuBar: true,
    title: `RocksCord — window ${extraWindowCount + 1}`,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      partition,
    },
  });

  void window.loadURL(targetUrl);
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

// One instance only: a second launch focuses the existing window instead of starting a
// second server on a second port against the same database file.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  log.info('waiting for Electron ready');

  app.whenReady().then(async () => {
    log.info('Electron ready');

    // Before any decisions are made, so the window appears within a few hundred
    // milliseconds of the icon being double-clicked.
    openSplash();
    /*
     * Deciding what to connect to, in priority order:
     *   1. --server=URL on the command line (wins for this launch only)
     *   2. a URL baked in at build time, on a fresh install
     *   3. whatever was chosen last and saved
     *   4. nothing chosen yet -> show the picker
     */
    const remoteOverride = remoteFromArgv();

    if (remoteOverride) {
      launchedWithServerOverride = true;
      config = { ...config, mode: 'remote', remoteUrl: remoteOverride, chosen: true };
    } else if (!config.chosen && BAKED_SERVER_URL) {
      log.info(`using the server baked in at build time: ${BAKED_SERVER_URL}`);
      config = { ...config, mode: 'remote', remoteUrl: BAKED_SERVER_URL, chosen: true };
      saveConfig(config);
    }

    // A fresh install with no baked server: ask once, rather than silently starting a
    // private server the person cannot share with anyone.
    if (!config.chosen && !remoteOverride) {
      log.info('no server chosen yet — showing the picker');
      closeSplash();
      openConnectWindow();
      return;
    }

    let targetUrl: string;

    try {
      if (config.mode === 'remote' && config.remoteUrl) {
        targetUrl = config.remoteUrl;
        log.info(`remote mode: ${targetUrl}`);
        // The host alone, not the full URL -- it is shorter and it is the part that
        // tells someone which server they are about to join.
        let host = targetUrl;
        try {
          host = new URL(targetUrl).host;
        } catch {
          // A malformed saved URL still fails informatively at load time.
        }
        setSplashStatus(`Connecting to ${host}…`);
        armColdStartHint();

        /*
         * Wait here, not in the window. Navigating first would paint the host's own
         * "service is waking up" page, which counts as the window being ready and pulls
         * the splash away to reveal it.
         */
        await waitForServerAwake(targetUrl);
        disarmColdStartHint();
      } else {
        log.info('starting embedded server');
        setSplashStatus('Starting the local server…');
        server = await startEmbeddedServer(config);
        targetUrl = server.url;
        // Persist the generated secret so the next launch keeps existing sessions valid.
        saveConfig(config);
      }
    } catch (error) {
      log.error('failed to start:', error);
      closeSplash();
      dialog.showErrorBox(
        'RocksCord could not start',
        `The built-in server failed to start.\n\n${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      app.quit();
      return;
    }

    /*
     * Grant microphone access automatically for our own origin.
     *
     * Electron denies media permissions by default and shows no prompt of its own, so
     * without this, joining a voice channel would silently fail. The check is scoped to
     * the app's own URL -- any other origin is still denied.
     */
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const url = webContents.getURL();
      const isOwnOrigin = url.startsWith(targetUrl);
      const allowed = ['media', 'display-capture', 'notifications', 'clipboard-sanitized-write'];
      callback(isOwnOrigin && allowed.includes(permission));
    });

    // Screen sharing picker: Electron needs an explicit handler for getDisplayMedia.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        // `useSystemPicker` shows the OS picker on Windows 10+; Electron falls back to
        // the first screen where that is unavailable.
        callback({ video: { id: 'screen:0:0', name: 'Entire screen' } as never });
      },
      { useSystemPicker: true },
    );

    log.info(`opening window at ${targetUrl}`);
    setSplashStatus('Loading RocksCord…');
    buildMenu(targetUrl);
    mainWindow = createWindow(targetUrl);
    log.info('window created');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow(targetUrl);
      }
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', async (event) => {
    if (!server) return;
    event.preventDefault();
    const closing = server;
    server = null;
    try {
      await closing.close();
    } catch {
      // Shutting down anyway.
    }
    app.quit();
  });
}

/* -------------------------------------------------------------------------- */
/* IPC                                                                         */
/* -------------------------------------------------------------------------- */

ipcMain.handle('rockscord:info', () => ({
  version: app.getVersion(),
  mode: config.mode,
  remoteUrl: config.remoteUrl,
  dataDir: path.join(app.getPath('userData'), 'data'),
  platform: process.platform,
}));

/**
 * Probe a candidate server.
 *
 * Runs here rather than in the page because the connect page has a strict CSP with no
 * network access at all, and because this is the one place that knows what a healthy
 * RocksCord server actually looks like.
 */
ipcMain.handle('rockscord:test-server', async (_event, rawUrl: string) => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, message: 'That does not look like a valid address.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'The address must start with http:// or https://' };
  }

  const healthUrl = `${url.origin}/health`;

  try {
    // Without a timeout an unreachable host hangs the button for a minute.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      return {
        ok: false,
        message: `The server answered with ${response.status}. Is that an RocksCord server?`,
      };
    }

    const body = (await response.json()) as {
      status?: string;
      version?: string;
      database?: string;
    };

    if (body.status !== 'ok') {
      return { ok: false, message: 'That server responded, but reported it is not healthy.' };
    }

    return {
      ok: true,
      message: 'Reachable.',
      version: body.version ?? 'unknown',
      database: body.database ?? 'unknown',
    };
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError';
    log.warn(`server probe failed for ${healthUrl}:`, error);
    return {
      ok: false,
      message: aborted
        ? 'No response within 8 seconds. Check the address and that the server is running.'
        : 'Could not reach that address. Check it is correct and the server is running.',
    };
  }
});

ipcMain.handle('rockscord:use-server', async (_event, url: string) => {
  await applyServerChoice({ mode: 'remote', remoteUrl: String(url).replace(/\/+$/, '') });
});

ipcMain.handle('rockscord:use-local', async () => {
  await applyServerChoice({ mode: 'embedded', remoteUrl: '' });
});

ipcMain.handle('rockscord:open-second-window', () => {
  if (mainWindow) openAdditionalWindow(mainWindow.webContents.getURL());
});
