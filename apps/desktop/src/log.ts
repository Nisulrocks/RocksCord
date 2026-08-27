/**
 * Desktop file logging.
 *
 * A packaged GUI application has nowhere to print: `console.log` goes to a console that
 * does not exist, so a startup failure shows as "the window never opened" with no way to
 * find out why. Everything is therefore mirrored to a file in the OS temp directory from
 * the very first line of `main.ts`.
 *
 * Logging starts in the OS temp directory so the earliest lines are captured even if
 * resolving `userData` fails, and is then redirected next to the app's data directory,
 * where someone would actually go looking for it.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Where the log is written.
 *
 * Starts in the OS temp directory so the very first lines are captured even if resolving
 * `userData` fails, then `setLogFile()` moves it next to the app's data once that path is
 * known -- which is where someone would actually look for it.
 */
let logPath = path.join(tmpdir(), 'rockscord-desktop.log');

export function getLogPath(): string {
  return logPath;
}

/** Redirect logging to a new file, carrying over what has been written so far. */
export function setLogFile(nextPath: string): void {
  try {
    mkdirSync(path.dirname(nextPath), { recursive: true });
    let existing = '';
    try {
      existing = readFileSync(logPath, 'utf8');
    } catch {
      // Nothing written yet.
    }
    writeFileSync(nextPath, existing, 'utf8');
    logPath = nextPath;
  } catch {
    // Keep using the previous location.
  }
}

function write(level: string, parts: unknown[]): void {
  const line = parts
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part instanceof Error) return `${part.message}\n${part.stack ?? ''}`;
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(' ');

  const stamped = `[${new Date().toISOString()}] ${level} ${line}\n`;

  try {
    appendFileSync(logPath, stamped, 'utf8');
  } catch {
    // If even the temp directory is unwritable there is nowhere left to report to.
  }

  // Still useful when launched from a terminal.
  if (level === 'ERROR') console.error(stamped.trimEnd());
  else console.log(stamped.trimEnd());
}

export const log = {
  info: (...parts: unknown[]) => write('INFO ', parts),
  warn: (...parts: unknown[]) => write('WARN ', parts),
  error: (...parts: unknown[]) => write('ERROR', parts),
};

/** Truncate the log and record the environment. Called once, first thing in main. */
export function startLog(context: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, '', 'utf8');
  } catch {
    // Non-fatal.
  }
  log.info('=== RocksCord desktop starting ===');
  for (const [key, value] of Object.entries(context)) {
    log.info(`  ${key}: ${String(value)}`);
  }
}

/**
 * Catch anything that escapes, so a crash lands in the log rather than vanishing.
 * Without this, an async failure in the startup path kills the app silently.
 */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (error) => {
    log.error('uncaughtException:', error);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection:', reason);
  });
}
