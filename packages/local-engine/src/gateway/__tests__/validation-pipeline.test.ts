/**
 * Pipeline tests.
 *
 * Weighted toward the two hardening fixes made during the port, because those
 * are the cases the POC's version got wrong and a regression there is silent:
 *   - gate 1 fails closed on an opaque origin and rejects subframes
 *   - gate 4 enforces `pattern` and bounds its own input
 */

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  makeMockEvent,
  makeMockWindow,
  resetMockWindows,
  type MockWindow,
} from '../../../../__mocks__/electron';
import { EngineStateMachine } from '../../domain/engine-state';
import {
  buildErrorResponse,
  resetRateLimiter,
  validateRequest,
  type ValidationContext,
} from '../validation-pipeline';
import { ENVELOPE_VERSION, type LocalRequest } from '../../contracts';

const ORIGIN = 'http://localhost:4200';
const TENANT = 'tenant-1';
const BRANCH = '9f2b1c44-0000-4000-8000-000000000001';

let win: MockWindow;
let engineState: EngineStateMachine;

beforeEach(() => {
  resetMockWindows();
  resetRateLimiter();
  win = makeMockWindow({ origin: ORIGIN });
  engineState = new EngineStateMachine();
  engineState.markReady();
});

function ctxFor(event: unknown): ValidationContext {
  return {
    event: event as IpcMainInvokeEvent,
    mainWindow: win as unknown as BrowserWindow,
    allowedOrigin: ORIGIN,
    engineState,
  };
}

