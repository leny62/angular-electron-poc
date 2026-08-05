/**
 * JSON Schema validator for gate 4.
 *
 * Ported from the POC with three changes:
 *   1. `pattern` support, which the generated schemas rely on (the generator
 *      lowers `format: uuid` and `format: date-time` to explicit regexes).
 *   2. Length constraints are checked BEFORE `pattern`. This is a security fix,
 *      not a reordering for tidiness — see the ReDoS note below.
 *   3. A compile-time guard that rejects regexes with nested quantifiers.
 *
 * Still not ajv. The generated request schemas are shallow (at most 4 levels,
 * driven by `CreateSaleRequest.lines[].`) and ajv would add ~200 KB to a main
 * process bundle we are keeping at ~130 KB. If the offline surface grows past
 * roughly 40 operations or the schemas gain `$ref`, swap this module out: the
 * `validateSchema` signature is the seam, and nothing above it would change.
 */

import type { JsonSchema, JsonSchemaType } from '@bizuri/local-store';

// ---------------------------------------------------------------------------
// ReDoS defence
// ---------------------------------------------------------------------------

/**
 * Hard cap on the length of a string subjected to a regex.
 *
 * Gate 4 runs BEFORE the rate limiter (gate 6), by design: we do not want to
 * count a malformed request against a legitimate user's budget. The cost of
 * that ordering is that regex evaluation is reachable from the renderer without
 * a rate limit in front of it, so the input has to be bounded here instead.
 *
 * Every generated pattern is a bounded expression over a character class, so
 * linear-time matching against 4 KB is microseconds. Anything longer is
 * rejected before the regex runs.
 */
const MAX_PATTERN_INPUT = 4096;

/**
 * Reject regexes whose shape permits catastrophic backtracking.
 *
 * Detects a quantifier applied to a group that itself contains a quantifier —
 * the `(a+)+` / `(a*)*` / `(a+)*` family. That is the shape that turns a 30-
 * character input into exponential work.
 *
 * This is a build-time assertion on OUR generator's output, not a filter on
 * user input, so a heuristic is the right tool: it catches the realistic
 * mistake without pretending to be a general safety proof.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*]\)[+*{]/;

const compiled = new Map<string, RegExp>();

function compilePattern(pattern: string): RegExp {
  const hit = compiled.get(pattern);
  if (hit) return hit;

  if (NESTED_QUANTIFIER.test(pattern)) {
    // Fail loudly at first use rather than shipping a DoS vector. A generated
    // schema that trips this is a generator bug to fix, not a runtime condition
    // to handle.
    throw new Error(
      `Unsafe schema pattern (nested quantifier, backtracking risk): ${pattern}`,
    );
  }

  const re = new RegExp(pattern);
  compiled.set(pattern, re);
  return re;
}

/** Exposed for tests: clears the compiled-pattern cache. */
export function resetPatternCache(): void {
  compiled.clear();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SchemaValidationError {
  readonly path: string;
  readonly message: string;
}

export function validateSchema(
  data: unknown,
  schema: JsonSchema,
): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  validateNode(data, schema, '$', errors);
  return errors;
}

export function isValid(data: unknown, schema: JsonSchema): boolean {
  return validateSchema(data, schema).length === 0;
}

// ---------------------------------------------------------------------------
// Recursive validator
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
      const received = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      errors.push({ path, message: `expected ${types.join('|')}, received ${received}` });
      return; // type mismatch: further checks would be noise
    }
  }

  // --- enum ---
  if (schema.enum !== undefined && !schema.enum.some((v) => v === value)) {
    errors.push({
      path,
      message: `value must be one of: ${schema.enum.map(String).join(', ')}`,
    });
  }

  // --- string ---
  if (typeof value === 'string') {
    // Length first. Bounding the input is what makes the pattern check safe.
    let lengthOk = true;

    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path,
        message: `length ${value.length} below minimum ${schema.minLength}`,
      });
      lengthOk = false;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        path,
        message: `length ${value.length} exceeds maximum ${schema.maxLength}`,
      });
      lengthOk = false;
    }

    if (schema.pattern !== undefined) {
      if (value.length > MAX_PATTERN_INPUT) {
        errors.push({
          path,
          message: `value too long to validate (${value.length} > ${MAX_PATTERN_INPUT})`,
        });
      } else if (lengthOk && !compilePattern(schema.pattern).test(value)) {
        // The pattern source is deliberately not echoed: it would tell a
        // prober the exact accepted shape of every field.
        errors.push({ path, message: 'value does not match the required format' });
      }
    }
  }

  // --- number ---
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `${value} below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `${value} exceeds maximum ${schema.maximum}` });
    }
  }

  // --- object ---
  if (isObject(value)) {
    // `required` is honoured even when `properties` is absent, unlike the POC's
    // version. A schema that lists required keys without describing them is
    // still a meaningful constraint, and silently ignoring it would let an
    // empty body through gate 4.
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value)) {
          errors.push({ path: `${path}.${key}`, message: 'required property missing' });
        }
      }
    }

    if (schema.additionalProperties === false && schema.properties) {
      const known = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          errors.push({
            path: `${path}.${key}`,
            message: 'unknown property, schema forbids additional properties',
          });
        }
      }
    }

    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) {
          validateNode(value[key], sub, `${path}.${key}`, errors);
        }
      }
    }
  }

  // --- array ---
  if (Array.isArray(value)) {
    // Bounds are checked even without an `items` schema, so `maxItems` alone is
    // an effective guard.
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `${value.length} items below minimum ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({
        path,
        message: `${value.length} items exceeds maximum ${schema.maxItems}`,
      });
      // Stop here: validating 10,000 items to report each one is itself a
      // cheap way to burn main-process CPU from the renderer.
      return;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validateNode(value[i], schema.items, `${path}[${i}]`, errors);
      }
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
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    default:
      return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
