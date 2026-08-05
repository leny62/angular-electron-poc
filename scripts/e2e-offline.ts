/**
 * End-to-end offline scenario against the local mock API.
 *
 * This is the demo: a shift that starts online, loses connectivity mid-trade,
 * keeps selling, and reconciles on reconnect. It exercises the real engine code
 * over a real HTTP socket, with the network genuinely refused rather than
 * stubbed at the function level.
 *
 * The distinction from the Jest suite matters. There, `fetch` is a fake and
 * "offline" is a thrown error. Here the mock destroys the socket, so the engine
 * meets the same `ECONNRESET` a real outage produces, through the same stack.
 *
 *   npm run mock:api        (in one terminal)
 *   npm run e2e:offline     (in another)
 *
 * Options:
 *   E2E_SALES=25        sales to make during the outage (default 12)
 *   E2E_PORT=4300       mock port
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import { CONTRACT_VERSION } from '@bizuri/local-store';
import {
  hydrate,
  makeCreateSale,
  pushOutbox,
  RemoteClient,
  runMigrations,
  summariseOutbox,
  verifyReceiptChain,
  type SqliteDatabase,
} from '@bizuri/local-engine';

/** What `createSale` returns in `.data`: the same envelope the real API sends. */
interface SaleEnvelope {
  success: boolean;
  message: string;
  data: { id: string; saleNumber: string; grandTotal: number };
}

const PORT = Number(process.env['E2E_PORT'] ?? 4300);
const BASE = `http://localhost:${PORT}`;
const SALE_COUNT = Number(process.env['E2E_SALES'] ?? 12);
const DEVICE = 'e2e-device-01';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

let phase = 0;
const heading = (t: string) => {
  phase++;
  console.log(`\n${c.bold(`${phase}. ${t}`)}`);
  console.log(c.dim('─'.repeat(66)));
};
const ok = (m: string) => console.log(`   ${c.green('✓')} ${m}`);
const info = (m: string) => console.log(`   ${c.dim('·')} ${m}`);
const bad = (m: string) => console.log(`   ${c.red('✗')} ${m}`);
const note = (m: string) => console.log(`   ${c.yellow('!')} ${m}`);

/** Drive the mock's control plane. */
async function control(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}/__mock/${path}`, { method: 'POST' });
  return res.json();
}

async function mockState(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/__mock/state`);
  return (await res.json()) as Record<string, unknown>;
}

let failures = 0;
function expect(condition: boolean, message: string): void {
  if (condition) ok(message);
  else {
    bad(message);
    failures++;
  }
}

