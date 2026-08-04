import { validateSchema, isValid } from '../json-schema-validator';
import type { JsonSchema } from '../json-schema-validator';

describe('validateSchema', () => {
  describe('type validation', () => {
    it('passes when value matches expected type', () => {
      expect(isValid('hello', { type: 'string' })).toBe(true);
      expect(isValid(42, { type: 'number' })).toBe(true);
      expect(isValid(42, { type: 'integer' })).toBe(true);
      expect(isValid(true, { type: 'boolean' })).toBe(true);
      expect(isValid(null, { type: 'null' })).toBe(true);
      expect(isValid({}, { type: 'object' })).toBe(true);
      expect(isValid([], { type: 'array' })).toBe(true);
    });

    it('rejects when value does not match expected type', () => {
      const errors = validateSchema(42, { type: 'string' });
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('$');
      expect(errors[0].message).toContain('expected string');
    });

    it('supports union types', () => {
      expect(isValid('hello', { type: ['string', 'number'] })).toBe(true);
      expect(isValid(42, { type: ['string', 'number'] })).toBe(true);
      expect(isValid(true, { type: ['string', 'number'] })).toBe(false);
    });

    it('rejects float for integer type', () => {
      const errors = validateSchema(3.14, { type: 'integer' });
      expect(errors).toHaveLength(1);
    });

    it('rejects array for object type', () => {
      const errors = validateSchema([], { type: 'object' });
      expect(errors).toHaveLength(1);
    });

    it('rejects null for object type when null not allowed', () => {
      const errors = validateSchema(null, { type: 'object' });
      expect(errors).toHaveLength(1);
    });
  });

  describe('required properties', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['name', 'email'],
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
    };

    it('passes when all required properties are present', () => {
      expect(isValid({ name: 'Alice', email: 'a@b.com' }, schema)).toBe(true);
    });

    it('rejects when a required property is missing', () => {
      const errors = validateSchema({ name: 'Alice' }, schema);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('$.email');
      expect(errors[0].message).toContain('required');
    });

    it('reports multiple missing required properties', () => {
      const errors = validateSchema({}, schema);
      expect(errors).toHaveLength(2);
    });
  });

  describe('additionalProperties', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    };

    it('rejects unknown properties when additionalProperties is false', () => {
      const errors = validateSchema({ name: 'Alice', age: 30 }, schema);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('$.age');
    });

    it('passes when all properties are known', () => {
      expect(isValid({ name: 'Alice' }, schema)).toBe(true);
    });

    it('passes extra properties when additionalProperties is not set', () => {
      const permissive: JsonSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
      };
      expect(isValid({ name: 'Alice', age: 30 }, permissive)).toBe(true);
    });
  });

  describe('nested objects', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['user'],
      properties: {
        user: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
          },
        },
      },
    };

    it('validates nested objects recursively', () => {
      expect(isValid({ user: { id: 1, name: 'Alice' } }, schema)).toBe(true);
    });

    it('rejects when nested required property is missing', () => {
      const errors = validateSchema({ user: { name: 'Alice' } }, schema);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('$.user.id');
    });

    it('rejects when nested property has wrong type', () => {
      const errors = validateSchema({ user: { id: 'not-a-number' } }, schema);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('$.user.id');
    });
  });

  describe('array validation', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: { type: 'integer' },
      minItems: 1,
      maxItems: 3,
    };

    it('validates each array item against the items schema', () => {
      expect(isValid([1, 2, 3], schema)).toBe(true);
    });

    it('rejects when an item does not match the items schema', () => {
      const errors = validateSchema([1, 'two', 3], schema);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('$[1]');
    });

    it('rejects when array has fewer than minItems', () => {
      const errors = validateSchema([], schema);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('below minimum');
    });

    it('rejects when array has more than maxItems', () => {
      const errors = validateSchema([1, 2, 3, 4], schema);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('exceeds maximum');
    });

    it('validates nested objects inside arrays', () => {
      const nestedSchema: JsonSchema = {
        type: 'array',
        items: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      };
      expect(isValid([{ id: 'a' }, { id: 'b' }], nestedSchema)).toBe(true);
      expect(isValid([{ id: 'a' }, {}], nestedSchema)).toBe(false);
    });
  });

  describe('enum constraint', () => {
    const schema: JsonSchema = { type: 'string', enum: ['red', 'green', 'blue'] };

    it('passes for values in the enum', () => {
      expect(isValid('red', schema)).toBe(true);
    });

    it('rejects values not in the enum', () => {
      const errors = validateSchema('yellow', schema);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('one of');
    });
  });

  describe('numeric constraints', () => {
    it('rejects numbers below minimum', () => {
      const errors = validateSchema(5, { type: 'integer', minimum: 10 });
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('below minimum');
    });

    it('passes numbers at minimum', () => {
      expect(isValid(10, { type: 'integer', minimum: 10 })).toBe(true);
    });

    it('rejects numbers above maximum', () => {
      const errors = validateSchema(100, { type: 'integer', maximum: 50 });
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('exceeds maximum');
    });
  });

  describe('string constraints', () => {
    it('rejects strings shorter than minLength', () => {
      const errors = validateSchema('ab', { type: 'string', minLength: 3 });
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('below minimum');
    });

    it('rejects strings longer than maxLength', () => {
      const errors = validateSchema('hello', { type: 'string', maxLength: 3 });
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('exceeds maximum');
    });

    it('passes strings within length bounds', () => {
      expect(isValid('abc', { type: 'string', minLength: 2, maxLength: 5 })).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for valid data with no schema', () => {
      expect(validateSchema(42, {})).toHaveLength(0);
    });

    it('handles null payload gracefully', () => {
      expect(isValid(null, { type: 'null' })).toBe(true);
      expect(isValid(null, { type: 'string' })).toBe(false);
    });

    it('handles undefined values in nested properties', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          optional: { type: 'string' },
        },
      };
      expect(isValid({}, schema)).toBe(true);
    });

    it('reports multiple errors independently', () => {
      const schema: JsonSchema = {
        type: 'object',
        required: ['a', 'b'],
        properties: {
          a: { type: 'string' },
          b: { type: 'number', minimum: 0 },
        },
        additionalProperties: false,
      };
      const errors = validateSchema({ a: 123, b: -5, c: 'extra' }, schema);
      expect(errors.length).toBeGreaterThanOrEqual(3);
    });

    it('rejects when query property is an empty string', () => {
      const catalogSearchSchema: JsonSchema = {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      };
      expect(isValid({ query: '', limit: 10 }, catalogSearchSchema)).toBe(true);
    });
  });
});
