import { describe, expect, test } from 'vitest';
import { readDeclaredPlatformExecution } from '../platform-execution-entry.ts';
import { commandDescriptors } from '../registry.ts';

describe('platform-execution registry entry gate', () => {
  test('rejects a descriptor that declares no discriminator', () => {
    expect(() => readDeclaredPlatformExecution({ name: 'planted' })).toThrow(
      /must declare platformExecution/,
    );
  });

  test('accepts none', () => {
    expect(
      readDeclaredPlatformExecution({ name: 'planted', platformExecution: { kind: 'none' } }),
    ).toEqual({ kind: 'none' });
  });

  test('accepts host', () => {
    expect(
      readDeclaredPlatformExecution({ name: 'planted', platformExecution: { kind: 'host' } }),
    ).toEqual({ kind: 'host' });
  });

  test('still rejects a malformed declaration', () => {
    expect(() =>
      readDeclaredPlatformExecution({ name: 'planted', platformExecution: { kind: 'inventory' } }),
    ).toThrow(/exactly one/);
  });

  test('every registered command declares an explicit execution mode', () => {
    const undeclared = commandDescriptors.filter(
      (descriptor) => descriptor.platformExecution === undefined,
    );
    expect(undeclared).toEqual([]);
  });
});
