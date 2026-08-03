/**
 * JSON Schema definitions for every command in the registry.
 *
 * Each schema validates the `payload` field of the command envelope
 * AFTER gates 1-3 have confirmed the envelope shape.
 *
 * Schemas are deliberately strict: unknown properties are rejected
 * so a typo in a property name fails fast instead of silently
 * passing through.
 *
 * @see electron/domain/json-schema-validator.ts
 */

import type { JsonSchema } from '../domain/json-schema-validator';
import type { CommandName } from '../shared/contracts';

// ---------------------------------------------------------------------------
// Schema catalogue
// ---------------------------------------------------------------------------

/**
 * Schema entries typed as tuples so TypeScript narrows the JsonSchema
 * objects rather than inferring literal `undefined` properties from
 * optional schema fields.
 */
const schemas: ReadonlyArray<[CommandName, JsonSchema]> = [
  // Session -----------------------------------------------------------
  [
    'session.unlock',
    {
      type: 'object',
      required: ['passphrase'],
      properties: {
        passphrase: { type: 'string', minLength: 1, maxLength: 256 },
      },
      additionalProperties: false,
    },
  ],

  [
    'session.state',
    {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  ],

  // Catalog ------------------------------------------------------------
  [
    'catalog.search',
    {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  ],

  // Stock --------------------------------------------------------------
  [
    'stock.balance',
    {
      type: 'object',
      properties: {
        itemIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 100,
        },
      },
      additionalProperties: false,
    },
  ],

  [
    'stock.adjust',
    {
      type: 'object',
      required: ['itemId', 'quantity'],
      properties: {
        itemId: { type: 'string', minLength: 1 },
        quantity: { type: 'integer' },
        reason: { type: 'string', maxLength: 500 },
      },
      additionalProperties: false,
    },
  ],

  // Customer -----------------------------------------------------------
  [
    'customer.create',
    {
      type: 'object',
      required: ['customerName'],
      properties: {
        customerName: { type: 'string', minLength: 1, maxLength: 200 },
        customerTin: { type: 'string', maxLength: 30 },
        customerPhone: { type: 'string', maxLength: 20 },
        customerEmail: { type: 'string', maxLength: 200 },
        address: { type: 'string', maxLength: 500 },
      },
      additionalProperties: false,
    },
  ],

  [
    'customer.search',
    {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  ],

  // Sale ---------------------------------------------------------------
  [
    'sale.create',
    {
      type: 'object',
      required: ['items', 'amountPaid'],
      properties: {
        customerId: { type: 'string', minLength: 1 },
        clientName: { type: 'string', maxLength: 200 },
        clientTin: { type: 'string', maxLength: 30 },
        clientPhone: { type: 'string', maxLength: 20 },
        currencyCode: { type: 'string', minLength: 3, maxLength: 3 },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['itemId', 'quantity'],
            properties: {
              itemId: { type: 'string', minLength: 1 },
              quantity: { type: 'number', minimum: 0.001 },
              unitPrice: { type: 'number', minimum: 0 },
            },
            additionalProperties: false,
          },
          minItems: 1,
          maxItems: 200,
        },
        amountPaid: { type: 'string', minLength: 1, maxLength: 20 },
      },
      additionalProperties: false,
    },
  ],

  [
    'sale.get',
    {
      type: 'object',
      required: ['saleId'],
      properties: {
        saleId: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  ],

  [
    'sale.list',
    {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0 },
        syncState: { type: 'string', enum: ['PENDING', 'SYNCED', 'CONFLICT', 'FAILED'] },
      },
      additionalProperties: false,
    },
  ],

  // Engine -------------------------------------------------------------
  [
    'engine.health',
    {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  ],

  // Sync ---------------------------------------------------------------
  [
    'sync.now',
    {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  ],

  [
    'sync.conflicts',
    {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  ],

  [
    'sync.resolve',
    {
      type: 'object',
      required: ['conflictId', 'resolution'],
      properties: {
        conflictId: { type: 'string', minLength: 1 },
        resolution: { type: 'string', enum: ['local', 'remote'] },
      },
      additionalProperties: false,
    },
  ],
];

export const COMMAND_SCHEMAS: ReadonlyMap<CommandName, JsonSchema> =
  new Map(schemas);
