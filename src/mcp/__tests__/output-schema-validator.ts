import type { JsonSchema } from '../../commands/command-contract.ts';

/**
 * A focused JSON Schema validator for the MCP `outputSchema` dialect actually
 * used by COMMAND_OUTPUT_SCHEMAS: `type` (including union type arrays), `enum`,
 * `const`, `required`, `properties`, `items`, and `oneOf`. It exists so the
 * command-tools tests can validate representative structured content against the
 * COMPLETE advertised schema — enums/consts and nested required fields — rather
 * than only checking that required keys are present.
 *
 * It is intentionally NON-STRICT: unknown properties are allowed (mirroring the
 * schemas' deliberate absence of `additionalProperties: false`, so additive
 * fields such as `cost` validate). It is a test helper, not a schema generator.
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema): string[] {
  return collectErrors(value, schema, '$');
}

/** Convenience predicate for the common "does it validate at all" assertion. */
export function matchesSchema(value: unknown, schema: JsonSchema): boolean {
  return collectErrors(value, schema, '$').length === 0;
}

function collectErrors(value: unknown, schema: JsonSchema, path: string): string[] {
  if (schema.oneOf) return oneOfErrors(value, schema.oneOf, path);

  const errors = [...constErrors(value, schema, path), ...enumErrors(value, schema, path)];

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(
      `${path}: expected type ${JSON.stringify(schema.type)}, got ${describeType(value)}`,
    );
    return errors;
  }

  errors.push(...objectErrors(value, schema, path), ...arrayErrors(value, schema, path));
  return errors;
}

function oneOfErrors(value: unknown, branches: readonly JsonSchema[], path: string): string[] {
  const matching = branches.filter((branch) => collectErrors(value, branch, path).length === 0);
  if (matching.length === 1) return [];
  return [`${path}: expected to match exactly one oneOf branch, matched ${matching.length}`];
}

function constErrors(value: unknown, schema: JsonSchema, path: string): string[] {
  if (!('const' in schema) || value === schema.const) return [];
  return [`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`];
}

function enumErrors(value: unknown, schema: JsonSchema, path: string): string[] {
  if (!schema.enum || schema.enum.includes(value)) return [];
  return [`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
}

function objectErrors(value: unknown, schema: JsonSchema, path: string): string[] {
  if (!isPlainObject(value)) return [];
  const errors: string[] = [];
  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push(`${path}.${key}: missing required property`);
  }
  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    if (key in value) errors.push(...collectErrors(value[key], propSchema, `${path}.${key}`));
  }
  return errors;
}

function arrayErrors(value: unknown, schema: JsonSchema, path: string): string[] {
  if (!Array.isArray(value) || !schema.items) return [];
  const items = schema.items;
  return value.flatMap((item, index) => collectErrors(item, items, `${path}[${index}]`));
}

function matchesType(value: unknown, type: string | readonly string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => matchesSingleType(value, candidate));
}

function matchesSingleType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
