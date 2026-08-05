/**
 * Request JSON Schemas for gate 4.
 *
 * GENERATOR TARGET.  Constraints are transcribed from the contract's parameter
 * definitions and request-body schemas, including the `minimum` / `maximum` /
 * `maxLength` values already declared there.
 *
 * ─── Why requests only ───────────────────────────────────────────────────────
 * Response schemas are deliberately NOT shipped.  A response is produced by our
 * own main process from our own SQLite, so validating it in production means
 * validating ourselves — it costs bytes and CPU to catch a class of bug that a
 * unit test catches for free.  Response schemas are the single largest
 * generated artifact because they transitively pull in deep model graphs, so
 * omitting them is what keeps the bundle at ~130 KB (plan §8.3).
 *
 * The generator still emits them, gated behind a dev-only entry point, so
 * `npm run dev` can assert that local responses match the contract exactly.
 * That is where contract drift gets caught: in development, loudly.
 *
 * Query parameters arrive as strings over IPC (they came off a URL), so numeric
 * params are typed `string` with a `pattern` rather than `integer`. Coercion
 * happens once, in the generated reader, after validation.
 */

import type { JsonSchema } from './json-schema';
import { LOG_COMPONENTS, LOG_LEVELS, LOG_SOURCES } from './log-vocabulary';

// ---------------------------------------------------------------------------
// Reusable fragments
// ---------------------------------------------------------------------------

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const uuidParam: JsonSchema = { type: 'string', pattern: UUID_PATTERN };

/** Non-negative integer as a string, e.g. a page index off a query string. */
const intParam: JsonSchema = { type: 'string', pattern: '^[0-9]{1,9}$' };

/** Decimal as a string. Money and quantities never travel as JSON numbers. */
const decimal: JsonSchema = { type: 'string', pattern: '^-?[0-9]{1,15}(\\.[0-9]{1,6})?$' };

const boolParam: JsonSchema = { type: 'string', enum: ['true', 'false'] };

/**
 * The scope headers every offline operation carries.  `X-Tenant-Id` is always
 * required; `X-Branch-Id` is required only by branch-scoped operations, which
 * is why it is not in this shared fragment.
 */
const tenantHeader: JsonSchema = {
  type: 'object',
  required: ['X-Tenant-Id'],
  properties: {
    'X-Tenant-Id': { type: 'string', minLength: 1, maxLength: 50 },
    'X-Branch-Id': uuidParam,
    'Idempotency-Key': { type: 'string', minLength: 1, maxLength: 100 },
  },
};

const branchHeader: JsonSchema = {
  type: 'object',
  required: ['X-Tenant-Id', 'X-Branch-Id'],
  properties: tenantHeader.properties,
};

/** Shared page/size pair, matching the contract's declared bounds. */
const pageParams: Record<string, JsonSchema> = {
  page: intParam,
  size: intParam,
};

// ---------------------------------------------------------------------------
// Per-operation request schemas
// ---------------------------------------------------------------------------

