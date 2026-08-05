/**
 * Bundles the Electron main and preload scripts.
 *
 * tsc alone is not enough. A sandboxed preload gets a restricted `require` that
 * resolves Electron built-ins and relative paths only, so `@bizuri/local-store`
 * fails at runtime with "module not found". The main process would work under
 * npm workspaces but ships node_modules whole and untree-shaken.
 *
 * Bundling fixes both and keeps `sandbox: true`, which is a boundary worth
 * defending: the preload is what page content reaches to talk to the money
 * database.
 */

import { build } from 'esbuild';
import { rmSync } from 'fs';

const dev = process.argv.includes('--dev');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // Provided by the Electron runtime, never bundled.
  external: ['electron'],
};

rmSync('dist/electron', { recursive: true, force: true });

await build({
  ...shared,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist/electron/main.js',
  minify: !dev,
  // Native binary. Must stay in node_modules and in asarUnpack.
  external: [...shared.external, 'better-sqlite3-multiple-ciphers'],
});

await build({
  ...shared,
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist/electron/preload.js',
  minify: !dev,
});
