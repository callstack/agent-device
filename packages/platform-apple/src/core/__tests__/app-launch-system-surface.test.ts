import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return { ...actual, ensureBootedSimulator: vi.fn(actual.ensureBootedSimulator) };
});

import { runCmd } from '@agent-device/host-kit/command';
import { ensureBootedSimulator } from '../simulator.ts';
import { openIosApp } from '../app-launch.ts';
import { AppError } from '@agent-device/kernel/errors';

const mockRunCmd = vi.mocked(runCmd);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);

beforeEach(() => {
  vi.resetAllMocks();
  mockEnsureBootedSimulator.mockResolvedValue();
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

// Bug A (issue #2438): opening the web-auth host must be refused, not launched — a simctl launch or
// activation cancels the ASWebAuthenticationSession it presents. The refusal must fire BEFORE any
// process-touching command runs.
test('open refuses a system-surface host and never launches it', async () => {
  await assert.rejects(
    openIosApp(IOS_TEST_SIMULATOR, 'com.apple.SafariViewService', {
      appBundleId: 'com.apple.SafariViewService',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details?.reason, 'system-surface-host-not-openable');
      assert.match(error.message, /com\.apple\.SafariViewService/);
      return true;
    },
  );
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('open still launches an ordinary app', async () => {
  await openIosApp(IOS_TEST_SIMULATOR, 'MyApp', { appBundleId: 'com.example.app' });
  const launched = mockRunCmd.mock.calls.some(
    ([cmd, args]) =>
      cmd === 'xcrun' &&
      Array.isArray(args) &&
      args.includes('launch') &&
      args.includes('com.example.app'),
  );
  assert.ok(launched, 'ordinary app launch must still dispatch simctl launch');
});
