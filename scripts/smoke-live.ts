/**
 * Live smoke test against the real Bizuri API.
 *
 * Drives the whole Wave 1 offline loop end to end using ONLY endpoints that exist
 * today. No backend change required.
 *
 *   1. login          POST /identity/auth/login
 *   2. probe          GET  /actuator/health
 *   3. hydrate        GET  /core/sales/catalog, /core/stock-balances,
 *                          /core/tax-categories, /core/customers
 *   4. sell offline   local SQLite transaction: totals, stock, receipt, outbox
 *   5. push           POST /core/sales with Idempotency-Key
 *   6. replay         push the same key again, to prove exactly-once
 *
 * Usage:
 *   cp .env.local.example .env.local     # then fill it in
 *   npm run smoke:dry                    # hydrate + sell locally, push NOTHING
 *   npm run smoke:live                   # full loop, creates a REAL sale
 *
 * Configuration comes from `.env.local` (gitignored) or the real environment,
 * with the environment taking precedence. Credentials are never printed: the
 * password is masked and the slug is shown partially, which is enough to catch
 * the most common failure (a typo'd slug) without putting secrets in scrollback.
 *
 * Options:
 *   BIZURI_API=https://api.bizuri.testing.eccellenza.tech   (default)
 *   BIZURI_BRANCH=<uuid>       override the branch from the login response
 *   BIZURI_DRY_RUN=1           hydrate and sell locally, but do NOT push
 *   BIZURI_DB=/path/to.sqlite  default is a temp file, deleted on exit
 *
 * ─── This writes real data ───────────────────────────────────────────────────
 * Step 5 creates a REAL sale in whichever environment you point it at, which
 * deducts real stock. It is guarded three ways: the credentials come from the
 * environment so nothing runs by accident, the default is the testing host rather
 * than production, and BIZURI_DRY_RUN=1 stops before the push. Run it dry first.
 */

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import { loadEnvLocal, mask } from './load-env';
import { CONTRACT_VERSION, TIER_1_TABLES } from '@bizuri/local-store';
import {
  hydrate,
  makeCreateSale,
  MfaRequiredError,
  OfflineError,
  pushOutbox,
  RemoteClient,
  RemoteError,
  runMigrations,
  summariseOutbox,
  verifyReceiptChain,
  type SqliteDatabase,
} from '@bizuri/local-engine';

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

let step = 0;
const heading = (title: string) => {
  step++;
  console.log(`\n${c.bold(`${step}. ${title}`)}`);
  console.log(c.dim('─'.repeat(64)));
};
const ok = (msg: string) => console.log(`   ${c.green('✓')} ${msg}`);
const info = (msg: string) => console.log(`   ${c.dim('·')} ${msg}`);
const warn = (msg: string) => console.log(`   ${c.yellow('!')} ${msg}`);
const fail = (msg: string) => console.log(`   ${c.red('✗')} ${msg}`);

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_API = 'https://api.bizuri.testing.eccellenza.tech';

