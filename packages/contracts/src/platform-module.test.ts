import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PLATFORMS, type Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  createPlatformModuleRegistry,
  getOptionalPlatformPluginDeclaration,
  isOptionalPlatform,
  isRequiredPlatform,
  missingOptionalPlatformModuleError,
  optionalPlatformPluginInstallCommand,
  OPTIONAL_PLATFORMS,
  REQUIRED_PLATFORMS,
  type PlatformModuleMetadata,
} from './platform-module.ts';

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
  assert.equal(registry.has('harmonyos'), true);
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.families));
  assert.ok(Object.isFrozen(registry.modules));
  assert.ok(Object.isFrozen(registry.get('apple')));
});

test('platform metadata registry rejects missing required and duplicate family ownership', () => {
  const missing = PLATFORMS.filter((family) => family !== 'apple').map((family) => ({ family }));
  assert.throws(() => createPlatformModuleRegistry(missing), /Missing.*apple/);

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

test('required and optional families partition the canonical PLATFORMS exactly', () => {
  assert.deepEqual([...REQUIRED_PLATFORMS], ['apple', 'android']);
  assert.deepEqual([...OPTIONAL_PLATFORMS], ['harmonyos', 'vega', 'linux', 'web']);
  assert.deepEqual([...REQUIRED_PLATFORMS, ...OPTIONAL_PLATFORMS], [...PLATFORMS]);
  for (const platform of PLATFORMS) {
    assert.equal(isRequiredPlatform(platform), REQUIRED_PLATFORMS.includes(platform as never));
    assert.equal(isOptionalPlatform(platform), OPTIONAL_PLATFORMS.includes(platform as never));
    // Every family is classified as exactly one of required or optional.
    assert.notEqual(isRequiredPlatform(platform), isOptionalPlatform(platform));
  }
});

test('the optional-family install-hint catalog maps each optional family to its plugin package', () => {
  for (const family of OPTIONAL_PLATFORMS) {
    const declaration = getOptionalPlatformPluginDeclaration(family);
    assert.ok(declaration, `declaration for ${family}`);
    assert.equal(declaration.family, family);
    assert.equal(declaration.package, `@agent-device/${family}`);
    assert.equal(
      optionalPlatformPluginInstallCommand(declaration),
      `agent-device plugins add @agent-device/${family}`,
    );
  }
  // Required families and unknown names produce no inferred package.
  assert.equal(getOptionalPlatformPluginDeclaration('apple'), undefined);
  assert.equal(getOptionalPlatformPluginDeclaration('android'), undefined);
  assert.equal(getOptionalPlatformPluginDeclaration('beos'), undefined);
});

test('missingOptionalPlatformModuleError returns plugin-not-installed with the family and install hint', () => {
  const error = missingOptionalPlatformModuleError('vega');
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(error.details?.reason, 'plugin-not-installed');
  assert.equal(error.details?.family, 'vega');
  assert.equal(error.details?.package, '@agent-device/vega');
  assert.equal(error.details?.installCommand, 'agent-device plugins add @agent-device/vega');
  assert.match(String(error.details?.hint), /agent-device plugins add @agent-device\/vega/);

  // A family the catalog does not declare gets no inferred package and no plugin outcome.
  const undeclared = missingOptionalPlatformModuleError('apple');
  assert.ok(undeclared instanceof AppError);
  assert.equal(undeclared.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(undeclared.details, undefined);
});

test('optional families may be absent: the registry keeps only what is registered', () => {
  const registrations = REQUIRED_PLATFORMS.map((family) => ({ family, marker: family }));
  const registry = createPlatformModuleRegistry(registrations);

  assert.deepEqual(registry.families, [...REQUIRED_PLATFORMS]);
  assert.deepEqual(
    registry.modules.map((module) => module.family),
    [...REQUIRED_PLATFORMS],
  );
  for (const family of OPTIONAL_PLATFORMS) {
    assert.equal(registry.has(family), false, `has(${family})`);
  }
  assert.equal(registry.has('apple'), true);
  assert.equal(registry.get('android').marker, 'android');
});

test('get on an absent optional family throws the typed plugin-not-installed outcome', () => {
  const registry = createPlatformModuleRegistry(REQUIRED_PLATFORMS.map((family) => ({ family })));

  for (const family of OPTIONAL_PLATFORMS) {
    assert.throws(
      () => registry.get(family),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'UNSUPPORTED_PLATFORM' &&
        error.details?.reason === 'plugin-not-installed' &&
        error.details.family === family &&
        typeof error.details.installCommand === 'string' &&
        error.details.installCommand === `agent-device plugins add @agent-device/${family}` &&
        typeof error.details.hint === 'string' &&
        error.details.hint.includes(error.details.installCommand),
    );
  }
});
