/**
 * Ambient declarations for globals that only exist in some runtimes.
 */

declare namespace NodeJS {
  interface Process {
    /**
     * Set by Electron in a packaged app; absent in a plain Node process.
     * Used to locate bundled migrations and the built web client.
     */
    resourcesPath?: string;
  }
}
