/**
 * Lightweight JSON Schema validator for IPC payload validation (Gate 4).
 *
 * Supports the subset of JSON Schema Draft-07 needed by the PoC:
 *   type, required, properties, items, enum, minimum, maximum,
 *   minLength, maxLength, minItems, maxItems, additionalProperties.
 *
 * Why not ajv?  The 13 command schemas are each under 12 properties
 * and at most 2 levels deep.  A full validator would add ~200 KB of
 * JavaScript for a problem that fits in 150 lines.  If the schema
 * surface grows beyond ~25 commands or 3 nesting levels, swap this
 * module for ajv — the ValidationPipeline interface stays identical.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JsonSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

export interface JsonSchema {
  readonly type?: JsonSchemaType | JsonSchemaType[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly additionalProperties?: boolean;
  readonly description?: string;
}

export interface SchemaValidationError {
  readonly path: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate `data` against `schema`.  Returns an empty array on success
 * or a list of human-readable error paths on failure.
 */
export function validateSchema(
  data: unknown,
  schema: JsonSchema,
): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  validateNode(data, schema, '$', errors);
  return errors;
}

/**
 * Convenience: true when the data passes schema validation.
 */
export function isValid(data: unknown, schema: JsonSchema): boolean {
  return validateSchema(data, schema).length === 0;
}

// ---------------------------------------------------------------------------
// Internal recursive validator
// ---------------------------------------------------------------------------

function validateNode(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[],
): void {
  // --- type ---
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => checkType(value, t))) {
      const received = value === null ? 'null' : typeof value;
      errors.push({
        path,
        message: `expected ${types.join('|')}, received ${received}`,
      });
      return; // type mismatch — skip further checks for this node
    }
  }

  // --- enum ---
  if (schema.enum !== undefined) {
    if (!schema.enum.some((v) => v === value)) {
      errors.push({
        path,
        message: `value must be one of: ${schema.enum.map(String).join(', ')}`,
      });
    }
  }

  // --- string constraints ---
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path,
        message: `length ${value.length} below minimum ${schema.minLength}`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        path,
        message: `length ${value.length} exceeds maximum ${schema.maxLength}`,
      });
    }
  }

  // --- numeric constraints ---
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `${value} below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `${value} exceeds maximum ${schema.maximum}` });
    }
  }

  // --- object constraints ---
  if (isObject(value) && schema.properties) {
    // required
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value)) {
          errors.push({ path: `${path}.${key}`, message: 'required property missing' });
        }
      }
    }

    // additionalProperties
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          errors.push({
            path: `${path}.${key}`,
            message: 'unknown property — schema forbids additional properties',
          });
        }
      }
    }

    // nested properties
    for (const [key, subSchema] of Object.entries(schema.properties)) {
      if (key in value) {
        validateNode((value as Record<string, unknown>)[key], subSchema, `${path}.${key}`, errors);
      }
    }
  }

  // --- array constraints ---
  if (Array.isArray(value) && schema.items) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({
        path,
        message: `${value.length} items below minimum ${schema.minItems}`,
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({
        path,
        message: `${value.length} items exceeds maximum ${schema.maxItems}`,
      });
    }
    for (let i = 0; i < value.length; i++) {
      validateNode(value[i], schema.items, `${path}[${i}]`, errors);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    default:
      return typeof value === type;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
