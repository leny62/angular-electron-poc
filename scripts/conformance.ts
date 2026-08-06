/**
 * Contract conformance probe.
 *
 * Everything in `@bizuri/local-engine` is written against the *declared* shapes in
 * `bizuri-core-api-contract.yaml`. Real implementations diverge from their
 * contracts, and each divergence would otherwise surface as a separate failed
 * smoke run. This checks every assumption the engine makes in one pass and
 * reports exactly which ones hold.
 *
 * READ-ONLY by default. It creates nothing and modifies nothing. The one write
 * check (idempotency) is opt-in and gated behind BIZURI_CHECK_IDEMPOTENCY=1,
 * because verifying it means creating two real sales.
 *
 *   npm run conformance          read-only
 *   BIZURI_CHECK_IDEMPOTENCY=1 npm run conformance
 *
 * Exit codes:
 *   0  every critical assumption holds
 *   1  at least one critical assumption is violated
 *   2  could not reach or authenticate against the API
 */

import { loadEnvLocal, mask } from './load-env';
import { OfflineError, RemoteClient, RemoteError } from '@bizuri/local-engine';

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

type Severity = 'critical' | 'expected-gap' | 'informational';

interface Check {
  readonly name: string;
  readonly severity: Severity;
  readonly holds: boolean;
  readonly detail: string;
  /** What the engine does about it, when the assumption does not hold. */
  readonly impact?: string;
}

const checks: Check[] = [];

function record(check: Check): void {
  checks.push(check);

  const mark = check.holds
    ? c.green('✓')
    : check.severity === 'critical'
      ? c.red('✗')
      : c.yellow('!');

  console.log(`   ${mark} ${check.name}`);
  console.log(c.dim(`      ${check.detail}`));
  if (!check.holds && check.impact) {
    console.log(c.dim(`      → ${check.impact}`));
  }
}

