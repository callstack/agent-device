import type { JsonObject, JsonValue } from '@agent-device/contracts/client';

type JsonValidationState = {
  seen: WeakSet<object>;
  nodes: number;
};

const MAX_DESCRIPTOR_JSON_DEPTH = 32;
const MAX_DESCRIPTOR_JSON_NODES = 4_096;

export function isBoundedJsonObject(value: unknown): value is JsonObject {
  return validateObject(value, { seen: new WeakSet(), nodes: 0 }, 0);
}

export function freezeJsonObject(value: JsonObject): JsonObject {
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeJsonValue(item)])),
  );
}

function validateObject(
  value: unknown,
  state: JsonValidationState,
  depth: number,
): value is JsonObject {
  if (!isPlainObject(value) || depth > MAX_DESCRIPTOR_JSON_DEPTH) return false;
  if (state.seen.has(value)) return false;
  state.seen.add(value);
  state.nodes += 1;
  const valid =
    state.nodes <= MAX_DESCRIPTOR_JSON_NODES &&
    Object.values(value).every((item) => validateValue(item, state, depth + 1));
  state.seen.delete(value);
  return valid;
}

function validateValue(
  value: unknown,
  state: JsonValidationState,
  depth: number,
): value is JsonValue {
  if (isJsonScalar(value)) return true;
  if (depth > MAX_DESCRIPTOR_JSON_DEPTH) return false;
  if (Array.isArray(value)) return validateArray(value, state, depth);
  return validateObject(value, state, depth);
}

function validateArray(
  value: unknown[],
  state: JsonValidationState,
  depth: number,
): value is JsonValue[] {
  if (state.seen.has(value)) return false;
  state.seen.add(value);
  state.nodes += 1;
  const valid =
    state.nodes <= MAX_DESCRIPTOR_JSON_NODES &&
    value.every((item) => validateValue(item, state, depth + 1));
  state.seen.delete(value);
  return valid;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isJsonScalar(value: unknown): value is null | string | boolean | number {
  if (value === null) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' || typeof value === 'boolean';
}

function freezeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJsonValue)) as JsonValue[];
  if (value !== null && typeof value === 'object') return freezeJsonObject(value);
  return value;
}
