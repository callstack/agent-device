import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PLATFORMS, type Platform } from '@agent-device/kernel/device';
import { createPlatformModuleRegistry, type PlatformModuleMetadata } from './platform-module.ts';

test('platform metadata registry is canonical, ordered, and immutable', () => {
  const registrations = [...PLATFORMS]
    .reverse()
    .map((family) => ({ family, marker: family.toUpperCase() }));
  const registry = createPlatformModuleRegistry(registrations);

  assert.deepEqual(registry.families, PLATFORMS);
  assert.deepEqual(
    registry.modules.map((module) => module.family),
    PLATFORMS,
  );
  assert.equal(registry.get('harmonyos').marker, 'HARMONYOS');
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.families));
  assert.ok(Object.isFrozen(registry.modules));
  assert.ok(Object.isFrozen(registry.get('apple')));
});

test('platform metadata registry rejects missing and duplicate family ownership', () => {
  const missing = PLATFORMS.filter((family) => family !== 'web').map((family) => ({ family }));
  assert.throws(() => createPlatformModuleRegistry(missing), /Missing.*web/);

  const duplicate: PlatformModuleMetadata[] = [
    ...PLATFORMS.map((family) => ({ family })),
    { family: 'apple' },
  ];
  assert.throws(() => createPlatformModuleRegistry(duplicate), /Duplicate.*apple/);
});

test('platform metadata registry rejects an unknown runtime family value', () => {
  const registrations = [
    ...PLATFORMS.map((family) => ({ family })),
    { family: 'unknown' as Platform },
  ];
  assert.throws(() => createPlatformModuleRegistry(registrations), /Unknown.*unknown/);
});
