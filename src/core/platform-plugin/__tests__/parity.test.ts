import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PLATFORMS, type Platform } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { platformDescriptors } from '../../platform-descriptor/registry.ts';
import { getPlugin, registeredPlatforms, registerPlatformPlugin, tryGetPlugin } from '../plugin.ts';
import {
  BUILTIN_PLATFORM_PLUGINS,
  registerBuiltinPlatformPlugins,
} from '../../interactors/register-builtins.ts';

// Idempotently populate the registry for this test module.
registerBuiltinPlatformPlugins();

// Independent VERBATIM copy of the hand-authored `parsePlatform` accept-set
// (src/utils/parsing.ts) — the one truly hand-maintained platform allow-list
// (the CLI `--platform` enum already derives from `PLATFORM_SELECTORS`). The
// registry's covered set is proven byte-for-byte equal to THIS reference list,
// so the assertion stays meaningful even if `parsePlatform` is later derived.
function parsePlatformByHand(value: unknown): Platform | undefined {
  return value === 'ios' ||
    value === 'macos' ||
    value === 'android' ||
    value === 'linux' ||
    value === 'web'
    ? value
    : undefined;
}

test('registeredPlatforms() equals the canonical PLATFORMS tuple, in order', () => {
  // Byte-for-byte allow-list parity: the registry derives exactly PLATFORMS,
  // in the same order. (Left as a parity assertion — PLATFORMS stays the
  // hand-authored source of truth; nothing is derived FROM the registry yet.)
  assert.deepEqual(registeredPlatforms(), [...PLATFORMS]);
});

test('registry coverage is byte-for-byte equal to the parsePlatform hand allow-list', () => {
  // Every value either both register a plugin AND parse, or neither — including
  // the `apple` SELECTOR (not a leaf platform) and assorted non-platforms.
  const candidates: unknown[] = [
    'ios',
    'macos',
    'android',
    'linux',
    'web',
    'apple',
    'tvos',
    'ipados',
    'windows',
    '',
    'IOS',
    undefined,
  ];
  for (const candidate of candidates) {
    const registered = tryGetPlugin(candidate as Platform) !== undefined;
    const parses = parsePlatformByHand(candidate) !== undefined;
    assert.equal(registered, parses, `coverage parity for ${JSON.stringify(candidate)}`);
  }
});

test('every plugin capability bucket matches the platform-descriptor registry', () => {
  // Ties the plugin capability facet to the existing `platformDescriptors`
  // data registry (which `capabilities.ts` already derives from), so the two
  // cannot drift.
  for (const descriptor of platformDescriptors) {
    assert.equal(
      getPlugin(descriptor.platform).capability.bucket,
      descriptor.capabilityBucket,
      `bucket for ${descriptor.platform}`,
    );
  }
});

test('a family plugin resolves to the SAME instance for every leaf it owns', () => {
  // Apple owns both ios + macos (folds in the eventual macOS unwind).
  assert.equal(getPlugin('ios'), getPlugin('macos'));
  assert.equal(getPlugin('ios').id, 'apple');
  assert.equal(getPlugin('ios').familySelector, 'apple');
  // Single-platform plugins are distinct objects.
  assert.notEqual(getPlugin('android'), getPlugin('linux'));
});

test('each registered platform resolves to a plugin that owns it', () => {
  for (const platform of PLATFORMS) {
    const plugin = getPlugin(platform);
    assert.ok(
      plugin.platforms.includes(platform),
      `${platform} plugin lists ${platform} in its platforms`,
    );
    assert.equal(typeof plugin.createInteractor, 'function');
    assert.equal(typeof plugin.discoverDevices, 'function');
  }
});

test('getPlugin throws UNSUPPORTED_PLATFORM (verbatim) for an unregistered platform', () => {
  // Same code + message the deleted getInteractor switch default produced.
  const unregistered = 'beos' as unknown as Platform;
  assert.throws(
    () => getPlugin(unregistered),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_PLATFORM' &&
      error.message === 'Unsupported platform: beos',
  );
  assert.equal(tryGetPlugin(unregistered), undefined);
});

test('registering a duplicate platform is a hard error', () => {
  assert.throws(
    () => registerPlatformPlugin(BUILTIN_PLATFORM_PLUGINS[0]),
    /already registered for platform/,
  );
});
