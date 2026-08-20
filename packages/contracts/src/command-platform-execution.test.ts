import { describe, expect, test } from 'vitest';
import { appLogRuntimePlanUses } from './logs-runtime-plan.ts';
import { inventoryUse } from './platform-module.ts';
import { assertCommandPlatformExecution } from './command-platform-execution.ts';

describe('command platform execution declaration', () => {
  test.each([
    { kind: 'none' },
    { kind: 'legacy' },
    { kind: 'inventory', use: inventoryUse },
    { kind: 'device-runtime', use: { required: ['capture'], preferred: [] } },
    {
      kind: 'device-runtime',
      use: { required: ['capture'], preferred: ['inspect'], conditional: ['observe'] },
    },
  ])('accepts one closed execution shape: %j', (value) => {
    expect(() => assertCommandPlatformExecution(value)).not.toThrow();
  });

  test.each([
    {},
    { kind: 'none', use: inventoryUse },
    { kind: 'legacy', use: inventoryUse },
    { kind: 'inventory' },
    { kind: 'inventory', use: inventoryUse, legacy: true },
    {
      kind: 'device-runtime',
      use: { required: [], preferred: [] },
      inventory: true,
    },
    {
      kind: 'device-runtime',
      use: { required: ['capture', 'capture'], preferred: [] },
    },
    {
      kind: 'device-runtime',
      use: { required: ['capture'], preferred: ['capture'] },
    },
    {
      kind: 'device-runtime',
      use: { required: ['capture'], preferred: [], conditional: ['capture'] },
    },
    {
      kind: 'device-runtime',
      use: { required: [], preferred: ['capture'], conditional: ['capture'] },
    },
  ])('rejects neither, mixed, widened, duplicate, or overlapping declarations: %j', (value) => {
    expect(() => assertCommandPlatformExecution(value)).toThrow(/exactly one/);
  });

  test('accepts an exhaustive non-empty set of input-dependent runtime uses', () => {
    expect(() =>
      assertCommandPlatformExecution({ kind: 'device-runtime', uses: appLogRuntimePlanUses }),
    ).not.toThrow();
  });

  test.each([
    { kind: 'device-runtime', uses: [] },
    { kind: 'device-runtime', use: appLogRuntimePlanUses[0], uses: appLogRuntimePlanUses },
    { kind: 'device-runtime', uses: [appLogRuntimePlanUses[0], appLogRuntimePlanUses[0]] },
    {
      kind: 'device-runtime',
      uses: [{ required: ['appLogStart'], preferred: ['appLogStart'] }],
    },
  ])('rejects empty, duplicate, overlapping, or both-form runtime uses: %j', (value) => {
    expect(() => assertCommandPlatformExecution(value)).toThrow(/exactly one/);
  });
});
