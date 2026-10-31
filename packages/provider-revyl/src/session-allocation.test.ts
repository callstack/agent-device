import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { LeaseLifecycleContext } from '@agent-device/contracts/device';
import {
  rejectRefusedRevylProfileFields,
  resolveRevylAppUrl,
  resolveRevylDeviceSelection,
  revylTextFlag,
} from './session-allocation.ts';

test('the app to install is the lease context initial app, trimmed', () => {
  assert.equal(
    resolveRevylAppUrl({ initialApp: '  https://apps.test/app.zip  ' }),
    'https://apps.test/app.zip',
  );
  for (const context of [
    undefined,
    {},
    { initialApp: '   ' },
    // A context built by an older or a different caller can carry a value of the wrong shape; the
    // resolver treats it as no app rather than sending it to Revyl.
    { initialApp: 42 },
    { initialApp: null },
  ] as const) {
    assert.equal(
      resolveRevylAppUrl(context as LeaseLifecycleContext | undefined),
      undefined,
      JSON.stringify(context),
    );
  }
});

test('the profile selection outranks what the runtime was built with', () => {
  assert.deepEqual(
    resolveRevylDeviceSelection(
      { flags: { device: 'iPhone 15', providerOsVersion: '17.5' } },
      { deviceModel: 'iPhone 16', osVersion: '18.0' },
    ),
    { deviceModel: 'iPhone 15', osVersion: '17.5' },
  );
  assert.deepEqual(resolveRevylDeviceSelection(undefined, { deviceModel: 'iPhone 16' }), {
    deviceModel: 'iPhone 16',
  });
  // A profile that names neither leaves Revyl to pick from its own pool.
  assert.deepEqual(resolveRevylDeviceSelection({ flags: {} }, {}), {});
});

test('a blank selection is no selection, and both halves are trimmed the same way', () => {
  // The same canonicalizer connect stores the profile with, so the persisted profile and the
  // `start_device` body cannot differ by whitespace.
  assert.deepEqual(
    resolveRevylDeviceSelection(
      { flags: { device: '  iPhone 16  ', providerOsVersion: '   ' } },
      { deviceModel: 'fallback', osVersion: '17.0' },
    ),
    // The blank OS version does not override the fallback with nothing: an absent field is absent.
    { deviceModel: 'iPhone 16', osVersion: '17.0' },
  );
  assert.equal(revylTextFlag('  a  '), 'a');
  for (const value of [undefined, null, '', '   ', 7, {}]) {
    assert.equal(revylTextFlag(value), undefined, JSON.stringify(value));
  }
});

test('the flags Revyl has no field for are refused instead of dropped', () => {
  assert.doesNotThrow(() =>
    rejectRefusedRevylProfileFields({
      flags: {
        providerApp: 'https://apps.test/a.zip',
        providerOsVersion: '18.0',
        device: 'iPhone 16',
      },
    }),
  );
  assert.doesNotThrow(() => rejectRefusedRevylProfileFields(undefined));
  // Each refusal names the flag the caller actually typed, which is what makes it actionable.
  for (const [flags, flag] of [
    [{ providerProject: 'team' }, '--provider-project'],
    [{ providerDeviceType: 'real' }, '--provider-device-type'],
    [{ providerTimezone: 'UTC' }, '--provider-timezone'],
    [{ providerDeviceOrientation: 'portrait' }, '--provider-device-orientation'],
  ] as const) {
    assert.throws(
      () => rejectRefusedRevylProfileFields({ flags }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.details?.provider === 'revyl' &&
        error.message.includes(flag),
      JSON.stringify(flags),
    );
  }
});
