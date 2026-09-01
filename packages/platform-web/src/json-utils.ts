export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readProperty(value: unknown, key: string): unknown {
  return isJsonObject(value) ? value[key] : undefined;
}

export function readStringProperty(value: unknown, key: string): string | undefined {
  const property = readProperty(value, key);
  return typeof property === 'string' ? property : undefined;
}

export function readBooleanProperty(value: unknown, key: string): boolean | undefined {
  const property = readProperty(value, key);
  return typeof property === 'boolean' ? property : undefined;
}

export function readNumberProperty(value: JsonObject, key: string): number | undefined {
  const property = value[key];
  return typeof property === 'number' && Number.isFinite(property) ? property : undefined;
}
