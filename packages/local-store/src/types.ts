/**
 * Local-store descriptor types.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE DEFINES THE CONTRACT THAT `bizuri-sqlite` CODEGEN MUST SATISFY.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything in this package is hand-written for the sales slice so the runtime
 * shape can be proven before the Java generator is written.  Once the generator
 * exists in `BIZURI-API-Contract/bizuri-codegen`, its output replaces
 * `tables.ts`, `rows.ts`, `mappers.ts`, `routes.ts`, `schemas.ts`, and
 * `manifest.ts` — and the diff against the hand-written version must be empty.
 *
 * Every descriptor field below maps to something the generator can read out of
 * the OpenAPI document.  Nothing here requires human judgement at generation
 * time; that is the design constraint.  If a field cannot be derived
 * mechanically from the spec, it does not belong in this file.
 *
 *   OpenAPI source                       →  descriptor field
 *   ───────────────────────────────────────────────────────────────────────────
 *   x-offline.table                      →  TableDescriptor.table
 *   x-offline.mode                       →  TableDescriptor.mode
 *   x-offline.primaryKey                 →  TableDescriptor.primaryKey
 *   x-offline.watermark                  →  TableDescriptor.watermark
 *   x-offline.scope                      →  TableDescriptor.scope
 *   x-offline.indexes                    →  TableDescriptor.indexes
 *   x-offline.children[k]                →  TableDescriptor.parent on the child
 *   schema name                          →  TableDescriptor.schema
 *   properties[k].type / .format         →  ColumnDescriptor.type
 *   properties[k] nullable / required    →  ColumnDescriptor.nullable
 *   $ref → enum schema                   →  ColumnDescriptor.enumValues
 */

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * How a table relates to the server, which determines its migration strategy
 * and whether conflicts are possible at all.
 *
 *   replica       Server-authoritative.  Never written locally except by the
 *                 pull worker.  A schema change is free: DROP and re-hydrate.
 *
 *   write-through Locally authoritative until pushed.  Rows carry sync
 *                 bookkeeping and an outbox entry.  Pulls still apply, but
 *                 only to rows with no PENDING outbox entry.  Schema changes
 *                 require real ALTERs because the rows hold unsynced money.
 *
 *   cache         Server-authoritative and disposable.  Like replica but with
 *                 no watermark: refilled lazily rather than pulled.
 *
 *   system        Not derived from the contract at all.  Engine bookkeeping
 *                 (outbox, cursors, device session, schema version).  The
 *                 generator emits these from a fixed built-in list, not from
 *                 the OpenAPI document.
 */
export type OfflineMode = 'replica' | 'write-through' | 'cache' | 'system';

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * Logical column type.  The mapping to SQLite storage classes lives in
 * `ddl.ts` and is deliberately narrow:
 *
 *   TEXT      → TEXT
 *   UUID      → TEXT
 *   DECIMAL   → TEXT   ← money and quantities. NEVER REAL. See note below.
 *   INTEGER   → INTEGER
 *   BOOLEAN   → INTEGER (0/1)
 *   TIMESTAMP → TEXT (ISO-8601 UTC)
 *   JSON      → TEXT (serialised)
 *
 * DECIMAL as TEXT is not a stylistic choice.  SQLite REAL is IEEE-754 binary
 * floating point, so 0.1 + 0.2 !== 0.3 and a shop's daily total drifts by
 * cents.  The contract declares money as `type: number, format: double`
 * because JSON has no decimal type; the generator must recognise that and
 * store it as text, doing arithmetic in a decimal library.
 */
export type ColumnType =
  | 'TEXT'
  | 'UUID'
  | 'DECIMAL'
  | 'INTEGER'
  | 'BOOLEAN'
  | 'TIMESTAMP'
  | 'JSON';

export interface ColumnDescriptor {
  /** SQLite column name, snake_case. */
  readonly name: string;
  /**
   * DTO property name, camelCase.  Absent for injected system columns that
   * have no counterpart in the OpenAPI schema.
   */
  readonly field?: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
  /** Present when the OpenAPI property `$ref`s an enum schema. */
  readonly enumValues?: readonly string[];
  /** SQL literal for DEFAULT, already quoted if it is a string. */
  readonly defaultSql?: string;
  /** Carried through from the OpenAPI `description` for readability. */
  readonly comment?: string;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface ParentRef {
  /** Parent table name. */
  readonly table: string;
  /** Column on THIS table holding the parent's primary key. */
  readonly fk: string;
}

export interface TableDescriptor {
  readonly table: string;
  /**
   * OpenAPI schema this table was generated from.  `null` for system tables,
   * which the generator emits from a built-in list.
   */
  readonly schema: string | null;
  readonly mode: OfflineMode;
  readonly primaryKey: readonly string[];
  /**
   * Column used for incremental pull.  Required for `replica` and
   * `write-through`; absent for `cache` and `system`.
   */
  readonly watermark?: string;
  /**
   * Request-scope columns injected by the generator, not present in the
   * OpenAPI schema.  Populated from `X-Tenant-Id` / `X-Branch-Id` on write and
   * always added to the WHERE clause on read, which is what enforces tenant
   * isolation on the local side.
   */
  readonly scope: readonly string[];
  readonly columns: readonly ColumnDescriptor[];
  readonly indexes: readonly (readonly string[])[];
  readonly uniqueIndexes: readonly (readonly string[])[];
  /** Set on child tables produced from `x-offline.children`. */
  readonly parent?: ParentRef;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * How an operation is served when the engine is READY.
 *
 *   generated-list  A mechanical filter/sort/paginate over one replica table.
 *                   The generator emits the whole implementation.
 *   generated-get   A mechanical primary-key lookup.  Also fully generated.
 *   handwritten     Transactional.  The generator emits only the route entry
 *                   and the request schema; a human writes the operation.
 */
export type OperationKind = 'generated-list' | 'generated-get' | 'handwritten';

export interface RouteDescriptor {
  /** OpenAPI operationId. This is the local engine's command vocabulary. */
  readonly operationId: string;
  readonly method: HttpMethod;
  /**
   * OpenAPI path template, e.g. `/core/sales/{saleId}`.  Matched against the
   * outgoing request URL by `packages/offline-http`.
   */
  readonly path: string;
  readonly kind: OperationKind;
  /** Table the operation reads or writes.  Absent for pure sync operations. */
  readonly table?: string;
  /** Requests per minute allowed through gate 6. */
  readonly rateLimit: number;
  /** False only for session/health operations that must work while LOCKED. */
  readonly requiresUnlock: boolean;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface LocalStoreManifest {
  /**
   * Monotonic integer, bumped whenever the emitted DDL changes.  Baked into
   * the app at build time and compared against `schema_version` on disk.
   */
  readonly localSchemaVersion: number;
  /**
   * The `@bizuri/api-client` version this store was generated against.  Sent
   * on every sync request as `X-Bizuri-Contract-Version`.
   *
   * NOTE: read from the npm/Maven artifact version, NOT from the spec's
   * `info.version` — the core contract's `info.version` is stale at `1.0.0`
   * while the artifact is at `1.2.29`.
   */
  readonly contractVersion: string;
  /**
   * Per-table hash of the emitted DDL.  Lets startup detect which `replica`
   * tables changed shape and need a DROP + re-hydrate, rather than migrating
   * them.
   */
  readonly tableHashes: Readonly<Record<string, string>>;
}
