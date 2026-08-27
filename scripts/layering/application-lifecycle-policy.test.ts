import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationLifecycleOwnershipViolations } from './application-lifecycle-policy.ts';

const APPLICATION_RESOURCES_FILE = 'src/platform-runtime-application-resources.ts';

function messages(entries: readonly (readonly [string, string])[]): string {
  return applicationLifecycleOwnershipViolations(new Map(entries))
    .map(({ message }) => message)
    .join('\n');
}

function validEntries(): [string, string][] {
  return [
    ['src/platform-runtime-gateway.ts', 'runStartupRecoveryFence();'],
    [
      APPLICATION_RESOURCES_FILE,
      'hasTestImeRecoveryEvidence(input.stateDir); recoverTestImeStartup(input);',
    ],
    [
      'packages/platform-android/src/ime-activation.ts',
      'await waitForStartupRecoveryFence(options.stateDir); const adb = resolveAndroidAdbExecutor(device);',
    ],
  ];
}

test('the durable lifecycle policy accepts fenced, evidence-gated ownership', () => {
  assert.equal(messages(validEntries()), '');
});

test('durable lifecycle rejects an unfenced IME mutation and generic capture-kit role', () => {
  const entries = validEntries();
  entries[2] = [
    'packages/platform-android/src/ime-activation.ts',
    'const adb = resolveAndroidAdbExecutor(device);',
  ];
  entries.push([
    'packages/capture-kit/src/platform-runtime-unavailable.ts',
    'const lifecycle = Object.freeze({});',
  ]);
  const found = messages(entries);
  assert.match(found, /must wait for startup recovery/);
  assert.match(found, /must not own a generic platform-runtime lifecycle role/);
});

test('durable lifecycle rejects platform ownership in the composition gateway', () => {
  const entries = validEntries();
  entries[0] = [
    'src/platform-runtime-gateway.ts',
    'runStartupRecoveryFence(); host.androidApplications.recoverTestImeStartup(input);',
  ];
  assert.match(messages(entries), /name no platform-specific durable owner/);
});

test('durable lifecycle rejects unevidenced Android startup recovery', () => {
  const entries = validEntries();
  entries[1] = [APPLICATION_RESOURCES_FILE, 'recoverTestImeStartup(input);'];
  assert.match(messages(entries), /gate lazy Android test-IME recovery/);
});

test('durable lifecycle ignores decoy prose and rejects reversed calls', () => {
  const entries = validEntries();
  entries[1] = [
    APPLICATION_RESOURCES_FILE,
    `
      // hasTestImeRecoveryEvidence(input.stateDir)
      recoverTestImeStartup(input);
      hasTestImeRecoveryEvidence(input.stateDir);
    `,
  ];
  entries[2] = [
    'packages/platform-android/src/ime-activation.ts',
    `
      const prose = 'waitForStartupRecoveryFence(options.stateDir)';
      resolveAndroidAdbExecutor(device);
      await waitForStartupRecoveryFence(options.stateDir);
    `,
  ];
  const found = messages(entries);
  assert.match(found, /gate lazy Android test-IME recovery/);
  assert.match(found, /must wait for startup recovery/);
});
