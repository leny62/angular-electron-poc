/**
 * Command registry.
 *
 * A frozen map of command-name → handler that is built once at startup,
 * before the BrowserWindow is created.  Nothing can register a handler
 * after initialisation, and nothing can enumerate the registry from the
 * renderer.
 *
 * SOLID notes
 * -----------
 * Open/Closed — new commands are added by writing a handler and
 * registering it here; the gateway never changes.
 */

import type { CommandDefinition } from '../shared/contracts';

/**
 * The shared contracts live in the Angular source tree so both the
 * renderer and the main process compile against the same types.
 * At build time we copy or reference; for the PoC the main process
 * imports directly from the compiled shared source.
 *
 * Because Electron's main process runs under Node with CommonJS and
 * the Angular app runs under the browser with ESM, we keep a local
 * copy of the literal types in a sidecar file so the main process
 * does not need to resolve Angular paths.
 */
import { COMMAND_NAMES, ERROR_CODES } from '../shared/contracts';
import type {
  CommandName,
  CommandHandler,
  CommandDefinition as CmdDef,
} from '../shared/contracts';

export type { CommandName, CommandHandler, CmdDef };

/**
 * Immutable command catalogue.
 * Initialised once via `initialiseRegistry()` before the window opens.
 */
let registry: ReadonlyMap<CommandName, CmdDef> | null = null;

/**
 * Build and freeze the command registry.
 * Must be called before `createWindow()`.
 */
export function initialiseRegistry(handlers: readonly CmdDef[]): ReadonlyMap<CommandName, CmdDef> {
  const map = new Map<CommandName, CmdDef>();

  for (const def of handlers) {
    if (map.has(def.name)) {
      throw new Error(`Duplicate command handler: ${def.name}`);
    }
    map.set(def.name, Object.freeze({ ...def }));
  }

  registry = Object.freeze(map);
  return registry;
}

/**
 * Look up a command by name.  Returns `undefined` for unknown commands —
 * the validation pipeline treats that as E_UNKNOWN_COMMAND.
 */
export function findCommand(name: string): CmdDef | undefined {
  if (!registry) {
    throw new Error('Command registry not initialised — call initialiseRegistry() first.');
  }
  return (registry as ReadonlyMap<string, CmdDef>).get(name);
}

/**
 * True once the registry has been initialised.
 */
export function isRegistryInitialised(): boolean {
  return registry !== null;
}

/**
 * Return the set of known command names (for diagnostics, never exposed
 * to the renderer).
 */
export function registeredCommandNames(): readonly CommandName[] {
  if (!registry) return [];
  return Array.from(registry.keys());
}

/**
 * Re-export the command and error catalogues so validation code does
 * not need to reach into shared/contracts.
 */
export { COMMAND_NAMES, ERROR_CODES };
