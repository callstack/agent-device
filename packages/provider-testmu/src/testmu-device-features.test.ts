import { test } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '@agent-device/kernel/errors';
import {
  TESTMU_DEVICE_FEATURE_SPECS,
  buildTestMuDeviceFeatureCapabilities,
  readTestMuDeviceFeatureFields,
  readTestMuDeviceType,
} from './testmu-device-features.ts';

test('every device-feature spec maps to exactly one lt:options key', () => {
  const capabilities = TESTMU_DEVICE_FEATURE_SPECS.map((spec) => spec.capability);
  assert.equal(new Set(capabilities).size, capabilities.length);
});

test('configured device features project onto TestMu capability keys', () => {
  const capabilities = buildTestMuDeviceFeatureCapabilities({
    providerDeviceOrientation: 'landscape',
    providerGeoLocation: 'US',
    providerTimezone: 'UTC+05:30',
    providerAppiumVersion: '2.16.2',
    providerLanguage: 'fr',
    providerLocale: 'fr_FR',
  });
  assert.deepEqual(capabilities, {
    deviceOrientation: 'LANDSCAPE',
    geoLocation: 'US',
    timezone: 'UTC+05:30',
    appiumVersion: '2.16.2',
    language: 'fr',
    locale: 'fr_FR',
  });
});

test('unset and empty device features emit nothing', () => {
  assert.deepEqual(buildTestMuDeviceFeatureCapabilities({}), {});
  assert.deepEqual(buildTestMuDeviceFeatureCapabilities({ providerGeoLocation: '' }), {});
});

test('daemon flag bags are read through the same table with orientation validated', () => {
  assert.deepEqual(
    readTestMuDeviceFeatureFields({
      providerDeviceOrientation: 'portrait',
      providerLocale: 'de_DE',
      providerNetworkProfile: 'ignored-here',
      providerGeoLocation: 7,
    }),
    { providerDeviceOrientation: 'portrait', providerLocale: 'de_DE' },
  );
  assert.throws(
    () => readTestMuDeviceFeatureFields({ providerDeviceOrientation: 'sideways' }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.flag === '--provider-device-orientation',
  );
});

test('the device type defaults to the virtual pool and rejects unknown values', () => {
  assert.equal(readTestMuDeviceType(undefined), 'virtual');
  assert.equal(readTestMuDeviceType({ providerDeviceType: '' }), 'virtual');
  assert.equal(readTestMuDeviceType({ providerDeviceType: 'virtual' }), 'virtual');
  assert.equal(readTestMuDeviceType({ providerDeviceType: 'real' }), 'real');
  assert.throws(
    () => readTestMuDeviceType({ providerDeviceType: 'physical' }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.flag === '--provider-device-type',
  );
});