export const REQUEST_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  // --- listSalesCatalog  GET /core/sales/catalog -------------------------
  listSalesCatalog: {
    type: 'object',
    required: ['headers'],
    additionalProperties: false,
    properties: {
      headers: branchHeader,
      pathParams: { type: 'object' },
      query: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...pageParams,
          search: { type: 'string', maxLength: 200 },
          categoryId: uuidParam,
          sellMode: { type: 'string', enum: ['IN_STOCK', 'MADE_TO_ORDER'] },
          includeOutOfStock: boolParam,
        },
      },
    },
  },

  // --- listStockBalances  GET /core/stock-balances ------------------------
  listStockBalances: {
    type: 'object',
    required: ['headers'],
    additionalProperties: false,
    properties: {
      headers: branchHeader,
      pathParams: { type: 'object' },
      query: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...pageParams,
          search: { type: 'string', maxLength: 200 },
          stockStatus: {
            type: 'string',
            enum: ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK'],
          },
        },
      },
    },
  },

  // --- lookupStockBalance  GET /core/stock-balances/lookup ---------------
  lookupStockBalance: {
    type: 'object',
    required: ['headers', 'query'],
    additionalProperties: false,
    properties: {
      headers: branchHeader,
      pathParams: { type: 'object' },
      query: {
        type: 'object',
        additionalProperties: false,
        properties: {
          barcode: { type: 'string', maxLength: 100 },
          itemCode: { type: 'string', maxLength: 100 },
          itemId: uuidParam,
        },
      },
    },
  },

  // --- listTaxCategories  GET /core/tax-categories -----------------------
  listTaxCategories: {
    type: 'object',
    required: ['headers'],
    additionalProperties: false,
    properties: {
      headers: tenantHeader,
      pathParams: { type: 'object' },
      query: {
        type: 'object',
        additionalProperties: false,
        properties: { ...pageParams, search: { type: 'string', maxLength: 200 } },
      },
    },
  },

  // --- getTaxCategory  GET /core/tax-categories/{taxCategoryId} ----------
  getTaxCategory: {
    type: 'object',
    required: ['headers', 'pathParams'],
    additionalProperties: false,
    properties: {
      headers: tenantHeader,
      query: { type: 'object' },
      pathParams: {
        type: 'object',
        required: ['taxCategoryId'],
        additionalProperties: false,
        properties: { taxCategoryId: uuidParam },
      },
    },
  },

  // --- listCustomers  GET /core/customers --------------------------------
  listCustomers: {
    type: 'object',
    required: ['headers'],
    additionalProperties: false,
    properties: {
      headers: tenantHeader,
      pathParams: { type: 'object' },
      query: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...pageParams,
          search: { type: 'string', maxLength: 200 },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
        },
      },
    },
  },

  // --- getCustomer  GET /core/customers/{customerId} ---------------------
  getCustomer: {
    type: 'object',
    required: ['headers', 'pathParams'],
    additionalProperties: false,
    properties: {
      headers: tenantHeader,
      query: { type: 'object' },
      pathParams: {
        type: 'object',
        required: ['customerId'],
        additionalProperties: false,
        properties: { customerId: uuidParam },
      },
    },
  },

  // --- createCustomer  POST /core/customers ------------------------------
  // Constraints from CreateCustomerRequest.
  createCustomer: {
    type: 'object',
    required: ['headers', 'body'],
    additionalProperties: false,
    properties: {
      headers: tenantHeader,
      pathParams: { type: 'object' },
      query: { type: 'object' },
      body: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 150 },
          tin: { type: 'string', maxLength: 50 },
          primaryPhone: { type: 'string', maxLength: 20 },
          secondaryPhone: { type: 'string', maxLength: 20 },
          email: { type: 'string', maxLength: 150 },
          address: { type: 'string', maxLength: 500 },
        },
      },
    },
  },

  // --- createSale  POST /core/sales --------------------------------------
  // Constraints from CreateSaleRequest + CreateSaleLineRequest, including the
  // contract's own `minItems: 1` on lines and 0..100 on discountPercentage.
  createSale: {
    type: 'object',
    required: ['headers', 'body'],
    additionalProperties: false,
    properties: {
      headers: branchHeader,
      pathParams: { type: 'object' },
      query: { type: 'object' },
      body: {
        type: 'object',
        required: ['lines'],
        additionalProperties: false,
        properties: {
          intent: { type: 'string', enum: ['DRAFT', 'CONFIRM'] },
          customerId: uuidParam,
          client: {
            type: 'object',
            additionalProperties: false,
            properties: {
              fullName: { type: 'string', maxLength: 150 },
              tin: { type: 'string', maxLength: 50 },
              // Contract pattern: ^[0-9]{0,14}$
              phone: { type: 'string', pattern: '^[0-9]{0,14}$' },
            },
          },
          payments: {
            type: 'array',
            maxItems: 10,
            items: {
              type: 'object',
              required: ['method', 'amount'],
              additionalProperties: false,
              properties: {
                method: {
                  type: 'string',
                  enum: ['CASH', 'BANK', 'MOBILE_MONEY', 'CREDIT'],
                },
                amount: decimal,
              },
            },
          },
          creditDueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          deviceId: { type: 'string', maxLength: 100 },
          currencyCode: { type: 'string', minLength: 3, maxLength: 3 },
          lines: {
            type: 'array',
            minItems: 1,
            // Not in the contract. A local cap bounds the transaction size and
            // keeps one sale inside the 1 MB push batch limit.
            maxItems: 500,
            items: {
              type: 'object',
              required: ['itemId', 'quantity'],
              additionalProperties: false,
              properties: {
                itemId: uuidParam,
                batchId: uuidParam,
                quantity: decimal,
                unitPrice: decimal,
                discountPercentage: {
                  type: 'string',
                  pattern: '^(100(\\.0{1,6})?|[0-9]{1,2}(\\.[0-9]{1,6})?)$',
                },
              },
            },
          },
        },
      },
    },
  },

  // --- listSales  GET /core/sales ----------------------------------------
  listSales: {
    type: 'object',
    required: ['headers'],
    additionalProperties: false,
    properties: {
      headers: tenantHeader,
      pathParams: { type: 'object' },
      query: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...pageParams,
          branchId: uuidParam,
          customerId: uuidParam,
          paymentMethod: {
            type: 'string',
            enum: ['CASH', 'BANK', 'MOBILE_MONEY', 'CREDIT'],
          },
          search: { type: 'string', maxLength: 200 },
          status: {
            type: 'string',
            enum: [
              'DRAFT',
              'CONFIRMED',
              'CREDITED',
              'CANCELLED',
              'EXPIRED',
              'REFUNDED',
            ],
          },
          fromDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          toDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        },
      },
    },
  },

  // --- getSale  GET /core/sales/{saleId} ---------------------------------
  getSale: {
    type: 'object',
    required: ['headers', 'pathParams'],
    additionalProperties: false,
    properties: {
      headers: tenantHeader,
      query: { type: 'object' },
      pathParams: {
        type: 'object',
        required: ['saleId'],
        additionalProperties: false,
        properties: { saleId: uuidParam },
      },
    },
  },

  // --- confirmSale  POST /core/sales/{saleId}/confirm --------------------
  confirmSale: {
    type: 'object',
    required: ['headers', 'pathParams'],
    additionalProperties: false,
    properties: {
      headers: branchHeader,
      query: { type: 'object' },
      pathParams: {
        type: 'object',
        required: ['saleId'],
        additionalProperties: false,
        properties: { saleId: uuidParam },
      },
      body: { type: 'object' },
    },
  },

  // --- cancelSale  POST /core/sales/{saleId}/cancel ----------------------
  cancelSale: {
    type: 'object',
    required: ['headers', 'pathParams'],
    additionalProperties: false,
    properties: {
      headers: branchHeader,
      query: { type: 'object' },
      pathParams: {
        type: 'object',
        required: ['saleId'],
        additionalProperties: false,
        properties: { saleId: uuidParam },
      },
      body: { type: 'object' },
    },
  },

  // --- listReceipts  GET /core/receipts ----------------------------------
  listReceipts: {
    type: 'object',
    required: ['headers'],
    additionalProperties: false,
    properties: {
      headers: tenantHeader,
      pathParams: { type: 'object' },
      query: {
        type: 'object',
        additionalProperties: false,
        properties: { ...pageParams, search: { type: 'string', maxLength: 200 } },
      },
    },
  },

  // --- getReceipt  GET /core/receipts/{receiptNumber} --------------------
  getReceipt: {
    type: 'object',
    required: ['headers', 'pathParams'],
    additionalProperties: false,
    properties: {
      headers: tenantHeader,
      query: { type: 'object' },
      pathParams: {
        type: 'object',
        required: ['receiptNumber'],
        additionalProperties: false,
        properties: { receiptNumber: { type: 'string', maxLength: 60 } },
      },
    },
  },

  // --- engine-local operations -------------------------------------------
  engineUnlock: {
    type: 'object',
    required: ['body'],
    additionalProperties: false,
    properties: {
      headers: { type: 'object' },
      pathParams: { type: 'object' },
      query: { type: 'object' },
      body: {
        type: 'object',
        required: ['passphrase'],
        additionalProperties: false,
        properties: {
          // Upper bound guards against a pathological PBKDF2 input; 600k
          // iterations over a megabyte-long passphrase would hang the process.
          passphrase: { type: 'string', minLength: 1, maxLength: 1024 },
        },
      },
    },
  },

  engineSignIn: {
    type: 'object',
    required: ['body'],
    additionalProperties: false,
    properties: {
      headers: tenantHeader,
      pathParams: { type: 'object', additionalProperties: false },
      query: { type: 'object', additionalProperties: false },
      body: {
        type: 'object',
        required: ['email', 'password', 'subdomainSlug'],
        additionalProperties: false,
        properties: {
          email: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 1 },
          subdomainSlug: { type: 'string', minLength: 1 },
        },
      },
    },
  },

  engineStatus: {
    type: 'object',
    additionalProperties: false,
    properties: {
      headers: { type: 'object' },
      pathParams: { type: 'object' },
      query: { type: 'object' },
    },
  },

  engineSyncNow: {
    type: 'object',
    additionalProperties: false,
    properties: {
      headers: { type: 'object' },
      pathParams: { type: 'object' },
      query: { type: 'object' },
      body: { type: 'object' },
    },
  },

  // --- listSystemLogs  GET /_engine/logs ---------------------------------
  listSystemLogs: {
    type: 'object',
    additionalProperties: false,
    properties: {
      headers: { type: 'object' },
      pathParams: { type: 'object', additionalProperties: false },
      query: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...pageParams,
          level: { type: 'string', enum: [...LOG_LEVELS] },
          component: { type: 'string', enum: [...LOG_COMPONENTS] },
          source: { type: 'string', enum: [...LOG_SOURCES] },
          logger: { type: 'string', maxLength: 120 },
          requestId: { type: 'string', maxLength: 100 },
          search: { type: 'string', maxLength: 200 },
          fromDate: { type: 'string', maxLength: 40 },
          toDate: { type: 'string', maxLength: 40 },
        },
      },
    },
  },

  // --- writeSystemLogs  POST /_engine/logs -------------------------------
  //
  // The only operation whose input is written to disk more or less verbatim,
  // so every field is bounded. An unbounded `message` from a compromised
  // renderer is a way to fill the device's disk, and an unbounded `context` is
  // a way to hide a payload in a table nobody reads.
  writeSystemLogs: {
    type: 'object',
    required: ['body'],
    additionalProperties: false,
    properties: {
      headers: { type: 'object' },
      pathParams: { type: 'object', additionalProperties: false },
      query: { type: 'object', additionalProperties: false },
      body: {
        type: 'object',
        required: ['entries'],
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              required: ['level', 'logger', 'message'],
              additionalProperties: false,
              properties: {
                loggedAt: { type: 'string', maxLength: 40 },
                level: { type: 'string', enum: [...LOG_LEVELS] },
                component: { type: 'string', enum: [...LOG_COMPONENTS] },
                logger: { type: 'string', minLength: 1, maxLength: 120 },
                message: { type: 'string', minLength: 1, maxLength: 4000 },
                exception: { type: 'string', maxLength: 8000 },
                userName: { type: 'string', maxLength: 200 },
                url: { type: 'string', maxLength: 1000 },
                requestId: { type: 'string', maxLength: 100 },
                code: { type: 'string', maxLength: 60 },
                thread: { type: 'string', maxLength: 60 },
                context: { type: 'object' },
              },
            },
          },
        },
      },
    },
  },
};

export function requestSchemaFor(operationId: string): JsonSchema | undefined {
  return REQUEST_SCHEMAS[operationId];
}
