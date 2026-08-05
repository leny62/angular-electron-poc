/**
 * Minimal .env loader.
 *
 * Deliberately not `dotenv`: this is 30 lines, it runs only in a dev script, and
 * it keeps the dependency surface of the repo unchanged.
 *
 * Reads `.env.local` from the repo root if present, without overwriting anything
 * already set in the real environment (so `BIZURI_API=... npm run smoke:live`
 * still wins over the file).
 *
 * `.env.local` is gitignored. Credentials belong on the developer's machine, not
 * in the repository and not in a terminal transcript.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface LoadedEnv {
  readonly path: string | null;
  readonly keys: readonly string[];
}

export function loadEnvLocal(rootDir = join(__dirname, '..')): LoadedEnv {
  const path = join(rootDir, '.env.local');
  if (!existsSync(path)) return { path: null, keys: [] };

  const keys: string[] = [];

  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip one layer of matching quotes, so a password containing `#` or spaces
    // can be quoted in the file without the quotes becoming part of the secret.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    // Real environment wins, so a one-off override on the command line works.
    if (process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }

  return { path, keys };
}

/**
 * Mask a secret for display.
 *
 * Shows enough to confirm the right value is loaded (a typo'd slug is the most
 * likely failure) without putting the secret in the terminal, where it would end
 * up in scrollback, a screenshot, or a pasted transcript.
 */
export function mask(value: string | undefined): string {
  if (!value) return '(not set)';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}
