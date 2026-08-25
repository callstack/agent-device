import { describe, expect, test } from 'vitest';
import { readDeclaredPlatformExecution } from '../platform-execution-entry.ts';
import { commandDescriptors } from '../registry.ts';

describe('platform-execution registry entry gate', () => {
  test('rejects a descriptor that declares no discriminator', () => {
    expect(() => readDeclaredPlatformExecution({ name: 'planted' })).toThrow(
      /must declare platformExecution/,
    );
  });

  test('rejects none on a descriptor that keeps a capability bucket', () => {
    expect(() =>
      readDeclaredPlatformExecution({
        name: 'planted',
        capability: { apple: {}, android: {}, linux: {} },
        platformExecution: { kind: 'none' },
      }),
    ).toThrow(/keeps a capability bucket/);
  });

  test('accepts none on a descriptor with no capability bucket', () => {
    expect(
      readDeclaredPlatformExecution({ name: 'planted', platformExecution: { kind: 'none' } }),
    ).toEqual({ kind: 'none' });
  });

  test('rejects host on a descriptor that keeps a capability bucket', () => {
    expect(() =>
      readDeclaredPlatformExecution({
        name: 'planted',
        capability: { apple: {}, android: {}, linux: {} },
        platformExecution: { kind: 'host' },
      }),
    ).toThrow(/keeps a capability bucket/);
  });

  test('accepts host on a descriptor with no capability bucket', () => {
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

  test('no command declares none while keeping a capability bucket', () => {
    const contradictory = commandDescriptors
      .filter(
        (descriptor) =>
          descriptor.platformExecution.kind === 'none' &&
          'capability' in descriptor &&
          descriptor.capability !== undefined,
      )
      .map(({ name }) => name);
    expect(contradictory).toEqual([]);
  });
});
