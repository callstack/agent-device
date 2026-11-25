import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PLATFORMS, type Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  createPlatformModuleRegistry,
  isOptionalPlatform,
  OPTIONAL_PLATFORMS,
  REQUIRED_PLATFORMS,
  type PlatformModuleMetadata,
  type PlatformPartitionIsCanonical,
} from './platform-module.ts';
import {
  getOptionalPlatformPluginDeclaration,
  missingOptionalPlatformError,
  pluginPackageSelector,
  pluginInstallCommand,
} from './plugin-installation.ts';

const CORE_VERSION = '0.22.0';
const reportAbsent = (family: Platform) => missingOptionalPlatformError(family, CORE_VERSION);

test('platform metadata registry is canonical, ordered, and immutable', () => {
  const registrations = [...PLATFORMS]
    .reverse()
    .map((family) => ({ family, marker: family.toUpperCase() }));
  const registry = createPlatformModuleRegistry(registrations, reportAbsent);

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

test('platform metadata registry rejects missing required and duplicate family ownership', () => {
  // Only the required families are completeness-checked, so dropping one optional family is not
  // a missing registration — this drops `apple`.
  const missing = PLATFORMS.filter((family) => family !== 'apple').map((family) => ({ family }));
  assert.throws(() => createPlatformModuleRegistry(missing, reportAbsent), /Missing.*apple/);

  const duplicate: PlatformModuleMetadata[] = [
    ...PLATFORMS.map((family) => ({ family })),
    { family: 'apple' },
  ];
  assert.throws(() => createPlatformModuleRegistry(duplicate, reportAbsent), /Duplicate.*apple/);
});

test('platform metadata registry rejects an unknown runtime family value', () => {
  const registrations = [
    ...PLATFORMS.map((family) => ({ family })),
    { family: 'unknown' as Platform },
  ];
  assert.throws(
    () => createPlatformModuleRegistry(registrations, reportAbsent),
    /Unknown.*unknown/,
  );
});

test('required and optional families partition the canonical PLATFORMS exactly', () => {
  // Materializes the compile-time pin: PlatformPartitionIsCanonical only resolves to true
  // when the required and optional tuples partition PLATFORMS exactly.
  const pin: PlatformPartitionIsCanonical = true;
  assert.ok(pin);
  assert.deepEqual([...REQUIRED_PLATFORMS], ['apple', 'android']);
  assert.deepEqual([...OPTIONAL_PLATFORMS], ['harmonyos', 'vega', 'linux', 'web']);
  assert.deepEqual([...REQUIRED_PLATFORMS, ...OPTIONAL_PLATFORMS], [...PLATFORMS]);
  for (const platform of PLATFORMS) {
    assert.equal(isOptionalPlatform(platform), OPTIONAL_PLATFORMS.includes(platform as never));
    // Every family is classified as exactly one of required or optional.
    assert.notEqual(REQUIRED_PLATFORMS.includes(platform as never), isOptionalPlatform(platform));
  }
});

test('the optional-family install-hint catalog maps each optional family to its plugin package', () => {
  for (const family of OPTIONAL_PLATFORMS) {
    const declaration = getOptionalPlatformPluginDeclaration(family);
    assert.ok(declaration, `declaration for ${family}`);
    assert.equal(declaration.family, family);
    assert.equal(declaration.package, `@agent-device/${family}`);
    assert.equal(
      pluginInstallCommand(declaration, CORE_VERSION),
      `agent-device plugins add @agent-device/${family}`,
    );
  }
  // Required families and unknown names produce no inferred package.
  assert.equal(getOptionalPlatformPluginDeclaration('apple'), undefined);
  assert.equal(getOptionalPlatformPluginDeclaration('android'), undefined);
  assert.equal(getOptionalPlatformPluginDeclaration('beos' as Platform), undefined);
});

test('an optional family install command names the same release as the provider catalog', () => {
  // Published cores offer a bare install. Source builds need an explicit tag.
  const declaration = getOptionalPlatformPluginDeclaration('vega')!;
  for (const version of ['0.22.0-nightly-0-22.20261118.187', '0.22.0-nightly.20261118.186']) {
    assert.equal(
      pluginInstallCommand(declaration, version),
      pluginInstallCommand({ package: '@agent-device/browserstack' }, version).replace(
        '@agent-device/browserstack',
        '@agent-device/vega',
      ),
    );
    assert.equal(
      pluginInstallCommand(declaration, version),
      'agent-device plugins add @agent-device/vega',
    );
  }
  assert.equal(
    pluginInstallCommand(declaration, '0.22.0-dev'),
    'agent-device plugins add @agent-device/vega@nightly-0.22',
  );
  assert.equal(pluginPackageSelector(declaration, '0.22.0'), '@agent-device/vega');
});

test('missingOptionalPlatformError returns plugin-not-installed with the family and install hint', () => {
  const error = missingOptionalPlatformError('vega', CORE_VERSION);
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(error.details?.reason, 'plugin-not-installed');
  assert.equal(error.details?.family, 'vega');
  assert.equal(error.details?.package, '@agent-device/vega');
  assert.equal(error.details?.installCommand, 'agent-device plugins add @agent-device/vega');
  assert.match(String(error.details?.hint), /agent-device plugins add @agent-device\/vega/);

  // A family the catalog does not declare gets no inferred package and no plugin outcome.
  const undeclared = missingOptionalPlatformError('apple', CORE_VERSION);
  assert.ok(undeclared instanceof AppError);
  assert.equal(undeclared.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(undeclared.details, undefined);
});

test('optional families may be absent: the registry keeps only what is registered', () => {
  const registrations = REQUIRED_PLATFORMS.map((family) => ({ family, marker: family }));
  const registry = createPlatformModuleRegistry(registrations, reportAbsent);

  assert.deepEqual(registry.families, [...REQUIRED_PLATFORMS]);
  assert.deepEqual(
    registry.modules.map((module) => module.family),
    [...REQUIRED_PLATFORMS],
  );
  assert.equal(registry.get('android').marker, 'android');
});

test('get on an absent optional family throws the typed plugin-not-installed outcome', () => {
  const registry = createPlatformModuleRegistry(
    REQUIRED_PLATFORMS.map((family) => ({ family })),
    reportAbsent,
  );

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
