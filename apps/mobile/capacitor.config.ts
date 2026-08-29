/// <reference types="@capacitor/cli" />
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android shell.
 *
 * This is the same arrangement as the Electron app, for the same reason: the window loads
 * the web client *from the server* rather than from assets baked into the package. A
 * `git push` therefore ships UI and API changes to phones on their next launch, and the
 * APK only needs rebuilding when something in this shell changes -- which, unlike a
 * desktop update the app can install itself, would otherwise mean asking people to
 * sideload a new file every time a button moved.
 *
 * Loading the remote origin directly also keeps authentication working without any
 * special handling. Sessions live in an httpOnly refresh cookie, so bundling the client
 * locally would put the page on `https://localhost` while the API stayed on the
 * deployment -- making every request cross-origin, and the cookie a third-party one that
 * modern WebViews decline to send.
 *
 * `npm run build:apk -- --server=https://…` overrides the target, mirroring the desktop
 * build's `--server=` flag.
 */

const DEFAULT_SERVER = 'https://rockscord.onrender.com';

const server = (process.env.ROCKSCORD_SERVER_URL ?? DEFAULT_SERVER).replace(/\/+$/, '');

const config: CapacitorConfig = {
  appId: 'com.rockscord.app',
  appName: 'RocksCord',

  /*
   * Required by the CLI even though the app loads from `server.url`, which takes
   * precedence over anything here. Pointing it at the real build rather than a stub keeps
   * the two honest: if the remote target is ever dropped, what ships is a working client
   * rather than an empty directory.
   */
  webDir: '../web/dist',

  server: {
    url: server,
    /*
     * The deployment is HTTPS, so cleartext stays off. Turning it on to talk to a laptop
     * over `http://192.168.x.x` is a deliberate local-testing change, not a default.
     */
    cleartext: false,
    androidScheme: 'https',
  },

  android: {
    /*
     * Media capture from a WebView is refused outright unless the page is a secure
     * context. It is, over HTTPS -- this makes that explicit rather than incidental, so
     * voice and camera fail loudly in review if the target is ever changed to plain HTTP.
     */
    allowMixedContent: false,
    /*
     * Keeps the WebView's own long-press text selection and callouts out of the way. The
     * app has its own context menus on messages, and two overlapping ones on a touch
     * screen is worse than either.
     */
    captureInput: true,
  },
};

export default config;
