/**
 * Automatic updates for the Electron shell.
 *
 * Most of the app already updates itself: the window loads the web client from the server,
 * so UI and API changes arrive on the next launch. This covers the part that cannot — the
 * main process, the splash, the window behaviour, the installer — which is baked into the
 * executable and otherwise needs a hand-delivered file.
 *
 * Three conditions have to hold before it does anything, and each of them fails silently
 * rather than nagging:
 *
 *  - **Packaged.** In development there is no update feed, and `electron-updater` throws
 *    rather than shrugging.
 *  - **Installed, not portable.** A portable build runs from a temporary extraction that
 *    is thrown away on exit; there is nothing to write an update into. Checking anyway
 *    would produce an error the user can do nothing about.
 *  - **A configured feed.** `app-update.yml` is written at build time only when a publish
 *    target exists, so a locally built exe simply never checks.
 *
 * The download is silent and the install waits: interrupting someone mid-conversation to
 * announce a patch release is worse than the patch is good. It applies on next quit
 * unless they choose to restart now.
 */

import { app, BrowserWindow, dialog, Notification } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { log } from './log.js';

/** Re-checked on this interval, so a long-running window still finds updates. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How long after launch to look, so the check never competes with startup. */
const FIRST_CHECK_DELAY_MS = 30_000;

let started = false;
let downloaded: UpdateInfo | null = null;
let promptOpen = false;

/**
 * A portable build extracts itself to a temporary directory on every run.
 *
 * electron-builder sets this variable for the portable target specifically, which is the
 * only reliable way to tell the two apart from inside the app.
 */
function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

export interface UpdaterOptions {
  /** Used to parent the restart dialog, so it cannot end up behind the app. */
  getWindow: () => BrowserWindow | null;
}

export function initAutoUpdate({ getWindow }: UpdaterOptions): void {
  if (started) return;

  if (!app.isPackaged) {
    log.info('auto-update: skipped (not packaged)');
    return;
  }
  if (isPortable()) {
    log.info('auto-update: skipped (portable build has nowhere to install to)');
    return;
  }

  started = true;

  /*
   * Download without asking, install without forcing. Asking permission to *download*
   * is a question people cannot answer usefully -- they do not know what is in it -- and
   * it means the update is not ready at the moment they would have accepted it.
   */
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (message: unknown) => log.info(`auto-update: ${String(message)}`),
    warn: (message: unknown) => log.warn(`auto-update: ${String(message)}`),
    error: (message: unknown) => log.error(`auto-update: ${String(message)}`),
    debug: () => {},
  };

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info(`auto-update: ${info.version} available, downloading`);
  });

  autoUpdater.on('update-not-available', () => {
    log.info('auto-update: already current');
  });

  autoUpdater.on('download-progress', (progress: { percent: number }) => {
    // Logged only at coarse steps; per-chunk logging would flood the file.
    if (Math.round(progress.percent) % 25 === 0) {
      log.info(`auto-update: ${Math.round(progress.percent)}%`);
    }
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    downloaded = info;
    log.info(`auto-update: ${info.version} ready, will install on quit`);
    void offerRestart(info);
  });

  autoUpdater.on('error', (error: Error) => {
    /*
     * Never surfaced to the user. An update failing is not something they did or can fix,
     * the app keeps working on the version it has, and the next check may well succeed --
     * a dialog here would be pure noise. The log is for whoever ships the build.
     */
    log.error(`auto-update: ${error.message}`);
  });

  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void check(), CHECK_INTERVAL_MS);

  async function offerRestart(info: UpdateInfo): Promise<void> {
    if (promptOpen) return;
    promptOpen = true;

    const window = getWindow();
    const options = {
      type: 'info' as const,
      title: 'Update ready',
      message: `RocksCord ${info.version} is ready to install.`,
      detail: 'It will be applied the next time you quit, or you can restart now.',
      buttons: ['Restart now', 'Later'],
      defaultId: 1, // "Later": never make Enter restart someone mid-sentence.
      cancelId: 1,
    };

    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);

    promptOpen = false;
    if (result.response === 0) {
      // `isSilent: false` shows the installer's own progress; `isForceRunAfter` reopens
      // the app afterwards so restarting actually feels like restarting.
      autoUpdater.quitAndInstall(false, true);
    } else if (Notification.isSupported()) {
      new Notification({
        title: 'Update scheduled',
        body: `RocksCord ${info.version} will install when you next close the app.`,
      }).show();
    }
  }
}

async function check(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    log.error(`auto-update: check failed: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * A manual check, from the menu.
 *
 * Unlike the background one this always answers, because the person asked. Silence in
 * response to a deliberate "check for updates" reads as broken.
 */
export async function checkForUpdatesInteractive(window: BrowserWindow | null): Promise<void> {
  const show = (options: Electron.MessageBoxOptions) =>
    window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);

  if (!app.isPackaged || isPortable()) {
    await show({
      type: 'info',
      title: 'Updates',
      message: isPortable()
        ? 'This is the portable build, which cannot update itself.'
        : 'Updates are only available in the installed app.',
      detail: isPortable()
        ? 'Download the installer to get automatic updates, or replace the file by hand.'
        : 'This is a development build.',
      buttons: ['OK'],
    });
    return;
  }

  if (downloaded) {
    const result = await show({
      type: 'info',
      title: 'Update ready',
      message: `RocksCord ${downloaded.version} is downloaded.`,
      detail: 'Restart to apply it.',
      buttons: ['Restart now', 'Later'],
      defaultId: 1,
      cancelId: 1,
    });
    if (result.response === 0) autoUpdater.quitAndInstall(false, true);
    return;
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    const available =
      result?.updateInfo && result.updateInfo.version !== app.getVersion();

    await show({
      type: 'info',
      title: 'Updates',
      message: available
        ? `RocksCord ${result!.updateInfo.version} is downloading.`
        : `RocksCord ${app.getVersion()} is up to date.`,
      detail: available ? 'You will be told when it is ready to install.' : '',
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
