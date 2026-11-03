// A validator for the JSON Schema subset this provider publishes (§3.3, [S7]): type, properties,
// required, additionalProperties: false, items, minItems, maxItems, minLength, maxLength (in code
// points, as JSON Schema counts them), pattern, enum, minimum and maximum. The published schemas are
// the single source of truth: input is checked against inputSchema before any 402 [P8], and output
// against outputSchema before it is stored. schema_test.ts checks it agrees with Ajv on both schemas.

import type { InputError } from './protocol.ts';

export interface Schema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  format?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
}

const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matches(type: NonNullable<Schema['type']>, value: unknown) {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

/** Every way `value` breaks `schema`, as JSON Pointers into the value; empty when it is valid. */
export function validate(schema: Schema, value: unknown, pointer = ''): InputError[] {
  const errors: InputError[] = [];
  const fail = (message: string) => errors.push({ pointer, message });
  if (schema.type !== undefined && !matches(schema.type, value)) {
    fail(
      `must be ${
        schema.type === 'integer' || schema.type === 'object' || schema.type === 'array' ? 'an' : 'a'
      } ${schema.type}`,
    );
    return errors;
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => option === value)) {
    fail(`must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      fail(`must have at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      fail(`must have at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      fail('does not have the required format');
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`must have at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(`must have at most ${schema.maxItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => errors.push(...validate(schema.items!, item, `${pointer}/${index}`)));
    }
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(object, key)) fail(`must have the property "${key}"`);
    }
    for (const [key, item] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property !== undefined) errors.push(...validate(property, item, `${pointer}/${escape(key)}`));
      else if (schema.additionalProperties === false) {
        errors.push({ pointer: `${pointer}/${escape(key)}`, message: 'is not an allowed property' });
      }
    }
  }
  return errors;
}