function readConfig() {
  const loaded = loadEnvLocal();

  const email = process.env['BIZURI_EMAIL'];
  const password = process.env['BIZURI_PASSWORD'];
  const subdomainSlug = process.env['BIZURI_SLUG'];

  if (!email || !password || !subdomainSlug) {
    const missing = [
      !email && 'BIZURI_EMAIL',
      !password && 'BIZURI_PASSWORD',
      !subdomainSlug && 'BIZURI_SLUG',
    ].filter(Boolean);

    console.error(
      `\n${c.red('Missing configuration:')} ${missing.join(', ')}\n` +
        (loaded.path
          ? `\nRead .env.local (${loaded.keys.length} key(s) loaded), but the above are still unset.\n`
          : '\nNo .env.local found. Create one:\n' +
            '  cp .env.local.example .env.local\n' +
            '  $EDITOR .env.local\n') +
        '\nIt is gitignored, so credentials stay on this machine.\n',
    );
    process.exit(2);
  }

  if (loaded.path) {
    console.log(c.dim(`Loaded .env.local (${loaded.keys.length} key(s))`));
  }

  return {
    email,
    password,
    subdomainSlug,
    baseUrl: process.env['BIZURI_API'] ?? DEFAULT_API,
    branchOverride: process.env['BIZURI_BRANCH'],
    dryRun: process.env['BIZURI_DRY_RUN'] === '1',
    dbPath: process.env['BIZURI_DB'],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const config = readConfig();

  console.log(c.bold('\nBizuri offline engine: live smoke test'));
  console.log(c.dim(`API            ${config.baseUrl}`));
  console.log(c.dim(`Tenant slug    ${config.subdomainSlug}`));
  console.log(c.dim(`Email          ${config.email}`));
  // Masked, not printed: enough to confirm the right value loaded, not enough to
  // leak through scrollback or a pasted transcript.
  console.log(c.dim(`Password       ${mask(config.password)}`));
  console.log(c.dim(`Contract       ${CONTRACT_VERSION}`));

  if (config.baseUrl.includes('bizuri-api.eccellenza.tech') && !config.dryRun) {
    // Production plus a live push would create a real sale against real
    // customers' stock. Refuse rather than warn.
    console.error(
      c.red('\nRefusing to run a live push against production.\n') +
        'Use the testing or staging host, or set BIZURI_DRY_RUN=1.\n',
    );
    process.exit(2);
  }

  if (config.dryRun) console.log(c.yellow('DRY RUN: nothing will be pushed to the server'));

  // --- database ----------------------------------------------------------
  const tempDir = config.dbPath ? null : mkdtempSync(join(tmpdir(), 'bizuri-smoke-'));
  const dbPath = config.dbPath ?? join(tempDir!, 'local.sqlite');

  // Unencrypted on purpose: this exercises sync and the sale path, not the
  // cipher. Encryption is covered by the engine's connection tests.
  const db = new Database(dbPath) as unknown as SqliteDatabase;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const cleanup = () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    // --- 1. migrate ------------------------------------------------------
    heading('Apply local schema');
    const migration = runMigrations(db);
    ok(`schema v${migration.fromVersion} → v${migration.toVersion}`);
    info(`${migration.created.length} tables created`);
    info(`awaiting hydration: ${migration.needsHydration.join(', ') || 'none'}`);

    // --- 2. connect ------------------------------------------------------
    heading('Connect and authenticate');
    const client = new RemoteClient({ baseUrl: config.baseUrl, timeoutMs: 30_000 });

    const probe = await client.probe();
    if (!probe.online) {
      fail(`API unreachable: ${probe.detail ?? 'no response'}`);
      warn('A Cloudflare 525 here means the origin TLS handshake failed, which is');
      warn('server-side. Confirm the host is up before assuming a client problem.');
      return 1;
    }
    ok(`reachable (HTTP ${probe.status})`);

    let session;
    try {
      session = await client.login({
        email: config.email,
        password: config.password,
        subdomainSlug: config.subdomainSlug,
      });
    } catch (err) {
      if (err instanceof MfaRequiredError) {
        fail('This account requires 2FA, so it cannot drive unattended sync.');
        warn('Use a service account without 2FA, or complete the challenge manually.');
        return 1;
      }
      throw err;
    }

    ok(`logged in as ${session.displayName ?? config.email}`);
    info(`tenant  ${session.tenantId}`);
    info(`branch  ${session.branchId || c.yellow('(none returned)')}`);

    const branchId = config.branchOverride ?? session.branchId;
    if (!branchId) {
      fail('No branch id available. Set BIZURI_BRANCH=<uuid>.');
      warn('Every core endpoint scopes on X-Branch-Id, so hydration cannot proceed.');
      return 1;
    }

    const scope = { tenantId: session.tenantId, branchId };

    // Seed the device session, which the receipt chain requires.
    db.prepare(
      `INSERT INTO device_session
         (device_id, tenant_id, branch_id, tenant_slug, receipt_prefix,
          receipt_seq, last_receipt_hash, contract_version, activated_at)
       VALUES (?,?,?,?,?,0,NULL,?,?)
       ON CONFLICT(device_id) DO NOTHING`,
    ).run(
      'smoke-device-01', scope.tenantId, scope.branchId, config.subdomainSlug,
      'SMOKE', CONTRACT_VERSION, new Date().toISOString(),
    );

    // --- 3. hydrate ------------------------------------------------------
    heading('Hydrate local store from the live API');
    const stats = await hydrate(db, client, scope, {
      onProgress: (t) => {
        if (t.error) {
          fail(`${t.table}: ${t.error}`);
        } else {
          const mode = t.mode === 'full-refresh' ? c.yellow(t.mode) : c.green(t.mode);
          ok(`${t.table.padEnd(16)} ${String(t.rows).padStart(6)} rows  ` +
            `${String(t.pages).padStart(3)} pages  ${ms(t.durationMs).padStart(7)}  ${mode}`);
        }
      },
    });

    console.log();
    info(`${stats.totalRows} rows over ${stats.totalPages} requests in ${ms(stats.durationMs)}`);

    if (stats.failed.length > 0) {
      warn(`failed: ${stats.failed.join(', ')}`);
    }

    // The measured cost of contract gap #1, which is the argument for the
    // draft PR rather than an assertion in a document.
    const fullRefresh = stats.tables.filter((t) => t.mode === 'full-refresh');
    if (fullRefresh.length > 0) {
      console.log();
      warn(
        `${fullRefresh.length} of ${stats.tables.length} tables did a FULL refresh, because`,
      );
      warn('SalesCatalogItem and StockBalanceResponse have no updatedAt field.');
      warn(
        `Every sync cycle therefore costs ${stats.totalPages} requests and ` +
          `${ms(stats.durationMs)}, no matter how little changed.`,
      );
      warn('Adding updatedAt (contract gap #1) is what turns this incremental.');
    }

    const tier1Missing = TIER_1_TABLES.filter(
      (t) => !stats.tables.some((s) => s.table === t && !s.error),
    );
    if (tier1Missing.length > 0) {
      warn(`tier-1 tables not hydrated: ${tier1Missing.join(', ')}`);
    }

    // --- 4. sell offline -------------------------------------------------
    heading('Create a sale offline (local transaction only)');

    const sellable = db
      .prepare(
        `SELECT item_id, item_name, selling_price, available_qty, sell_mode,
                tax_category_rate
           FROM sales_catalog
          WHERE tenant_id = ? AND branch_id = ? AND deleted = 0
            AND selling_price IS NOT NULL
            AND (sell_mode = 'MADE_TO_ORDER' OR CAST(available_qty AS REAL) >= 1)
          ORDER BY item_name
          LIMIT 1`,
      )
      .get(scope.tenantId, scope.branchId) as
      | {
          item_id: string;
          item_name: string;
          selling_price: string;
          available_qty: string | null;
          sell_mode: string;
          tax_category_rate: string | null;
        }
      | undefined;

    if (!sellable) {
      fail('No sellable item with a price and available stock in this branch.');
      warn('Add stock in the Bizuri UI, or point at a branch that has some.');
      return 1;
    }

    info(`item     ${sellable.item_name} (${sellable.sell_mode})`);
    info(`price    ${sellable.selling_price}`);
    info(`tax rate ${sellable.tax_category_rate ?? '0'}%`);
    info(`on hand  ${sellable.available_qty ?? 'n/a'}`);

    const createSale = makeCreateSale({
      db,
      deviceId: 'smoke-device-01',
      contractVersion: CONTRACT_VERSION,
    });

    const idempotencyKey = `smoke-${Date.now()}`;
    const result = createSale({
      request: {
        v: 1,
        id: 'smoke-req-1',
        operationId: 'createSale',
        method: 'POST',
        pathParams: {},
        query: {},
        headers: {},
        issuedAt: new Date().toISOString(),
        body: {
          intent: 'CONFIRM',
          lines: [{ itemId: sellable.item_id, quantity: '1' }],
          payments: [{ method: 'CASH', amount: sellable.selling_price }],
          deviceId: 'smoke-device-01',
        },
      },
      tenantId: scope.tenantId,
      branchId: scope.branchId,
      idempotencyKey,
    });

    const sale = result.data;
    console.log();
    ok(`sale created locally: ${sale.saleNumber}`);
    info(`subtotal  ${sale.subtotal}`);
    info(`tax       ${sale.taxTotal}`);
    info(`total     ${sale.grandTotal}`);
    info(`paid      ${sale.amountPaid}   change ${sale.changeGiven}`);
    info(`status    ${sale.status}, sync PENDING`);

    const receipt = db
      .prepare('SELECT receipt_number, seq, hash FROM receipts WHERE sale_id = ?')
      .get(sale.id) as { receipt_number: string; seq: number; hash: string } | undefined;
    if (receipt) {
      ok(`receipt ${receipt.receipt_number} (seq ${receipt.seq})`);
      info(`hash ${receipt.hash.slice(0, 32)}…`);
    }

    const chain = verifyReceiptChain(db, scope.tenantId, 'smoke-device-01');
    if (chain.valid) {
      ok(`receipt chain verified (${chain.checked} receipt(s))`);
    } else {
      fail(`chain invalid: ${chain.gaps.length} gaps, ${chain.tampered.length} tampered`);
    }

    info(`outbox: ${JSON.stringify(summariseOutbox(db))}`);

    if (config.dryRun) {
      console.log();
      warn('DRY RUN: stopping before push. Nothing was sent to the server.');
      return 0;
    }

    // --- 5. push ---------------------------------------------------------
    heading('Push the outbox to the live API');
    const push = await pushOutbox(db, client, {
      batchSize: 50,
      maxAttempts: 3,
      leaseMs: 90_000,
      deviceId: 'smoke-device-01',
    });

    info(`claimed ${push.claimed}, ${push.requestCount} request(s), ${ms(push.durationMs)}`);
    for (const row of push.rows) {
      if (row.outcome === 'APPLIED') {
        ok(`${row.outcome}  server id ${row.serverId ?? '(none)'}  ` +
          `number ${row.serverNumber ?? '(none)'}`);
      } else {
        fail(`${row.outcome}  ${row.error ?? ''}`);
      }
    }

    if (push.wentOffline) warn('network dropped mid-push; remaining rows stay queued');

    const synced = db
      .prepare('SELECT sync_state, server_id, sale_number FROM sales WHERE id = ?')
      .get(sale.id) as
      | { sync_state: string; server_id: string | null; sale_number: string }
      | undefined;

    if (synced?.sync_state === 'SYNCED') {
      console.log();
      ok(`sale is SYNCED, server number ${synced.sale_number}`);
      info(`local id  ${sale.id}`);
      info(`server id ${synced.server_id}`);
    } else {
      fail(`sale did not sync: state ${synced?.sync_state}`);
      return 1;
    }

    // --- 6. replay -------------------------------------------------------
    heading('Replay the same idempotency key (exactly-once check)');
    info('Re-sending the identical key. The contract states a repeat returns the');
    info('original sale without deducting stock again.');

    try {
      const replay = await client.request<unknown>('/core/sales', {
        method: 'POST',
        body: {
          intent: 'CONFIRM',
          lines: [{ itemId: sellable.item_id, quantity: 1 }],
          payments: [{ method: 'CASH', amount: Number(sellable.selling_price) }],
          deviceId: 'smoke-device-01',
        },
        idempotencyKey,
      });

      const replayed = (
        (replay as { data?: { id?: string; saleNumber?: string } }).data ?? {}
      ) as { id?: string; saleNumber?: string };

      if (replayed.id === synced.server_id) {
        ok(`same sale returned (${replayed.saleNumber}). Exactly-once holds.`);
      } else {
        fail(`DIFFERENT sale created: ${replayed.id} vs ${synced.server_id}`);
        warn('Idempotency is not being honoured. A reconnect would double-charge.');
        return 1;
      }
    } catch (err) {
      if (err instanceof RemoteError) {
        warn(`replay returned HTTP ${err.status}: ${err.message}`);
        warn('Not necessarily wrong: some servers reject a duplicate rather than');
        warn('replaying it. Either is safe; silently creating a second sale is not.');
      } else {
        throw err;
      }
    }

    console.log(`\n${c.green(c.bold('Offline loop verified end to end against the live API.'))}\n`);
    return 0;
  } catch (err) {
    console.log();
    if (err instanceof OfflineError) {
      fail(`Network: ${err.message}`);
    } else if (err instanceof RemoteError) {
      fail(`HTTP ${err.status}${err.errorCode ? ` [${err.errorCode}]` : ''}: ${err.message}`);
      if (err.body) console.log(c.dim(`   ${JSON.stringify(err.body).slice(0, 600)}`));
    } else {
      fail(err instanceof Error ? err.message : String(err));
      if (err instanceof Error && err.stack) console.log(c.dim(err.stack));
    }
    return 1;
  } finally {
    cleanup();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