let section = 0;
function heading(title: string): void {
  section++;
  console.log(`\n${c.bold(`${section}. ${title}`)}`);
  console.log(c.dim('─'.repeat(70)));
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Describe an envelope without dumping tenant data into the terminal. */
function describeEnvelope(body: unknown): string {
  if (!isObject(body)) return `not an object (${typeof body})`;
  const keys = Object.keys(body).sort();
  return `top-level keys: ${keys.join(', ') || '(none)'}`;
}

function firstItem(body: unknown): Record<string, unknown> | null {
  if (!isObject(body)) return null;
  const data = body['data'];
  if (Array.isArray(data) && data.length > 0 && isObject(data[0])) {
    return data[0] as Record<string, unknown>;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  loadEnvLocal();

  const baseUrl = process.env['BIZURI_API'];
  if (!baseUrl) {
    console.error('BIZURI_API is required. Set it in .env and retry.');
    return 1;
  }

  const email = process.env['BIZURI_EMAIL'];
  const password = process.env['BIZURI_PASSWORD'];
  const subdomainSlug = process.env['BIZURI_SLUG'];
  const checkIdempotency = process.env['BIZURI_CHECK_IDEMPOTENCY'] === '1';

  if (!email || !password || !subdomainSlug) {
    console.error(
      `\n${c.red('Missing configuration.')} Copy .env.local.example to .env.local and fill it in.\n`,
    );
    return 2;
  }

  console.log(c.bold('\nBizuri contract conformance probe'));
  console.log(c.dim(`API      ${baseUrl}`));
  console.log(c.dim(`Slug     ${subdomainSlug}`));
  console.log(c.dim(`Password ${mask(password)}`));
  console.log(
    c.dim(
      checkIdempotency
        ? 'Mode     read-only + idempotency (WILL create up to 2 real sales)'
        : 'Mode     read-only',
    ),
  );

  const client = new RemoteClient({ baseUrl, timeoutMs: 30_000 });

  // --- 1. reachability ---------------------------------------------------
  heading('Reachability');
  const probe = await client.probe();

  if (!probe.online) {
    console.log(`   ${c.red('✗')} API unreachable: ${probe.detail ?? 'no response'}`);
    console.log(
      c.dim(
        '\n      A Cloudflare 525 means Cloudflare could not complete a TLS handshake\n' +
          '      with the origin. That is server-side. Nothing about the client can fix it.\n',
      ),
    );
    return 2;
  }

  record({
    name: 'API responds',
    severity: 'critical',
    holds: true,
    detail: `HTTP ${probe.status}`,
  });

  record({
    name: '/actuator/health exposed through the gateway',
    severity: 'informational',
    holds: probe.status === 200,
    detail:
      probe.status === 200
        ? 'health endpoint reachable'
        : `returned ${probe.status}; the engine treats any response under 500 as "online"`,
    impact: 'Online detection falls back to any successful API call.',
  });

  // --- 2. auth -----------------------------------------------------------
  heading('Authentication');
  let session;
  try {
    session = await client.login({ email, password, subdomainSlug });
  } catch (err) {
    if (err instanceof RemoteError) {
      console.log(`   ${c.red('✗')} login failed: HTTP ${err.status} ${err.message}`);
      if (err.status === 401 || err.status === 400) {
        console.log(c.dim('      Check BIZURI_EMAIL, BIZURI_PASSWORD, and BIZURI_SLUG.'));
        console.log(
          c.dim('      BIZURI_SLUG is the subdomain alone, e.g. `acme`, not the full host.'),
        );
      }
    } else {
      console.log(`   ${c.red('✗')} login failed: ${String(err)}`);
    }
    return 2;
  }

  record({
    name: 'login returns an access token',
    severity: 'critical',
    holds: Boolean(session.accessToken),
    detail: session.accessToken ? 'accessToken present' : 'accessToken MISSING',
  });

  record({
    name: 'login returns tenantId',
    severity: 'critical',
    holds: Boolean(session.tenantId),
    detail: session.tenantId ? `tenantId ${session.tenantId}` : 'tenantId MISSING',
    impact: 'Every core endpoint scopes on X-Tenant-Id; hydration cannot run without it.',
  });

  record({
    name: 'login returns branchId',
    severity: 'critical',
    holds: Boolean(session.branchId),
    detail: session.branchId ? `branchId ${session.branchId}` : 'branchId MISSING',
    impact: 'Set BIZURI_BRANCH explicitly. Branch-scoped endpoints require X-Branch-Id.',
  });

  record({
    name: 'login returns a refresh token',
    severity: 'informational',
    holds: Boolean(session.refreshToken),
    detail: session.refreshToken ? 'refreshToken present' : 'absent',
    impact: 'The engine falls back to a full re-login when the access token expires.',
  });

  const branchId = process.env['BIZURI_BRANCH'] ?? session.branchId;
  if (!branchId) {
    console.log(`\n   ${c.red('Cannot continue without a branch id.')} Set BIZURI_BRANCH.`);
    return 1;
  }

  // --- 3. bare-page envelope ---------------------------------------------
  heading('Response envelopes: bare page (catalog, stock)');

  const catalogBody = await safeGet(client, '/core/sales/catalog', {
    page: 0,
    size: 5,
    branchId,
  });

  if (catalogBody.error) {
    record({
      name: 'GET /core/sales/catalog',
      severity: 'critical',
      holds: false,
      detail: catalogBody.error,
      impact: 'Catalog hydration will fail; the POS cannot sell.',
    });
  } else {
    const body = catalogBody.value;
    console.log(c.dim(`      ${describeEnvelope(body)}`));

    const b = isObject(body) ? body : {};
    record({
      name: 'catalog uses the bare-page envelope',
      severity: 'critical',
      holds: Array.isArray(b['data']) && typeof b['totalElements'] === 'number',
      detail:
        Array.isArray(b['data']) && typeof b['totalElements'] === 'number'
          ? 'data[] + totalElements at the top level, as declared'
          : `unexpected: ${describeEnvelope(body)}`,
      impact: 'normalisePage() also accepts the wrapped form, so this may still work.',
    });

    record({
      name: 'catalog reports hasNext',
      severity: 'informational',
      holds: typeof b['hasNext'] === 'boolean',
      detail:
        typeof b['hasNext'] === 'boolean'
          ? 'hasNext present'
          : 'hasNext absent; the client derives it from page vs totalPages',
    });

    // --- SalesCatalogItem field names ---
    const item = firstItem(body);
    if (!item) {
      record({
        name: 'catalog returned at least one item',
        severity: 'critical',
        holds: false,
        detail: 'empty catalog for this branch',
        impact: 'Cannot verify field names, and the smoke test will have nothing to sell.',
      });
    } else {
      console.log(c.dim(`      item keys: ${Object.keys(item).sort().join(', ')}`));

      for (const field of [
        'itemId',
        'itemName',
        'itemCode',
        'sellMode',
        'sellingPrice',
        'availableQty',
        'taxCategoryRate',
      ]) {
        record({
          name: `SalesCatalogItem.${field}`,
          severity: 'critical',
          holds: field in item,
          detail: field in item ? `present (${typeof item[field]})` : 'MISSING',
          impact: 'The generated mapper reads this field; a rename breaks the local row.',
        });
      }

      // --- the two known contract gaps, confirmed against reality ---
      record({
        name: 'SalesCatalogItem.updatedAt',
        severity: 'expected-gap',
        holds: 'updatedAt' in item,
        detail:
          'updatedAt' in item
            ? c.green('PRESENT — incremental pull is possible after all')
            : 'absent, as the contract declares (gap #1)',
        impact:
          'Every sync does a full catalog refresh. This is the evidence for the updatedAt PR.',
      });

      record({
        name: 'SalesCatalogItem.deleted',
        severity: 'expected-gap',
        holds: 'deleted' in item,
        detail:
          'deleted' in item
            ? c.green('PRESENT — tombstones are available')
            : 'absent, as the contract declares (gap #2)',
        impact:
          'A discontinued item would linger locally. Mitigated today by delete-then-refill.',
      });

      // Money as JSON number is expected and matches Jackson's BigDecimal
      // serialisation; the engine converts to decimal strings on the way in.
      const priceType = typeof item['sellingPrice'];
      record({
        name: 'money arrives as a JSON number',
        severity: 'informational',
        holds: priceType === 'number' || priceType === 'string',
        detail: `sellingPrice is ${priceType}; the engine stores it as a decimal string either way`,
      });
    }
  }

  // --- 4. wrapped envelope -----------------------------------------------
  heading('Response envelopes: SuccessResponse wrapper (tax categories)');

  const taxBody = await safeGet(client, '/core/tax-categories', { page: 0, size: 5 });

  if (taxBody.error) {
    record({
      name: 'GET /core/tax-categories',
      severity: 'critical',
      holds: false,
      detail: taxBody.error,
      impact: 'Tax rates are tier-1 data; totals would be wrong without them.',
    });
  } else {
    const b = isObject(taxBody.value) ? taxBody.value : {};
    console.log(c.dim(`      ${describeEnvelope(taxBody.value)}`));

    record({
      name: 'tax categories use the wrapped envelope',
      severity: 'critical',
      holds: 'success' in b && Array.isArray(b['data']),
      detail:
        'success' in b && Array.isArray(b['data'])
          ? 'success + data[] (+ meta), as declared'
          : `unexpected: ${describeEnvelope(taxBody.value)}`,
      impact: 'normalisePage() accepts both forms, so this may still work.',
    });

    const meta = isObject(b['meta']) ? (b['meta'] as Record<string, unknown>) : null;
    record({
      name: 'pagination meta field names',
      severity: 'informational',
      holds: meta !== null,
      detail: meta
        ? `meta keys: ${Object.keys(meta).sort().join(', ')}`
        : 'no meta object; the client falls back to counting the returned array',
    });
  }

  // --- 5. error envelope --------------------------------------------------
  heading('Error envelope');

  const missing = await safeGet(client, '/core/sales/00000000-0000-4000-8000-000000000000', {});
  if (missing.error) {
    record({
      name: 'error responses carry errorCode',
      severity: 'informational',
      holds: missing.errorCode !== undefined,
      detail: missing.errorCode
        ? `HTTP ${missing.status}, errorCode ${missing.errorCode}`
        : `HTTP ${missing.status}, no machine-readable errorCode`,
      impact: 'Push failure classification falls back to the HTTP status alone.',
    });
  } else {
    record({
      name: 'a nonexistent sale returns an error',
      severity: 'informational',
      holds: false,
      detail: 'returned success for an id that should not exist',
    });
  }

  // --- 6. idempotency (opt-in, writes) ------------------------------------
  heading('Idempotency on POST /core/sales');

  if (!checkIdempotency) {
    console.log(
      c.dim(
        '   skipped. This check creates real sales.\n' +
          '   Enable with BIZURI_CHECK_IDEMPOTENCY=1 once the rest passes.\n',
      ),
    );
    console.log(
      c.yellow(
        '   This is the single most important unverified assumption. The contract\n' +
          '   states a repeated Idempotency-Key returns the original sale. If the\n' +
          '   server does not honour that, a reconnecting device double-charges.',
      ),
    );
  } else {
    await checkIdempotencyBehaviour(client, branchId);
  }

  // --- summary -------------------------------------------------------------
  heading('Summary');

  const criticalFailures = checks.filter((c2) => c2.severity === 'critical' && !c2.holds);
  const gapsConfirmed = checks.filter((c2) => c2.severity === 'expected-gap' && !c2.holds);
  const gapsClosed = checks.filter((c2) => c2.severity === 'expected-gap' && c2.holds);

  console.log(`   ${checks.filter((x) => x.holds).length}/${checks.length} assumptions hold`);

  if (gapsClosed.length > 0) {
    console.log(
      c.green(
        `\n   ${gapsClosed.length} expected contract gap(s) are NOT actually gaps:\n` +
          gapsClosed.map((g) => `     - ${g.name}`).join('\n') +
          '\n   The server returns more than the contract declares. Incremental sync\n' +
          '   may be possible today: worth updating the contract to match reality.',
      ),
    );
  }

  if (gapsConfirmed.length > 0) {
    console.log(
      c.yellow(
        `\n   ${gapsConfirmed.length} contract gap(s) confirmed against the live API:\n` +
          gapsConfirmed.map((g) => `     - ${g.name}`).join('\n'),
      ),
    );
  }

  if (criticalFailures.length > 0) {
    console.log(
      c.red(
        `\n   ${criticalFailures.length} critical assumption(s) violated:\n` +
          criticalFailures.map((f) => `     - ${f.name}: ${f.detail}`).join('\n'),
      ),
    );
    console.log(c.dim('\n   The engine needs adjusting before smoke:live will work.\n'));
    return 1;
  }

  console.log(c.green('\n   No critical divergence. smoke:dry should work.\n'));
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GetResult {
  value?: unknown;
  error?: string;
  status?: number;
  errorCode?: string;
}

async function safeGet(
  client: RemoteClient,
  path: string,
  query: Record<string, string | number | boolean | undefined> & { branchId?: string },
): Promise<GetResult> {
  const { branchId, ...rest } = query;
  try {
    const value = await client.request<unknown>(path, {
      method: 'GET',
      query: rest,
      ...(branchId ? { branchId } : {}),
    });
    return { value };
  } catch (err) {
    if (err instanceof RemoteError) {
      return {
        error: `HTTP ${err.status}: ${err.message}`,
        status: err.status,
        ...(err.errorCode ? { errorCode: err.errorCode } : {}),
      };
    }
    if (err instanceof OfflineError) return { error: err.message };
    return { error: String(err) };
  }
}

/**
 * Verify that a repeated Idempotency-Key does not create a second sale.
 *
 * This creates ONE real sale, then repeats the request. If idempotency works,
 * the total is one sale. If it does not, the total is two, and that is exactly
 * the double-charge a reconnecting device would cause.
 */
async function checkIdempotencyBehaviour(
  client: RemoteClient,
  branchId: string,
): Promise<void> {
  const catalog = await safeGet(client, '/core/sales/catalog', {
    page: 0,
    size: 1,
    branchId,
  });

  const item = firstItem(catalog.value);
  if (!item) {
    record({
      name: 'idempotency check',
      severity: 'critical',
      holds: false,
      detail: 'no sellable item available to test with',
    });
    return;
  }

  const key = `conformance-${Date.now()}`;
  const body = {
    intent: 'CONFIRM',
    lines: [{ itemId: item['itemId'], quantity: 1 }],
    payments: [{ method: 'CASH', amount: item['sellingPrice'] }],
    deviceId: 'conformance-probe',
  };

  let firstId: string | undefined;

  try {
    const first = await client.request<unknown>('/core/sales', {
      method: 'POST',
      body,
      idempotencyKey: key,
      branchId,
    });
    firstId = (first as { data?: { id?: string } })?.data?.id;

    record({
      name: 'first POST /core/sales succeeds',
      severity: 'critical',
      holds: Boolean(firstId),
      detail: firstId ? `created sale ${firstId}` : 'no sale id returned',
    });
  } catch (err) {
    record({
      name: 'first POST /core/sales succeeds',
      severity: 'critical',
      holds: false,
      detail: err instanceof RemoteError ? `HTTP ${err.status}: ${err.message}` : String(err),
      impact: 'Push cannot work until a sale can be created.',
    });
    return;
  }

  try {
    const replay = await client.request<unknown>('/core/sales', {
      method: 'POST',
      body,
      idempotencyKey: key,
      branchId,
    });
    const replayId = (replay as { data?: { id?: string } })?.data?.id;

    record({
      name: 'repeated Idempotency-Key returns the ORIGINAL sale',
      severity: 'critical',
      holds: replayId === firstId,
      detail:
        replayId === firstId
          ? `same sale returned (${replayId}); exactly-once holds`
          : c.red(`DIFFERENT sale created: ${replayId} vs ${firstId}`),
      impact:
        'Offline replay would double-charge. The outbox would need server-side ' +
        'deduplication before any device can safely retry a push.',
    });
  } catch (err) {
    // Rejecting a duplicate is also safe, just different. Creating a second sale
    // is the only unsafe outcome.
    record({
      name: 'repeated Idempotency-Key is not silently duplicated',
      severity: 'critical',
      holds: true,
      detail:
        err instanceof RemoteError
          ? `server rejected the replay with HTTP ${err.status}; safe, though the ` +
            'contract says it should replay'
          : String(err),
    });
  }

  console.log(
    c.yellow(
      `\n   Note: this created a real sale in ${
        process.env['BIZURI_API'] ?? '(unknown)'
      }.\n   Void or ignore it as your process requires.`,
    ),
  );
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
