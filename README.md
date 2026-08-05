# Bizuri PoC — Offline-First POS on Electron

Angular 18 + Electron 41 proof of concept: take Bizuri's point of sale offline with a local SQLCipher database, secure IPC, and background sync. The app runs entirely on the local machine and syncs when a connection is available.

## Quick Start

```bash
git clone <repo-url> && cd angular-electron-poc
npm install
npm run rebuild:electron
npm run electron:dev
```

You need Node 18+ and an npm that understands workspaces (8+).

## Prerequisites

The native SQLite module (`better-sqlite3-multiple-ciphers`) comes with prebuilt binaries, but Electron bundles its own Node. You have to rebuild for the right target:

| When | Command |
|---|---|
| Running tests (Jest on system Node) | `npm run rebuild:node` |
| Running the Electron app | `npm run rebuild:electron` |

Skip the rebuild if the prebuilt binary matches your platform and Electron version, but if you hit a `MODULE_NOT_FOUND` or ABI mismatch, run the right one.

## Commands

**Development**

| Command | What it does |
|---|---|
| `npm run electron:dev` | Rebuild native module, compile Electron TS, start Angular dev server, then launch Electron |
| `npm run dev:offline` | Same as above but also starts a mock API server on port 4300 |
| `npm run mock:api` | Start just the mock API (useful for testing the sync layer against a fake backend) |

**Build**

| Command | What it does |
|---|---|
| `npm run build:all` | Build Angular app, workspace packages, and Electron main process |
| `npm run build:electron:dev` | Compile the Electron main process only (skip Angular build, for fast iteration) |
| `npm run electron:prod` | Full production build then launch Electron |
| `npm run electron:package` | Full build then package into a .dmg / .nsis / .AppImage via electron-builder |

**Testing**

| Command | What it does |
|---|---|
| `npm run test:packages` | Run Jest tests across all workspace packages |
| `npm run test:packages:coverage` | Same with coverage report |
| `npm run test:all` | Alias for `test:packages` |
| `npm run conformance` | Run the contract conformance suite against the mock API |
| `npm run e2e:offline` | Full offline loop: seed local DB, create a sale, push outbox entries |
| `npm run smoke:mock` | Point the smoke suite at the local mock server |
| `npm run smoke:live` | Run the smoke suite against the live Bizuri API (needs `BIZURI_API`, `BIZURI_EMAIL`, `BIZURI_PASSWORD`, `BIZURI_SLUG` in the environment) |
| `npm run smoke:dry` | Dry-run mode: validate contracts without hitting the API |

## Architecture

One IPC channel. The renderer sends commands through `contextBridge`, the main process runs them through a six-gate validation pipeline, then routes to a handler. Results come back the same channel. Push events use a separate `bizuri.event` channel.

**The six gates** (in order, cheapest first):

1. **Sender verification** — did this message come from a frame we own?
2. **Allow-list** — is this command in the frozen registry?
3. **Envelope** — does the message have the required shape?
4. **JSON Schema** — does the payload match the command's schema (Draft-07 subset)?
5. **Session** — is the engine unlocked?
6. **Rate limiting** — has this command been called too many times recently?

Gates short-circuit. Rate limiting is last because you shouldn't count invalid calls.

**State machine:** LOCKED → READY → DEGRADED → FATAL → DRAINING. The window opens even on FATAL (silent crashes on double-click are a support nightmare).

**Offline loop:** every write creates an outbox row with an idempotency key. A sync worker wakes every 30 seconds, leases pending rows, pushes them to the server. The pull worker uses a cursor and checks for pending outbox entries before upserting remote rows to avoid conflicts.

**Security:** passphrase → PBKDF2-HMAC-SHA256 (600k iterations, machine-bound salt) → raw key passed to SQLCipher via `PRAGMA key = "x'..."`. The derived key is verified with `timingSafeEqual` on unlock so an attacker can't tell how close their guess was.

## Project Layout

```
electron/           Electron main process (CJS, Node)
  ipc/              Gateway and command handlers
  domain/           Pure logic, no Electron dependency
  security/         Key derivation, credential store, sender verification
  sync/             Background sync worker, outbox push, cursor pull
  database/         SQLCipher connection, migrations, types
  shared/           Canonical types and contracts

packages/           Workspace packages (ESM, shared between renderer and Electron)
  local-store/      SQLite abstraction layer
  local-engine/     Domain logic for offline operations
  offline-http/     HTTP fallback transport

src/app/            Angular renderer
  core/             Bridge service, transport router, HTTP fallback
  features/         Unlock screen, POS shell (catalog, cart, sales, sync tabs)

scripts/            Build, test, and verification tooling
  mock-api.ts       Lightweight Express server that mirrors the Bizuri API
  e2e-offline.ts    End-to-end offline sale loop
  conformance.ts    Contract conformance suite
  smoke-live.ts     Live API smoke tests
```

## Design Tokens

Defined in `src/styles.css`. Teal + warm beige + indigo focus rings. Font is Outfit. Cards are white with an 8px radius and subtle shadows.
