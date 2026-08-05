/**
 * The JSON Schema dialect the generator emits.
 *
 * This is a type declaration only — the validator implementation lives in
 * `@bizuri/local-engine` (gate 4).  The split is deliberate: the schema
 * *language* is part of the generated contract, so it belongs next to the
 * generated schemas, while the *validator* is engine runtime.
 *
 * A strict subset of Draft-07.  The generator must not emit anything outside
 * this interface, and the validator must support all of it.  Keeping the two
 * honest is the job of `verify-manifest.ts`.
 *
 * Deliberately excluded, because nothing in the offline surface needs them and
 * each would add real validator complexity:
 *   $ref, allOf/anyOf/oneOf, if/then/else, patternProperties, dependencies,
 *   const, multipleOf, uniqueItems, format assertions.
 *
 * `format` is absent by design: the contract uses `format: uuid` and
 * `format: date-time`, but format assertion is optional in Draft-07 and
 * inconsistently implemented.  The generator lowers those to explicit
 * `pattern` regexes instead, so validation behaviour is unambiguous.
 */

export type JsonSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

export interface JsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly additionalProperties?: boolean;
  /**
   * ECMA-262 regex source, anchored by the generator.
   *
   * Every pattern emitted is a bounded, non-backtracking expression over a
   * character class.  That is a hard requirement, not a style note: gate 4 runs
   * before the rate limiter, so a catastrophically backtracking pattern would
   * be a denial-of-service vector reachable from the renderer.
   */
  readonly pattern?: string;
  readonly description?: string;
}
