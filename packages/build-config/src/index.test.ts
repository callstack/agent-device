import { strict as assert } from 'node:assert';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import { assertManagedPlatformPluginFactory } from './index.ts';

const HARMONYOS_CLAIM = { apiVersion: 3, platform: 'harmonyos' };

/** Writes a `package.json` holding one managed platform claim and returns its URL, as a build calls it. */
function claimManifestUrl(claim: { apiVersion: unknown; platform?: unknown }): URL {
  const directory = mkdtempForTestSync('build-config-claim-');
  const file = path.join(directory, 'package.json');
  fs.writeFileSync(file, JSON.stringify({ name: '@agent-device/example', 'agent-device': claim }));
  return pathToFileURL(file);
}

/** One factory shaped like a managed platform plugin's default export, with the pair a case names. */
function factoryContribution(
  apiVersion: unknown,
  contributes: readonly { kind: unknown; family: unknown }[],
) {
  return () => ({ apiVersion, contributes });
}

const validFactory = factoryContribution(3, [{ kind: 'platform', family: 'harmonyos' }]);

test('accepts a factory whose pair matches the package claim', () => {
  assert.doesNotThrow(() =>
    assertManagedPlatformPluginFactory(
      claimManifestUrl(HARMONYOS_CLAIM),
      validFactory,
      'HarmonyOS',
    ),
  );
});

test('rejects a factory on an api version the package does not claim', () => {
  assert.throws(
    () =>
      assertManagedPlatformPluginFactory(
        claimManifestUrl(HARMONYOS_CLAIM),
        factoryContribution(2, [{ kind: 'platform', family: 'harmonyos' }]),
        'HarmonyOS',
      ),
    /managed HarmonyOS factory must match its package claim/,
  );
});

test('rejects a factory contributing the wrong kind', () => {
  assert.throws(
    () =>
      assertManagedPlatformPluginFactory(
        claimManifestUrl(HARMONYOS_CLAIM),
        factoryContribution(3, [{ kind: 'provider', family: 'harmonyos' }]),
        'HarmonyOS',
      ),
    /managed HarmonyOS factory must match its package claim/,
  );
});

test('rejects a factory contributing a family the package does not claim', () => {
  assert.throws(
    () =>
      assertManagedPlatformPluginFactory(
        claimManifestUrl(HARMONYOS_CLAIM),
        factoryContribution(3, [{ kind: 'platform', family: 'vega' }]),
        'HarmonyOS',
      ),
    /managed HarmonyOS factory must match its package claim/,
  );
});

for (const [name, contributes] of [
  ['no contribution', []],
  [
    'two contributions',
    [
      { kind: 'platform', family: 'harmonyos' },
      { kind: 'platform', family: 'vega' },
    ],
  ],
] as const) {
  test(`rejects a factory contributing ${name}`, () => {
    assert.throws(
      () =>
        assertManagedPlatformPluginFactory(
          claimManifestUrl(HARMONYOS_CLAIM),
          factoryContribution(3, contributes),
          'HarmonyOS',
        ),
      /managed HarmonyOS factory must match its package claim/,
    );
  });
}

test('rejects a manifest that carries no platform claim', () => {
  assert.throws(
    () =>
      assertManagedPlatformPluginFactory(
        claimManifestUrl({ apiVersion: 3 }),
        validFactory,
        'HarmonyOS',
      ),
    /managed HarmonyOS factory must match its package claim/,
  );
});

test('rejects a location the bundler cannot read', () => {
  // The guard reads the manifest off the filesystem, so a non-file URL fails the read rather than
  // passing an unchecked factory.
  assert.throws(() =>
    assertManagedPlatformPluginFactory(
      new URL('https://example.test/package.json'),
      validFactory,
      'HarmonyOS',
    ),
  );
});
