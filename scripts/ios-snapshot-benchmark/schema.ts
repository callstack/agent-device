import fs from 'node:fs';
import path from 'node:path';

type Schema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean | Schema;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  $ref?: string;
  $defs?: Record<string, Schema>;
};

const SCHEMA_PATH = path.join(import.meta.dirname, 'raw-result.schema.v1.json');

export function validateRawResult(value: unknown): string[] {
  const root = readRawResultSchema();
  return collectErrors(value, root, '$', root.$defs ?? {});
}

export function assertValidRawResult(value: unknown): void {
  const errors = validateRawResult(value);
  if (errors.length > 0) throw new Error(`Raw result does not match schema:\n${errors.join('\n')}`);
}

function readRawResultSchema(): Schema {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as Schema;
}

function collectErrors(
  value: unknown,
  schema: Schema,
  location: string,
  definitions: Record<string, Schema>,
): string[] {
  if (schema.$ref) return collectReferenceErrors(value, schema.$ref, location, definitions);
  const typeErrors = validateType(value, schema, location);
  if (typeErrors.length > 0) return typeErrors;
  return [
    ...validateConst(value, schema, location),
    ...validateEnum(value, schema, location),
    ...validateString(value, schema, location),
    ...validateNumber(value, schema, location),
    ...validateArray(value, schema, location, definitions),
    ...validateObject(value, schema, location, definitions),
  ];
}

function collectReferenceErrors(
  value: unknown,
  reference: string,
  location: string,
  definitions: Record<string, Schema>,
): string[] {
  const definitionName = reference.replace(/^#\/\$defs\//, '');
  const definition = definitions[definitionName];
  return definition
    ? collectErrors(value, definition, location, definitions)
    : [`${location}: unknown schema reference ${reference}`];
}

function validateType(value: unknown, schema: Schema, location: string): string[] {
  if (!schema.type || matchesType(value, schema.type)) return [];
  return [`${location}: expected type ${JSON.stringify(schema.type)}`];
}

function validateConst(value: unknown, schema: Schema, location: string): string[] {
  return 'const' in schema && !Object.is(value, schema.const)
    ? [`${location}: expected ${JSON.stringify(schema.const)}`]
    : [];
}

function validateEnum(value: unknown, schema: Schema, location: string): string[] {
  return schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))
    ? [`${location}: value is not in the permitted enum`]
    : [];
}

function validateString(value: unknown, schema: Schema, location: string): string[] {
  if (typeof value !== 'string' || value.length >= (schema.minLength ?? 0)) return [];
  return [`${location}: string is too short`];
}

function validateNumber(value: unknown, schema: Schema, location: string): string[] {
  if (typeof value !== 'number') return [];
  const errors = [
    ...(Number.isFinite(value) ? [] : [`${location}: number must be finite`]),
    ...(schema.minimum !== undefined && value < schema.minimum
      ? [`${location}: number is below minimum ${schema.minimum}`]
      : []),
    ...(schema.maximum !== undefined && value > schema.maximum
      ? [`${location}: number is above maximum ${schema.maximum}`]
      : []),
  ];
  return errors;
}

function validateArray(
  value: unknown,
  schema: Schema,
  location: string,
  definitions: Record<string, Schema>,
): string[] {
  if (!Array.isArray(value)) return [];
  const lengthErrors =
    value.length < (schema.minItems ?? 0) ? [`${location}: array is too short`] : [];
  const itemErrors = schema.items
    ? value.flatMap((item, index) =>
        collectErrors(item, schema.items!, `${location}[${index}]`, definitions),
      )
    : [];
  return [...lengthErrors, ...itemErrors];
}

function validateObject(
  value: unknown,
  schema: Schema,
  location: string,
  definitions: Record<string, Schema>,
): string[] {
  if (!isPlainObject(value)) return [];
  const properties = schema.properties ?? {};
  const requiredErrors = (schema.required ?? []).flatMap((key) =>
    key in value ? [] : [`${location}.${key}: missing required property`],
  );
  const propertyErrors = Object.entries(properties).flatMap(([key, child]) =>
    key in value ? collectErrors(value[key], child, `${location}.${key}`, definitions) : [],
  );
  const additionalErrors = validateAdditionalProperties(
    value,
    schema.additionalProperties,
    properties,
    location,
    definitions,
  );
  return [...requiredErrors, ...propertyErrors, ...additionalErrors];
}

function validateAdditionalProperties(
  value: Record<string, unknown>,
  additionalProperties: boolean | Schema | undefined,
  properties: Record<string, Schema>,
  location: string,
  definitions: Record<string, Schema>,
): string[] {
  const unknownKeys = Object.keys(value).filter((key) => !(key in properties));
  if (additionalProperties === false) {
    return unknownKeys.map((key) => `${location}.${key}: unknown property`);
  }
  if (!isSchema(additionalProperties)) return [];
  return unknownKeys.flatMap((key) =>
    collectErrors(value[key], additionalProperties, `${location}.${key}`, definitions),
  );
}

function matchesType(value: unknown, type: string | string[]): boolean {
  return (Array.isArray(type) ? type : [type]).some((candidate) => {
    if (candidate === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (candidate === 'number') return typeof value === 'number';
    if (candidate === 'object') return isPlainObject(value);
    if (candidate === 'array') return Array.isArray(value);
    if (candidate === 'null') return value === null;
    return typeof value === candidate;
  });
}

function isSchema(value: boolean | Schema | undefined): value is Schema {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
