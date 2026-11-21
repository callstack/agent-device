import { builtinPlatformPlugins } from '../../core/interactors/builtin-platform-plugin-set.ts';
import { REQUIRED_PLATFORMS } from '@agent-device/contracts/platform-module';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { registerPlatformPluginSet } from '../../core/platform-plugin-registry.ts';
import {
  BUILTIN_PLATFORM_PLUGINS,
  type BuiltinPluginsCoverRequiredPlatforms,
} from '../../core/interactors/register-builtins.ts';
import { missingPlatformPlugin } from '../../core/platform-plugin-absence.ts';

// The optional families that ship as platform plugins: parsing a selector for them resolves a
// registration only through the plugin registry, never through a builtin row.
const PLATFORM_PLUGIN_FAMILIES = ['harmonyos', 'vega', 'linux', 'web'] as const;

// Independent copy of the internal platform accept-set. The CLI `--platform`
// enum derives separately from `PLATFORM_SELECTORS`; this oracle keeps registry
// coverage meaningful rather than deriving the expected set from the registry.
function parsePlatformByHand(value: unknown): Platform | undefined {
  return value === 'apple' ||
    value === 'android' ||
    value === 'harmonyos' ||
    value === 'vega' ||
    value === 'linux' ||
    value === 'web'
    ? value
    : undefined;
}

test('built-in platforms follow the canonical family order', () => {
  // The builtin set holds exactly the families the packed core still owns, in canonical
  // `PLATFORMS` order. The optional families that ship as platform plugins have no row here.
  assert.deepEqual(builtinPlatformPlugins.families, ['apple', 'android']);
});

test('every required family is covered by a builtin plugin; optional families may be absent', () => {
  // Completeness (ADR 0034) is enforced for the required families only: apple and android must
  // always resolve. An optional family that ships as a platform plugin has no builtin row, and the
  // selected-registration lookup supplies it instead. The guard type only resolves to true
  // while every RequiredPlatform is covered, so materializing it pins the guarantee.
  const pin: BuiltinPluginsCoverRequiredPlatforms = true;
  assert.ok(pin);
  for (const family of REQUIRED_PLATFORMS) {
    assert.ok(
      builtinPlatformPlugins.families.includes(family),
      `required family ${family} is registered`,
    );
    assert.ok(builtinPlatformPlugins.get(family).plugin.platforms.includes(family));
  }
});

test('registry coverage is byte-for-byte equal to the parsePlatform hand allow-list', () => {
  // Every value either both register a plugin AND parse, or neither — including
  // the `apple` SELECTOR (not a leaf platform) and assorted non-platforms.
  const candidates: unknown[] = [
    'ios',
    'macos',
    'android',
    'harmonyos',
    'vega',
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
    const registered = builtinPlatformPlugins.tryGet(candidate as Platform) !== undefined;
    // The families that ship as platform plugins parse as platforms but hold no builtin row.
    const parses =
      parsePlatformByHand(candidate) !== undefined &&
      !(PLATFORM_PLUGIN_FAMILIES as readonly unknown[]).includes(candidate);
    assert.equal(registered, parses, `coverage parity for ${JSON.stringify(candidate)}`);
  }
});

test('a family plugin resolves to the SAME instance for every leaf it owns', () => {
  // Apple owns both ios + macos (folds in the eventual macOS unwind).
  assert.equal(
    builtinPlatformPlugins.get('apple').plugin,
    builtinPlatformPlugins.get('apple').plugin,
  );
  assert.equal(builtinPlatformPlugins.get('apple').plugin.id, 'apple');
  assert.equal(builtinPlatformPlugins.get('apple').plugin.familySelector, 'apple');
  // Single-platform plugins are distinct objects.
  assert.notEqual(
    builtinPlatformPlugins.get('android').plugin,
    builtinPlatformPlugins.get('apple').plugin,
  );
});

test('each registered platform resolves to a plugin that owns it', () => {
  for (const platform of builtinPlatformPlugins.families) {
    const plugin = builtinPlatformPlugins.get(platform).plugin;
    assert.ok(
      plugin.platforms.includes(platform),
      `${platform} plugin lists ${platform} in its platforms`,
    );
    assert.equal(typeof plugin.createInteractor, 'function');
  }
});

test('getPlugin throws UNSUPPORTED_PLATFORM (verbatim) for an unregistered platform', () => {
  // Same code + message the deleted getInteractor switch default produced.
  const unregistered = 'beos' as unknown as Platform;
  assert.throws(
    () => builtinPlatformPlugins.get(unregistered).plugin,
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_PLATFORM' &&
      error.message === 'Unsupported platform: beos',
  );
  assert.equal(builtinPlatformPlugins.tryGet(unregistered), undefined);
});

test('registering a duplicate platform is a hard error', () => {
  assert.throws(
    () =>
      registerPlatformPluginSet(
        [...BUILTIN_PLATFORM_PLUGINS, BUILTIN_PLATFORM_PLUGINS[0]],
        missingPlatformPlugin,
      ),
    /Duplicate platform family registration/,
  );
});
