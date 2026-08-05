/**
 * Local mock of the Bizuri API.
 *
 * Serves the real contract shapes on localhost so the whole POC can be driven end
 * to end without the upstream environment. Two reasons this earns its place:
 *
 *   1. The testing host is returning Cloudflare 525, and waiting on someone
 *      else's infrastructure to make progress is a bad trade.
 *   2. Even when it is up, a shared environment is a poor place to test offline
 *      behaviour: you cannot pull its network cable, and you should not create a
 *      hundred junk sales in it to test batching.
 *
 * Every response shape here is transcribed from bizuri-core-api-contract.yaml at
 * 1.2.29, including the two different envelopes (bare page for catalog and stock,
 * SuccessResponse wrapper for tax categories and customers) and the absence of
 * `updatedAt` on SalesCatalogItem. Faithfulness is the point: if the mock is more
 * convenient than the real thing, it stops being a useful test.
 *
 *   npm run mock:api                 listens on 4300
 *   MOCK_PORT=5000 npm run mock:api
 *   MOCK_LATENCY=250 npm run mock:api    add 250ms per request
 *   MOCK_CATALOG_SIZE=5000 npm run mock:api
 *
 * Control endpoints (not part of the real API, prefixed to make that obvious):
 *   POST /__mock/offline      start refusing every request
 *   POST /__mock/online       resume
 *   POST /__mock/fail/:n      fail the next n requests with 503
 *   GET  /__mock/state        counters, request log, created sales
 *   POST /__mock/reset        clear created sales and counters
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env['MOCK_PORT'] ?? 4300);
const LATENCY_MS = Number(process.env['MOCK_LATENCY'] ?? 0);
const CATALOG_SIZE = Number(process.env['MOCK_CATALOG_SIZE'] ?? 60);

const TENANT_ID = 'mock-tenant';
const BRANCH_ID = '11111111-2222-4333-8444-555555555555';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface CreatedSale {
  id: string;
  saleNumber: string;
  idempotencyKey: string | null;
  grandTotal: number;
  lines: number;
  createdAt: string;
}

const state = {
  offline: false,
  failNext: 0,
  requestCount: 0,
  requestLog: [] as { at: string; method: string; path: string; key?: string }[],
  sales: [] as CreatedSale[],
  salesByKey: new Map<string, CreatedSale>(),
  saleCounter: 0,
};

// ---------------------------------------------------------------------------
// Seed catalog
//
// Deterministic, so a run is reproducible. A third of items are zero-rated and a
// few are MADE_TO_ORDER, because both paths need exercising: zero-rated proves
// the tax extraction does not invent tax, and made-to-order proves stock
// validation is correctly skipped.
// ---------------------------------------------------------------------------

const PRODUCTS = [
  'Fanta Orange 500ml', 'Coca-Cola 500ml', 'Inyange Milk 1L', 'Bread Loaf',
  'Sugar 1kg', 'Rice 5kg', 'Cooking Oil 2L', 'Blue Band 500g',
  'Nido 400g', 'Tea Leaves 250g', 'Maize Flour 2kg', 'Beans 1kg',
  'Soap Bar', 'Toothpaste 100ml', 'Washing Powder 1kg', 'Matches',
  'Candles 6pk', 'Batteries AA', 'Exercise Book', 'Blue Pen',
];

function seedCatalog(): CatalogItem[] {
  const items: CatalogItem[] = [];

  for (let i = 0; i < CATALOG_SIZE; i++) {
    const name = PRODUCTS[i % PRODUCTS.length] as string;
    const suffix = i >= PRODUCTS.length ? ` #${Math.floor(i / PRODUCTS.length) + 1}` : '';
    const madeToOrder = i % 17 === 0;
    const zeroRated = i % 3 === 0;

    items.push({
      itemId: uuidFromIndex(i),
      itemCode: `ITM-${String(i + 1).padStart(4, '0')}`,
      itemName: name + suffix,
      barcode: i % 5 === 0 ? `50${String(i).padStart(11, '0')}` : null,
      businessType: 'FINISHED_PRODUCT',
      isVariant: false,
      parentItemId: null,
      sellMode: madeToOrder ? 'MADE_TO_ORDER' : 'IN_STOCK',
      stockStatus: madeToOrder ? null : 'IN_STOCK',
      // Deliberately generous, so a demo does not hit a stock wall mid-flow.
      availableQty: madeToOrder ? null : 100 + (i % 50),
      sellingPrice: 200 + i * 50,
      discount: i % 7 === 0 ? 5 : null,
      taxCategoryName: zeroRated ? null : 'VAT 18%',
      taxCategoryRate: zeroRated ? 0 : 18,
      unitOfMeasureName: 'Each',
      currentBatchId: madeToOrder ? null : uuidFromIndex(1000 + i),
      // NOTE: no `updatedAt` and no `deleted`. The real contract omits them
      // (gaps #1 and #2), and adding them here would hide the cost of that.
    });
  }

  return items;
}

interface CatalogItem {
  itemId: string;
  itemCode: string;
  itemName: string;
  barcode: string | null;
  businessType: string;
  isVariant: boolean;
  parentItemId: string | null;
  sellMode: string;
  stockStatus: string | null;
  availableQty: number | null;
  sellingPrice: number;
  discount: number | null;
  taxCategoryName: string | null;
  taxCategoryRate: number;
  unitOfMeasureName: string;
  currentBatchId: string | null;
}

/** Stable pseudo-uuid from an index, so ids do not change between runs. */
function uuidFromIndex(i: number): string {
  const hex = i.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

const CATALOG = seedCatalog();

const TAX_CATEGORIES = [
  {
    id: uuidFromIndex(90001),
    name: 'VAT 18%',
    rate: 18,
    description: 'Standard rate',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: uuidFromIndex(90002),
    name: 'Zero rated',
    rate: 0,
    description: 'Exempt goods',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const CUSTOMERS = Array.from({ length: 12 }, (_, i) => ({
  id: uuidFromIndex(80000 + i),
  name: `Customer ${i + 1}`,
  tin: i % 2 === 0 ? `10${String(i).padStart(7, '0')}` : null,
  primaryPhone: `07880000${String(i).padStart(2, '0')}`,
  secondaryPhone: null,
  email: null,
  address: null,
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}));

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

function barePage<T>(all: readonly T[], page: number, size: number) {
  const start = page * size;
  const slice = all.slice(start, start + size);
  const totalPages = Math.max(1, Math.ceil(all.length / size));

  return {
    data: slice,
    page,
    size,
    totalElements: all.length,
    totalPages,
    hasNext: page + 1 < totalPages,
    hasPrevious: page > 0,
  };
}

function wrappedPage<T>(all: readonly T[], page: number, size: number) {
  const start = page * size;
  const slice = all.slice(start, start + size);
  const totalPages = Math.max(1, Math.ceil(all.length / size));

  return {
    success: true,
    message: 'Request successful',
    data: slice,
    meta: { page, size, totalElements: all.length, totalPages },
  };
}

const wrapped = (data: unknown) => ({ success: true, message: 'Request successful', data });

const errorBody = (status: number, message: string, errorCode: string) => ({
  success: false,
  message,
  errorCode,
  statusCode: status,
  timestamp: new Date().toISOString(),
  validationErrors: [],
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const key = (req.headers['idempotency-key'] as string | undefined) ?? null;

  state.requestCount++;
  state.requestLog.push({
    at: new Date().toISOString(),
    method,
    path,
    ...(key ? { key } : {}),
  });
  if (state.requestLog.length > 500) state.requestLog.shift();

  // --- control plane (always available, even when "offline") -------------
  if (path.startsWith('/__mock/')) return handleControl(path, method, res);

  if (LATENCY_MS > 0) await sleep(LATENCY_MS);

  // --- simulated outage ---------------------------------------------------
  if (state.offline) {
    // Destroying the socket rather than answering: a refused connection is what
    // a real outage looks like to the client, and it is what exercises the
    // engine's OfflineError path. A 503 would exercise the retry path instead.
    res.socket?.destroy();
    return;
  }

  if (state.failNext > 0) {
    state.failNext--;
    return json(res, 503, errorBody(503, 'Service temporarily unavailable', 'SERVICE_UNAVAILABLE'));
  }

  const page = Number(url.searchParams.get('page') ?? '0');
  const size = Math.min(Number(url.searchParams.get('size') ?? '20'), 100);

  // --- health -------------------------------------------------------------
  if (path === '/actuator/health') {
    return json(res, 200, { status: 'UP' });
  }

  // --- auth ---------------------------------------------------------------
  if (path === '/identity/auth/login' && method === 'POST') {
    const body = await readJson(req);
    const { email, password, subdomainSlug } = (body ?? {}) as Record<string, string>;

    if (!email || !password || !subdomainSlug) {
      return json(res, 400, errorBody(400, 'email, password and subdomainSlug are required', 'VALIDATION_ERROR'));
    }
    // Mirrors the contract's minLength: 12 on password, so a too-short password
    // fails here the same way it would upstream.
    if (password.length < 12) {
      return json(res, 400, errorBody(400, 'Password must be at least 12 characters', 'VALIDATION_ERROR'));
    }

    return json(res, 200, wrapped({
      mfaRequired: false,
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      tenantId: TENANT_ID,
      branchId: BRANCH_ID,
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 604800,
      userId: uuidFromIndex(70001),
      displayName: 'Mock Cashier',
      roles: ['CASHIER'],
      permissions: ['SALE_CREATE'],
      businessSectors: ['RETAIL'],
    }));
  }

  if (path === '/identity/auth/token/refresh' && method === 'POST') {
    return json(res, 200, wrapped({
      accessToken: 'mock-access-token-refreshed',
      refreshToken: 'mock-refresh-token',
      accessTokenExpiresIn: 900,
    }));
  }

  // --- catalog: BARE page envelope ---------------------------------------
  if (path === '/core/sales/catalog' && method === 'GET') {
    const search = (url.searchParams.get('search') ?? '').toLowerCase();
    const filtered = search
      ? CATALOG.filter(
          (i) =>
            i.itemName.toLowerCase().includes(search) ||
            i.itemCode.toLowerCase().includes(search) ||
            (i.barcode ?? '').includes(search),
        )
      : CATALOG;
    return json(res, 200, barePage(filtered, page, size));
  }

  // --- stock: BARE page envelope -----------------------------------------
  if (path === '/core/stock-balances' && method === 'GET') {
    const balances = CATALOG.filter((i) => i.sellMode === 'IN_STOCK').map((i) => ({
      itemId: i.itemId,
      itemCode: i.itemCode,
      itemName: i.itemName,
      businessType: i.businessType,
      branchId: BRANCH_ID,
      branchName: 'Main Branch',
      onHandQty: i.availableQty ?? 0,
      reservedQty: 0,
      availableQty: i.availableQty ?? 0,
      hasVariants: false,
      hasBatches: i.currentBatchId !== null,
      defaultSellingPrice: i.sellingPrice,
      discount: i.discount,
      taxCategoryName: i.taxCategoryName,
      taxCategoryRate: i.taxCategoryRate,
      batchId: i.currentBatchId,
      expired: false,
    }));
    return json(res, 200, barePage(balances, page, size));
  }

  // --- tax categories: WRAPPED envelope ----------------------------------
  if (path === '/core/tax-categories' && method === 'GET') {
    return json(res, 200, wrappedPage(TAX_CATEGORIES, page, size));
  }

  // --- customers: WRAPPED envelope ---------------------------------------
  if (path === '/core/customers' && method === 'GET') {
    return json(res, 200, wrappedPage(CUSTOMERS, page, size));
  }

  if (path === '/core/customers' && method === 'POST') {
    const body = (await readJson(req)) as { name?: string };
    if (!body?.name) {
      return json(res, 400, errorBody(400, 'name is required', 'VALIDATION_ERROR'));
    }
    return json(res, 201, wrapped({
      id: uuidFromIndex(60000 + CUSTOMERS.length + state.saleCounter),
      name: body.name,
      tin: null,
      primaryPhone: null,
      secondaryPhone: null,
      email: null,
      address: null,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  // --- create sale, with real idempotency semantics ----------------------
  if (path === '/core/sales' && method === 'POST') {
    const body = (await readJson(req)) as {
      lines?: { itemId: string; quantity: number }[];
      payments?: { method: string; amount: number }[];
    };

    if (!body?.lines || body.lines.length === 0) {
      return json(res, 400, errorBody(400, 'A sale must have at least one line', 'VALIDATION_ERROR'));
    }

    // The contract's stated behaviour: "a repeat with the same key returns the
    // original sale without deducting again."
    if (key && state.salesByKey.has(key)) {
      const original = state.salesByKey.get(key) as CreatedSale;
      return json(res, 200, wrapped(saleResponse(original, body)));
    }

    state.saleCounter++;
    const sale: CreatedSale = {
      id: uuidFromIndex(50000 + state.saleCounter),
      saleNumber: `INV-${String(state.saleCounter).padStart(6, '0')}`,
      idempotencyKey: key,
      grandTotal: (body.payments ?? []).reduce((n, p) => n + Number(p.amount || 0), 0),
      lines: body.lines.length,
      createdAt: new Date().toISOString(),
    };

    state.sales.push(sale);
    if (key) state.salesByKey.set(key, sale);

    return json(res, 201, wrapped(saleResponse(sale, body)));
  }

  if (path === '/core/sales' && method === 'GET') {
    return json(res, 200, wrappedPage(state.sales, page, size));
  }

  return json(res, 404, errorBody(404, `No route for ${method} ${path}`, 'RESOURCE_NOT_FOUND'));
}

function saleResponse(
  sale: CreatedSale,
  body: { lines?: { itemId: string; quantity: number }[] },
) {
  return {
    id: sale.id,
    saleNumber: sale.saleNumber,
    branchId: BRANCH_ID,
    status: 'CONFIRMED',
    customerId: null,
    payments: [],
    deviceId: null,
    creditDueDate: null,
    subtotal: sale.grandTotal,
    discountTotal: 0,
    taxTotal: 0,
    grandTotal: sale.grandTotal,
    amountPaid: sale.grandTotal,
    changeGiven: 0,
    balanceDue: 0,
    totalItems: sale.lines,
    confirmedAt: sale.createdAt,
    createdAt: sale.createdAt,
    currencyCode: 'RWF',
    lines: (body.lines ?? []).map((l, i) => ({
      id: uuidFromIndex(40000 + i),
      itemId: l.itemId,
      itemName: CATALOG.find((c) => c.itemId === l.itemId)?.itemName ?? 'Item',
      batchId: null,
      quantity: l.quantity,
      unitPrice: 0,
      discountAmount: 0,
      taxAmount: 0,
      lineSubtotal: 0,
      lineTotal: 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

function handleControl(path: string, method: string, res: ServerResponse): void {
  if (path === '/__mock/offline' && method === 'POST') {
    state.offline = true;
    console.log('  → OFFLINE: connections will be refused');
    return json(res, 200, { offline: true });
  }

  if (path === '/__mock/online' && method === 'POST') {
    state.offline = false;
    console.log('  → ONLINE');
    return json(res, 200, { offline: false });
  }

  const failMatch = /^\/__mock\/fail\/(\d+)$/.exec(path);
  if (failMatch && method === 'POST') {
    state.failNext = Number(failMatch[1]);
    console.log(`  → next ${state.failNext} request(s) will return 503`);
    return json(res, 200, { failNext: state.failNext });
  }

  if (path === '/__mock/state') {
    return json(res, 200, {
      offline: state.offline,
      failNext: state.failNext,
      requestCount: state.requestCount,
      catalogSize: CATALOG.length,
      salesCreated: state.sales.length,
      distinctIdempotencyKeys: state.salesByKey.size,
      sales: state.sales.slice(-20),
      recentRequests: state.requestLog.slice(-30),
    });
  }

  if (path === '/__mock/reset' && method === 'POST') {
    state.sales = [];
    state.salesByKey.clear();
    state.saleCounter = 0;
    state.requestCount = 0;
    state.requestLog = [];
    state.offline = false;
    state.failNext = 0;
    console.log('  → reset');
    return json(res, 200, { reset: true });
  }

  return json(res, 404, { message: `unknown control endpoint ${path}` });
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // The renderer may call this directly during development.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    });
    res.end();
    return;
  }

  handle(req, res).catch((err) => {
    console.error('mock error:', err);
    if (!res.headersSent) json(res, 500, errorBody(500, 'Mock server error', 'INTERNAL_ERROR'));
  });
});

server.listen(PORT, () => {
  console.log(`\nBizuri mock API on http://localhost:${PORT}`);
  console.log(`  catalog     ${CATALOG.length} items`);
  console.log(`  tenant      ${TENANT_ID}`);
  console.log(`  branch      ${BRANCH_ID}`);
  if (LATENCY_MS > 0) console.log(`  latency     ${LATENCY_MS}ms per request`);
  console.log('\nAny email works. Password must be at least 12 characters (contract minLength).');
  console.log('\nControl:');
  console.log(`  curl -X POST localhost:${PORT}/__mock/offline`);
  console.log(`  curl -X POST localhost:${PORT}/__mock/online`);
  console.log(`  curl -X POST localhost:${PORT}/__mock/fail/2`);
  console.log(`  curl -s localhost:${PORT}/__mock/state | jq\n`);
});
