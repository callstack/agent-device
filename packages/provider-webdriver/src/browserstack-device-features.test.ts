import { test } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '@agent-device/kernel/errors';
import {
  BROWSERSTACK_DEVICE_FEATURE_SPECS,
  buildBrowserStackDeviceFeatureCapabilities,
  readBrowserStackDeviceFeatureFields,
} from './browserstack-device-features.ts';

// Every device-feature field must own a spec row: a field the table forgets parses off the CLI,
// rides the profile, and is then silently dropped before the hub ever sees it.
const DEVICE_FEATURE_FIELDS = [
  'providerDeviceOrientation',
  'providerGeoLocation',
  'providerTimezone',
  'providerLanguage',
  'providerLocale',
  'providerNetworkProfile',
  'providerCustomNetwork',
  'providerNoResignApp',
] as const;

test('every device-feature field maps to exactly one capability spec', () => {
  const fields = BROWSERSTACK_DEVICE_FEATURE_SPECS.map((spec) => spec.field);
  assert.deepEqual([...fields].sort(), [...DEVICE_FEATURE_FIELDS].sort());
  const capabilities = BROWSERSTACK_DEVICE_FEATURE_SPECS.map((spec) => spec.capability);
  assert.equal(new Set(capabilities).size, capabilities.length);
});

test('configured device features project onto BrowserStack vendor capability keys', () => {
  const capabilities = buildBrowserStackDeviceFeatureCapabilities(
    {
      providerDeviceOrientation: 'portrait',
      providerGeoLocation: 'US',
      providerTimezone: 'New_York',
      providerLanguage: 'Fr',
      providerLocale: 'Fr',
      providerNetworkProfile: '4g-lte-advanced-good',
      providerNoResignApp: true,
    },
    'ios',
  );

  assert.deepEqual(capabilities, {
    deviceOrientation: 'portrait',
    geoLocation: 'US',
    timezone: 'New_York',
    language: 'Fr',
    locale: 'Fr',
    networkProfile: '4g-lte-advanced-good',
    // The flag is the opt-out, so its presence has to invert into an explicit false.
    resignApp: false,
  });
});

test('unset device features emit no capability keys', () => {
  assert.deepEqual(buildBrowserStackDeviceFeatureCapabilities({}, 'android'), {});
});

test('app re-signing opt-out is rejected on Android with a recovery hint', () => {
  assert.throws(
    () => buildBrowserStackDeviceFeatureCapabilities({ providerNoResignApp: true }, 'android'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(error.message, /--provider-no-resign-app applies to ios sessions only/);
      assert.match(String(error.details?.hint), /--platform ios/);
      return true;
    },
  );
});

test('a named network profile and a custom network shape cannot both be configured', () => {
  assert.throws(
    () =>
      buildBrowserStackDeviceFeatureCapabilities(
        { providerNetworkProfile: '4g-lte-advanced-good', providerCustomNetwork: '1000' },
        'android',
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(String(error.details?.hint), /only one of/);
      return true;
    },
  );
});

test('device-feature flags are read off an untyped daemon request flag bag', () => {
  const fields = readBrowserStackDeviceFeatureFields({
    providerDeviceOrientation: 'landscape',
    providerTimezone: 'New_York',
    providerNoResignApp: true,
    unrelatedFlag: 'ignored',
  });

  assert.deepEqual(fields, {
    providerDeviceOrientation: 'landscape',
    providerTimezone: 'New_York',
    providerNoResignApp: true,
  });
});

test('an unrecognized orientation is rejected at the flag boundary, not forwarded to the hub', () => {
  assert.throws(
    () => readBrowserStackDeviceFeatureFields({ providerDeviceOrientation: 'landscape-left' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(String(error.details?.hint), /portrait\|landscape/);
      return true;
    },
  );
});

test('empty and non-string flag values are treated as unset', () => {
  assert.deepEqual(
    readBrowserStackDeviceFeatureFields({
      providerTimezone: '',
      providerGeoLocation: 42,
      providerNoResignApp: 'yes',
    }),
    {},
  );
});