async function main(): Promise<number> {
  console.log(c.bold('\nBizuri offline engine: end-to-end scenario'));
  console.log(c.dim(`mock   ${BASE}`));
  console.log(c.dim(`sales  ${SALE_COUNT} during the outage`));

  // Fail fast with a useful message rather than a stack trace.
  try {
    await fetch(`${BASE}/actuator/health`);
  } catch {
    console.error(
      `\n${c.red('Mock API is not running.')}\n\n  Start it first:  npm run mock:api\n`,
    );
    return 2;
  }

  await control('reset');

  const dir = mkdtempSync(join(tmpdir(), 'bizuri-e2e-'));
  const db = new Database(join(dir, 'local.sqlite')) as unknown as SqliteDatabase;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  try {
    // --- 1. cold start ---------------------------------------------------
    heading('Cold start: migrate and hydrate while online');
    runMigrations(db);

    // maxRetries 3 against `fail/2` below: attempts 1 and 2 get 503, attempt 3
    // succeeds. With maxRetries 2 the budget is exhausted by the forced failures
    // and the test proves nothing about recovery.
    const client = new RemoteClient({ baseUrl: BASE, timeoutMs: 10_000, maxRetries: 3 });
    const session = await client.login({
      email: 'demo@bizuri.test',
      password: 'mockpassword123',
      subdomainSlug: 'demo',
    });

    const scope = { tenantId: session.tenantId, branchId: session.branchId };

    db.prepare(
      `INSERT INTO device_session
         (device_id, tenant_id, branch_id, tenant_slug, receipt_prefix,
          receipt_seq, last_receipt_hash, contract_version, activated_at)
       VALUES (?,?,?,?,?,0,NULL,?,?)`,
    ).run(DEVICE, scope.tenantId, scope.branchId, 'demo', 'RCP', CONTRACT_VERSION, new Date().toISOString());

    const hydration = await hydrate(db, client, scope);
    expect(hydration.failed.length === 0, `hydrated ${hydration.totalRows} rows`);
    info(`${hydration.totalPages} requests, ${hydration.durationMs}ms`);

    const stockable = db
      .prepare(
        `SELECT item_id, item_name, selling_price, available_qty
           FROM sales_catalog
          WHERE branch_id = ? AND sell_mode = 'IN_STOCK'
            AND selling_price IS NOT NULL
            AND CAST(available_qty AS REAL) >= ?
          ORDER BY item_name LIMIT 1`,
      )
      .get(scope.branchId, SALE_COUNT) as
      | { item_id: string; item_name: string; selling_price: string; available_qty: string }
      | undefined;

    if (!stockable) {
      bad(`no item with at least ${SALE_COUNT} units in stock`);
      return 1;
    }
    info(`will sell: ${stockable.item_name} at ${stockable.selling_price}`);
    info(`stock before: ${stockable.available_qty}`);

    // --- 2. outage -------------------------------------------------------
    heading('Connectivity lost mid-shift');
    await control('offline');
    note('mock is now refusing connections (socket destroyed, not a 503)');

    const probe = await client.probe();
    expect(!probe.online, 'engine detects it is offline');

    // --- 3. keep selling -------------------------------------------------
    heading(`Keep selling: ${SALE_COUNT} sales with no network`);
    const createSale = makeCreateSale({ db, deviceId: DEVICE, contractVersion: CONTRACT_VERSION });

    const localIds: string[] = [];
    const started = Date.now();

    for (let i = 0; i < SALE_COUNT; i++) {
      const sale = createSale({
        request: {
          v: 1,
          id: `e2e-${i}`,
          operationId: 'createSale',
          method: 'POST',
          pathParams: {},
          query: {},
          headers: {},
          issuedAt: new Date().toISOString(),
          body: {
            intent: 'CONFIRM',
            lines: [{ itemId: stockable.item_id, quantity: '1' }],
            payments: [{ method: 'CASH', amount: stockable.selling_price }],
          },
        },
        tenantId: scope.tenantId,
        branchId: scope.branchId,
        idempotencyKey: `e2e-key-${i}`,
      }).data as SaleEnvelope;

      // `.data` is the API envelope, not the sale. Reading the sale straight
      // off it silently yields undefined, which is exactly the bug that reached
      // the POS as "Sale undefined committed locally".
      localIds.push(sale.data.id);
    }

    expect(
      localIds.every((id) => typeof id === 'string' && id.length > 0),
      'every sale came back with an id',
    );

    ok(`${SALE_COUNT} sales committed locally in ${Date.now() - started}ms`);

    const afterStock = db
      .prepare('SELECT available_qty FROM sales_catalog WHERE item_id = ? AND branch_id = ?')
      .get(stockable.item_id, scope.branchId) as { available_qty: string };
    expect(
      Number(afterStock.available_qty) === Number(stockable.available_qty) - SALE_COUNT,
      `stock deducted locally: ${stockable.available_qty} → ${afterStock.available_qty}`,
    );

    const chain = verifyReceiptChain(db, scope.tenantId, DEVICE);
    expect(chain.valid && chain.checked === SALE_COUNT, `receipt chain intact (${chain.checked})`);

    const queued = summariseOutbox(db);
    expect(queued.pending === SALE_COUNT, `${queued.pending} sales queued in the outbox`);

    // --- 4. push while still offline -------------------------------------
    heading('Sync attempt while still offline');
    const failedPush = await pushOutbox(db, client, {
      batchSize: 50, maxAttempts: 3, leaseMs: 90_000, deviceId: DEVICE,
    });

    expect(failedPush.wentOffline, 'push detected the outage and stopped');
    expect(failedPush.applied === 0, 'nothing was pushed');
    expect(
      summariseOutbox(db).pending === SALE_COUNT,
      'every sale is still queued, none lost or stuck INFLIGHT',
    );

    // --- 5. flaky reconnect ----------------------------------------------
    heading('Network returns, but flaky');
    await control('online');
    await control('fail/2');
    note('next 2 requests will return 503, to exercise retry with backoff');

    const push = await pushOutbox(db, client, {
      batchSize: 50, maxAttempts: 3, leaseMs: 90_000, deviceId: DEVICE,
    });

    info(`${push.requestCount} requests, ${push.durationMs}ms`);
    expect(push.applied === SALE_COUNT, `${push.applied}/${SALE_COUNT} sales pushed`);
    expect(push.rejected === 0, 'no sale rejected');

    // --- 6. reconcile ----------------------------------------------------
    heading('Reconcile');
    const after = summariseOutbox(db);
    expect(after.pending === 0, 'outbox drained');
    expect(after.synced === SALE_COUNT, `${after.synced} rows marked SYNCED`);

    const unsynced = db
      .prepare("SELECT count(*) AS c FROM sales WHERE sync_state != 'SYNCED'")
      .get() as { c: number };
    expect(unsynced.c === 0, 'every local sale is SYNCED');

    const withServerId = db
      .prepare('SELECT count(*) AS c FROM sales WHERE server_id IS NOT NULL')
      .get() as { c: number };
    expect(withServerId.c === SALE_COUNT, 'every sale adopted a server id');

    const server = await mockState();
    expect(
      server['salesCreated'] === SALE_COUNT,
      `server created exactly ${SALE_COUNT} sales (no duplicates)`,
    );

    // --- 7. replay safety -------------------------------------------------
    heading('Replay safety: re-push everything');
    note('simulating a worker that crashed after sending but before recording');
    db.prepare("UPDATE outbox SET state = 'PENDING', leased_until = NULL").run();

    await pushOutbox(db, client, {
      batchSize: 50, maxAttempts: 3, leaseMs: 90_000, deviceId: DEVICE,
    });

    const afterReplay = await mockState();
    expect(
      afterReplay['salesCreated'] === SALE_COUNT,
      `still ${SALE_COUNT} sales on the server after a full re-push`,
    );

    // --- summary ----------------------------------------------------------
    console.log();
    if (failures === 0) {
      console.log(c.green(c.bold('  All checks passed. Offline loop verified over real HTTP.')));
      console.log(
        c.dim(
          `\n  ${SALE_COUNT} sales survived an outage, a flaky reconnect, and a full\n` +
            '  duplicate push, landing exactly once.\n',
        ),
      );
      return 0;
    }

    console.log(c.red(c.bold(`  ${failures} check(s) failed.`)));
    return 1;
  } catch (err) {
    console.log();
    bad(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.log(c.dim(err.stack));
    return 1;
  } finally {
    // Always restore the mock, so a failed run does not leave it offline and
    // make the next run fail for the wrong reason.
    await control('online').catch(() => {});
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
