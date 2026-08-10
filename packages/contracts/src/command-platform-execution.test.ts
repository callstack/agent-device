import { describe, expect, test } from 'vitest';
import { inventoryUse } from './platform-module.ts';
import { assertCommandPlatformExecution } from './command-platform-execution.ts';

describe('command platform execution declaration', () => {
  test.each([
    { kind: 'legacy' },
    { kind: 'inventory', use: inventoryUse },
    { kind: 'device-runtime', use: { required: ['capture'], preferred: ['inspect'] } },
  ])('accepts one closed execution shape: %j', (value) => {
    expect(() => assertCommandPlatformExecution(value)).not.toThrow();
  });

  test.each([
    {},
    { kind: 'legacy', use: inventoryUse },
    { kind: 'inventory' },
    { kind: 'inventory', use: inventoryUse, legacy: true },
    { kind: 'device-runtime', use: { required: [], preferred: [] }, inventory: true },
    { kind: 'device-runtime', use: { required: ['capture', 'capture'], preferred: [] } },
    { kind: 'device-runtime', use: { required: ['capture'], preferred: ['capture'] } },
  ])('rejects neither, mixed, widened, duplicate, or overlapping declarations: %j', (value) => {
    expect(() => assertCommandPlatformExecution(value)).toThrow(/exactly one/);
  });
});
