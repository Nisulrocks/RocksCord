/**
 * Automatic updates for the Electron shell.
 *
 * Most of the app already updates itself: the window loads the web client from the server,
 * so UI and API changes arrive on the next launch. This covers the part that cannot — the
 * main process, the splash, the window behaviour, the installer — which is compiled into
 * the executable.
 *
 * **Updates are applied during startup, behind the splash.** The alternative, and what
 * this replaced, was a dialog interrupting the session and then the NSIS installer's own
 * progress window on restart: two pieces of Windows chrome for something the user did not
 * ask about and cannot meaningfully decide. Launch is the one moment an update costs
 * nothing — nothing is open, nothing is lost — so the check happens there, the download
 * reports into the splash the user is already looking at, and the install runs silently.
 *
 * Three conditions gate it, each failing quietly rather than nagging:
 *
 *  - **Packaged.** In development there is no feed, and electron-updater throws.
 *  - **Installed, not portable.** A portable build runs from a temporary extraction that
 *    is discarded on exit; there is nowhere to install into.
 *  - **A configured feed.** `app-update.yml` is written at build time only when a publish
 *    target exists, so a locally built exe never checks.
 */

import { app, BrowserWindow, dialog } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { log } from './log.js';

/**
 * How long to wait for the *check* before giving up and launching.
 *
 * Only the question "is there an update" is bounded. Once one is being downloaded the
 * wait is open-ended, because by then the splash is showing real progress and abandoning
 * it halfway would waste the bytes already fetched.
 */
const CHECK_TIMEOUT_MS = 8_000;

/** Re-checked on this interval, for sessions left running for days. */
const BACKGROUND_INTERVAL_MS = 6 * 60 * 60 * 1000;

let downloaded: UpdateInfo | null = null;

/**
 * A portable build extracts itself to a temporary directory on every run.
 * electron-builder sets this variable for that target specifically, which is the only
 * reliable way to tell the two apart from inside the app.
 */
function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

function updatable(): boolean {
  return app.isPackaged && !isPortable();
}

function configureUpdater(): void {
  autoUpdater.autoDownload = true;
  /*
   * A silent install is the whole point. `quitAndInstall(false, …)` shows the NSIS
   * installer's progress window -- the same setup wizard used for a first install -- which
   * is alarming for something that should look like the app simply restarting.
   */
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (message: unknown) => log.info(`auto-update: ${String(message)}`),
    warn: (message: unknown) => log.warn(`auto-update: ${String(message)}`),
    error: (message: unknown) => log.error(`auto-update: ${String(message)}`),
    debug: () => {},
  };
}

/** Silent install, then relaunch. The user sees the app restart, and nothing else. */
function installNow(): void {
  autoUpdater.quitAndInstall(true, true);
}

export interface StartupUpdateOptions {
  /** Reports into the splash the user is already watching. */
  onStatus: (text: string, percent?: number) => void;
}

/**
 * Check for, download, and apply an update before the main window opens.
 *
 * Resolves `true` when the app is about to quit and reinstall itself, in which case the
 * caller must stop what it is doing: the window should never be created, or it would
 * flash open moments before the process exits.
 */
export async function runStartupUpdate({ onStatus }: StartupUpdateOptions): Promise<boolean> {
  if (!updatable()) {
    log.info(
      `auto-update: skipped (${app.isPackaged ? 'portable build' : 'not packaged'})`,
    );
    return false;
  }

  configureUpdater();

  try {
    onStatus('Checking for updates…');

    /*
     * Race the check against a deadline. A slow or unreachable feed must not hold the app
     * shut -- an update is worth a few seconds at launch, never a hung startup.
     */
    const result = await Promise.race([
      autoUpdater.checkForUpdates(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CHECK_TIMEOUT_MS)),
    ]);

    if (!result?.updateInfo || result.updateInfo.version === app.getVersion()) {
      log.info('auto-update: already current');
      return false;
    }

    const version = result.updateInfo.version;

    // `autoDownload` means the fetch is already under way; this is the handle to it.
    if (!result.downloadPromise) {
      log.info(`auto-update: ${version} found but no download started`);
      return false;
    }

    log.info(`auto-update: downloading ${version}`);
    onStatus(`Downloading update — ${version}`);

    const onProgress = (progress: { percent: number }) => {
      const percent = Math.round(progress.percent);
      onStatus(`Downloading update — ${percent}%`, percent);
    };
    autoUpdater.on('download-progress', onProgress);

    try {
      await result.downloadPromise;
    } finally {
      autoUpdater.off('download-progress', onProgress);
    }

    log.info(`auto-update: installing ${version}`);
    onStatus('Installing update…');

    /*
     * A beat before quitting, so the final message actually paints. Without it the app
     * exits mid-frame and the splash appears to freeze on the download percentage.
     */
    await new Promise((resolve) => setTimeout(resolve, 400));

    installNow();
    return true;
  } catch (error) {
    /*
     * Never surfaced. A failed update is not something the user did or can fix, the app
     * works perfectly on the version it has, and the next launch will try again. The log
     * is for whoever ships the build.
     */
    log.error(`auto-update: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Keep checking while the app is open.
 *
 * Anything found here is downloaded quietly and left for `autoInstallOnAppQuit`, so a
 * session that has been running for days still picks up a release without ever being
 * interrupted by it.
 */
export function startBackgroundUpdateChecks(): void {
  if (!updatable()) return;

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    downloaded = info;
    log.info(`auto-update: ${info.version} ready, will install on quit`);
  });

  autoUpdater.on('error', (error: Error) => {
    log.error(`auto-update: ${error.message}`);
  });

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      log.error(
        `auto-update: background check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, BACKGROUND_INTERVAL_MS);
}

/**
 * A manual check, from the menu.
 *
 * Unlike the automatic paths this always answers, because the person asked. Silence in
 * response to a deliberate "check for updates" reads as broken.
 */
export async function checkForUpdatesInteractive(window: BrowserWindow | null): Promise<void> {
  const show = (options: Electron.MessageBoxOptions) =>
    window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);

  if (!updatable()) {
    await show({
      type: 'info',
      title: 'Updates',
      message: isPortable()
        ? 'This is the portable build, which cannot update itself.'
        : 'Updates are only available in the installed app.',
      detail: isPortable()
        ? 'Install RocksCord to get automatic updates, or replace the file by hand.'
        : 'This is a development build.',
      buttons: ['OK'],
    });
    return;
  }

  if (downloaded) {
    const result = await show({
      type: 'info',
      title: 'Update ready',
      message: `RocksCord ${downloaded.version} is ready.`,
      detail: 'It installs automatically when you quit, or you can restart now.',
      buttons: ['Restart now', 'Later'],
      defaultId: 1,
      cancelId: 1,
    });
    if (result.response === 0) installNow();
    return;
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    const available = result?.updateInfo && result.updateInfo.version !== app.getVersion();

    await show({
      type: 'info',
      title: 'Updates',
      message: available
        ? `RocksCord ${result!.updateInfo.version} is downloading.`
        : `RocksCord ${app.getVersion()} is up to date.`,
      detail: available ? 'It will install the next time you quit.' : '',
      buttons: ['OK'],
    });
  } catch (error) {
    log.error(`auto-update: manual check failed: ${error instanceof Error ? error.message : error}`);
    await show({
      type: 'warning',
      title: 'Could not check for updates',
      message: 'The update service could not be reached.',
      detail: 'Check your connection and try again later.',
      buttons: ['OK'],
    });
  }
}
