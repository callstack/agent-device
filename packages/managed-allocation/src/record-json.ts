import type { JsonObject } from '@agent-device/contracts/client';
import { freezeJsonObject, isBoundedJsonObject } from '@agent-device/capture-kit/durable-json';

export function decodeAllocationAttribution(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  return isBoundedJsonObject(value) ? freezeJsonObject(value) : undefined;
}