function req(overrides: Partial<LocalRequest> = {}): unknown {
  return {
    v: ENVELOPE_VERSION,
    id: 'req-1',
    operationId: 'listSalesCatalog',
    method: 'GET',
    pathParams: {},
    query: {},
    headers: { 'X-Tenant-Id': TENANT, 'X-Branch-Id': BRANCH },
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('gate 1: sender identity', () => {
  it('accepts the main frame of the main window at the expected origin', () => {
    const out = validateRequest(req(), ctxFor(makeMockEvent(win)));
    expect(out.valid).toBe(true);
  });

  it('rejects a request from a subframe of our own window', () => {
    // Same webContents, different frame. The POC's window-id check passed this.
    const event = makeMockEvent(win, { frame: { origin: ORIGIN } });
    const out = validateRequest(req(), ctxFor(event));
    expect(out.valid).toBe(false);
    if (!out.valid) expect(out.failure.code).toBe('E_SENDER');
  });

  it('rejects an opaque origin instead of passing it', () => {
    // Fail-closed. `if (origin && origin !== allowed)` let '' through.
    const other = makeMockWindow({ origin: '' });
    const event = makeMockEvent(other);
    const out = validateRequest(req(), ctxFor(event));
    expect(out.valid).toBe(false);
    if (!out.valid) expect(out.failure.code).toBe('E_SENDER');
  });

  it("rejects the literal string 'null' as an origin", () => {
    const other = makeMockWindow({ origin: 'null' });
    const out = validateRequest(req(), ctxFor(makeMockEvent(other)));
    expect(out.valid).toBe(false);
  });

  it('rejects a missing senderFrame', () => {
    const out = validateRequest(req(), ctxFor(makeMockEvent(win, { frame: null })));
    expect(out.valid).toBe(false);
  });

  it('rejects a different window', () => {
    const other = makeMockWindow({ origin: ORIGIN });
    const out = validateRequest(req(), ctxFor(makeMockEvent(other)));
    expect(out.valid).toBe(false);
  });

  it('rejects an origin mismatch', () => {
    const evil = makeMockWindow({ origin: 'http://evil.example' });
    const out = validateRequest(req(), ctxFor(makeMockEvent(evil)));
    expect(out.valid).toBe(false);
  });

  it('rejects once the window is destroyed', () => {
    const dead = makeMockWindow({ origin: ORIGIN, destroyed: true });
    const out = validateRequest(
      req(),
      {
        event: makeMockEvent(dead) as IpcMainInvokeEvent,
        mainWindow: dead as unknown as BrowserWindow,
        allowedOrigin: ORIGIN,
        engineState,
      },
    );
    expect(out.valid).toBe(false);
  });

  it('never echoes the rejection reason to the caller', () => {
    const evil = makeMockWindow({ origin: 'http://evil.example' });
    const out = validateRequest(req(), ctxFor(makeMockEvent(evil)));
    if (!out.valid) {
      expect(out.failure.message).toBe('Request rejected.');
      expect(out.failure.message).not.toContain('origin');
    }
  });
});

describe('gate 2: operation allow-list', () => {
  it('rejects an unknown operationId', () => {
    const out = validateRequest(
      req({ operationId: 'deleteEverything' }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
    if (!out.valid) expect(out.failure.code).toBe('E_UNKNOWN_OPERATION');
  });

  it('rejects an operation that exists in the contract but is not offline', () => {
    // Purchases are explicitly never offline.
    const out = validateRequest(
      req({ operationId: 'listPurchaseOrders' }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
  });

  it('does not echo the operationId back', () => {
    const out = validateRequest(
      req({ operationId: 'someProbe' }),
      ctxFor(makeMockEvent(win)),
    );
    if (!out.valid) expect(out.failure.message).not.toContain('someProbe');
  });

  it('rejects a non-string operationId', () => {
    const out = validateRequest(
      req({ operationId: 42 as unknown as string }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
  });
});

describe('gate 3: envelope', () => {
  it('rejects a mismatched envelope version', () => {
    const out = validateRequest(req({ v: 99 as never }), ctxFor(makeMockEvent(win)));
    expect(out.valid).toBe(false);
    if (!out.valid) {
      expect(out.failure.code).toBe('E_ENVELOPE');
      expect(out.failure.message).toContain('Reload');
    }
  });

  it('rejects a non-object envelope', () => {
    for (const bad of ['string', 42, null, [], true]) {
      const out = validateRequest(bad, ctxFor(makeMockEvent(win)));
      expect(out.valid).toBe(false);
    }
  });

  it('rejects a missing or oversized request id', () => {
    expect(validateRequest(req({ id: '' }), ctxFor(makeMockEvent(win))).valid).toBe(false);
    expect(
      validateRequest(req({ id: 'x'.repeat(129) }), ctxFor(makeMockEvent(win))).valid,
    ).toBe(false);
  });

  it('rejects an unparseable issuedAt', () => {
    const out = validateRequest(req({ issuedAt: 'not-a-date' }), ctxFor(makeMockEvent(win)));
    expect(out.valid).toBe(false);
  });

  it('rejects a method that does not match the route', () => {
    // listSalesCatalog is GET-only. Without this check a POST body would reach
    // a reader that never expects one.
    const out = validateRequest(
      req({ operationId: 'listSalesCatalog', method: 'POST' }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
    if (!out.valid) expect(out.failure.code).toBe('E_ENVELOPE');
  });

  it('rejects an array where an object is expected', () => {
    const out = validateRequest(
      req({ headers: [] as unknown as Record<string, string> }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
  });
});

describe('gate 4: request schema', () => {
  it('rejects a missing tenant header', () => {
    const out = validateRequest(
      req({ headers: { 'X-Branch-Id': BRANCH } }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
    if (!out.valid) expect(out.failure.code).toBe('E_SCHEMA');
  });

  it('rejects a missing branch header on a branch-scoped operation', () => {
    const out = validateRequest(
      req({ headers: { 'X-Tenant-Id': TENANT } }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
  });

  it('enforces the uuid pattern on a path parameter', () => {
    const out = validateRequest(
      req({
        operationId: 'getSale',
        method: 'GET',
        headers: { 'X-Tenant-Id': TENANT },
        pathParams: { saleId: 'not-a-uuid' },
      }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
    if (!out.valid) expect(out.failure.code).toBe('E_SCHEMA');
  });

  it('accepts a well-formed uuid path parameter', () => {
    const out = validateRequest(
      req({
        operationId: 'getSale',
        method: 'GET',
        headers: { 'X-Tenant-Id': TENANT },
        pathParams: { saleId: BRANCH },
      }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(true);
  });

  it('rejects an unknown query parameter', () => {
    // additionalProperties: false, so a typo surfaces instead of being ignored.
    const out = validateRequest(
      req({ query: { sqlInjection: "'; DROP TABLE sales; --" } }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
  });

  it('rejects a sale with no lines', () => {
    const out = validateRequest(
      req({
        operationId: 'createSale',
        method: 'POST',
        body: { lines: [] },
      }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
  });

  it('rejects a sale with more lines than the cap', () => {
    const out = validateRequest(
      req({
        operationId: 'createSale',
        method: 'POST',
        body: {
          lines: Array.from({ length: 501 }, () => ({ itemId: BRANCH, quantity: '1' })),
        },
      }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
  });

  it('accepts a well-formed sale', () => {
    const out = validateRequest(
      req({
        operationId: 'createSale',
        method: 'POST',
        body: {
          intent: 'CONFIRM',
          lines: [{ itemId: BRANCH, quantity: '2' }],
          payments: [{ method: 'CASH', amount: '2000' }],
        },
      }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(true);
  });

  it('rejects money sent as a JSON number rather than a decimal string', () => {
    // Guards the decimal-as-string invariant at the boundary. A float here would
    // survive into the totals and drift.
    const out = validateRequest(
      req({
        operationId: 'createSale',
        method: 'POST',
        body: {
          lines: [{ itemId: BRANCH, quantity: 2 as unknown as string }],
        },
      }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
  });

  it('rejects a client phone that violates the contract pattern', () => {
    const out = validateRequest(
      req({
        operationId: 'createSale',
        method: 'POST',
        body: {
          lines: [{ itemId: BRANCH, quantity: '1' }],
          client: { phone: '+250-78-123' },
        },
      }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
  });

  it('surfaces only a sanitised hint, not the full error list', () => {
    const out = validateRequest(
      req({ headers: {} }),
      ctxFor(makeMockEvent(win)),
    );
    if (!out.valid) {
      expect(out.failure.message).toBe('Request validation failed.');
      expect(String(out.failure.details?.['hint'])).not.toContain('$.');
    }
  });
});

describe('gate 5: session scope', () => {
  it('rejects a data operation while LOCKED', () => {
    engineState.markLocked();
    const out = validateRequest(req(), ctxFor(makeMockEvent(win)));
    expect(out.valid).toBe(false);
    if (!out.valid) expect(out.failure.code).toBe('E_LOCKED');
  });

  it('rejects a data operation while HYDRATING, and marks it retryable', () => {
    // An empty catalog reads as "this shop has no stock", which is worse than an
    // honest failure the renderer can retry.
    engineState.markHydrating();
    const out = validateRequest(req(), ctxFor(makeMockEvent(win)));
    expect(out.valid).toBe(false);
    if (!out.valid) {
      expect(out.failure.code).toBe('E_HYDRATING');
      expect(out.failure.retryable).toBe(true);
    }
  });

  it('allows engineStatus while LOCKED', () => {
    engineState.markLocked();
    const out = validateRequest(
      req({ operationId: 'engineStatus', method: 'GET', headers: {} }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(true);
  });

  it('allows engineUnlock while LOCKED', () => {
    engineState.markLocked();
    const out = validateRequest(
      req({
        operationId: 'engineUnlock',
        method: 'POST',
        headers: {},
        body: { passphrase: 'correct horse battery staple' },
      }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(true);
  });

  it('keeps selling available in PUSH_ONLY', () => {
    // The whole point of PUSH_ONLY: an outdated client still trades.
    engineState.markPushOnly('client below minimum contract version');
    expect(validateRequest(req(), ctxFor(makeMockEvent(win))).valid).toBe(true);
  });

  it('allows reads but not writes while DRAINING', () => {
    engineState.markDraining();
    expect(validateRequest(req(), ctxFor(makeMockEvent(win))).valid).toBe(true);

    const write = validateRequest(
      req({
        operationId: 'createSale',
        method: 'POST',
        body: { lines: [{ itemId: BRANCH, quantity: '1' }] },
      }),
      ctxFor(makeMockEvent(win)),
    );
    expect(write.valid).toBe(false);
  });

  it('rejects everything data-related in FATAL', () => {
    engineState.markFatal('database corrupt');
    expect(validateRequest(req(), ctxFor(makeMockEvent(win))).valid).toBe(false);
  });
});

describe('gate 6: size and rate', () => {
  it('rejects an oversized request', () => {
    // Uses engineSyncNow because its body schema is unconstrained, so the
    // request reaches gate 6. A field with a maxLength would be caught by gate 4
    // first, which is correct but tests the wrong gate.
    const out = validateRequest(
      req({
        operationId: 'engineSyncNow',
        method: 'POST',
        headers: {},
        body: { blob: 'x'.repeat(300_000) },
      }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
    if (!out.valid) {
      expect(out.failure.code).toBe('E_RATE_LIMIT');
      expect(out.failure.details?.['bytes']).toBeGreaterThan(262_144);
    }
  });

  it('lets gate 4 catch an oversized constrained field before gate 6', () => {
    // Ordering check: `search` has maxLength 200, so this is a schema failure and
    // must not be charged against the rate budget.
    const out = validateRequest(
      req({ query: { search: 'x'.repeat(300_000) } }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(false);
    if (!out.valid) expect(out.failure.code).toBe('E_SCHEMA');
  });

  it('enforces the per-operation rate limit', () => {
    // engineUnlock is capped at 10/min to blunt passphrase guessing.
    const unlockReq = () =>
      validateRequest(
        req({
          operationId: 'engineUnlock',
          method: 'POST',
          headers: {},
          body: { passphrase: 'guess' },
        }),
        ctxFor(makeMockEvent(win)),
      );

    for (let i = 0; i < 10; i++) expect(unlockReq().valid).toBe(true);

    const blocked = unlockReq();
    expect(blocked.valid).toBe(false);
    if (!blocked.valid) {
      expect(blocked.failure.code).toBe('E_RATE_LIMIT');
      expect(blocked.failure.retryable).toBe(true);
      expect(blocked.failure.details?.['retryAfterSec']).toBeGreaterThan(0);
    }
  });

  it('does not charge the rate limit for a schema failure', () => {
    // Gate 6 runs after gate 4 precisely so a buggy renderer cannot exhaust a
    // real user's budget by sending malformed requests.
    for (let i = 0; i < 40; i++) {
      const out = validateRequest(
        req({
          operationId: 'engineUnlock',
          method: 'POST',
          headers: {},
          body: { passphrase: '' }, // minLength: 1
        }),
        ctxFor(makeMockEvent(win)),
      );
      expect(out.valid).toBe(false);
      if (!out.valid) expect(out.failure.code).toBe('E_SCHEMA');
    }

    // The budget is untouched, so a legitimate attempt still gets through.
    const good = validateRequest(
      req({
        operationId: 'engineUnlock',
        method: 'POST',
        headers: {},
        body: { passphrase: 'real passphrase' },
      }),
      ctxFor(makeMockEvent(win)),
    );
    expect(good.valid).toBe(true);
  });

  it('keeps rate budgets independent per operation', () => {
    for (let i = 0; i < 10; i++) {
      validateRequest(
        req({
          operationId: 'engineUnlock',
          method: 'POST',
          headers: {},
          body: { passphrase: 'guess' },
        }),
        ctxFor(makeMockEvent(win)),
      );
    }
    // Exhausting unlock must not stop the cashier searching the catalog.
    expect(validateRequest(req(), ctxFor(makeMockEvent(win))).valid).toBe(true);
  });
});

describe('scope extraction', () => {
  it('carries tenant, branch, and idempotency key into the context', () => {
    const out = validateRequest(
      req({
        operationId: 'createSale',
        method: 'POST',
        headers: {
          'X-Tenant-Id': TENANT,
          'X-Branch-Id': BRANCH,
          'Idempotency-Key': 'idem-1',
        },
        body: { lines: [{ itemId: BRANCH, quantity: '1' }] },
      }),
      ctxFor(makeMockEvent(win)),
    );

    expect(out.valid).toBe(true);
    if (out.valid) {
      expect(out.ctx.tenantId).toBe(TENANT);
      expect(out.ctx.branchId).toBe(BRANCH);
      expect(out.ctx.idempotencyKey).toBe('idem-1');
    }
  });

  it('leaves branchId undefined for a tenant-scoped operation', () => {
    const out = validateRequest(
      req({ operationId: 'listTaxCategories', method: 'GET', headers: { 'X-Tenant-Id': TENANT } }),
      ctxFor(makeMockEvent(win)),
    );
    expect(out.valid).toBe(true);
    if (out.valid) expect(out.ctx.branchId).toBeUndefined();
  });
});

describe('error shaping', () => {
  it('maps each error code to a plausible HTTP status', () => {
    expect(
      buildErrorResponse({ code: 'E_LOCKED', message: 'x', retryable: false }, 'r1').status,
    ).toBe(423);
    expect(
      buildErrorResponse({ code: 'E_RATE_LIMIT', message: 'x', retryable: true }, 'r1').status,
    ).toBe(429);
    expect(
      buildErrorResponse({ code: 'E_HYDRATING', message: 'x', retryable: true }, 'r1').status,
    ).toBe(503);
    expect(
      buildErrorResponse({ code: 'E_CONFLICT', message: 'x', retryable: false }, 'r1').status,
    ).toBe(409);
  });

  it('preserves the request id so the renderer can correlate', () => {
    const err = buildErrorResponse({ code: 'E_SCHEMA', message: 'x', retryable: false }, 'req-9');
    expect(err.id).toBe('req-9');
    expect(err.ok).toBe(false);
  });

  it('falls back to a placeholder id when the envelope had none', () => {
    expect(
      buildErrorResponse({ code: 'E_ENVELOPE', message: 'x', retryable: false }).id,
    ).toBe('unknown');
  });
});
