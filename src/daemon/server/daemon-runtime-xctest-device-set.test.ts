import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const { mockRestoreLegacyXctestDeviceSetRedirect } = vi.hoisted(() => ({
  mockRestoreLegacyXctestDeviceSetRedirect: vi.fn(),
}));

vi.mock('../../platform-runtime-daemon-lifecycle.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platform-runtime-daemon-lifecycle.ts')>();
  return {
    platformDaemonLifecycleOwners: {
      ...actual.platformDaemonLifecycleOwners,
      restoreLegacyXctestDeviceSetRedirect: mockRestoreLegacyXctestDeviceSetRedirect,
    },
  };
});

import { restoreLegacyXctestDeviceSetForDaemonStartup } from './daemon-runtime.ts';

const roots: string[] = [];

afterEach(() => {
  mockRestoreLegacyXctestDeviceSetRedirect.mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function daemonLogPath(): string {
  const root = mkdtempForTestSync('agent-device-daemon-xctest-device-set-');
  roots.push(root);
  return path.join(root, 'daemon.log');
}

function loggedPhases(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { phase: string }).phase);
}

test('what the restore puts back is recorded in daemon.log', async () => {
  const logPath = daemonLogPath();
  mockRestoreLegacyXctestDeviceSetRedirect.mockImplementationOnce(async () => {
    emitDiagnostic({ level: 'warn', phase: 'ios_runner_legacy_xctest_device_set_link_removed' });
  });

  await restoreLegacyXctestDeviceSetForDaemonStartup(logPath);

  expect(loggedPhases(logPath)).toEqual(['ios_runner_legacy_xctest_device_set_link_removed']);
});

test('a restore that fails is recorded in daemon.log and does not fail the daemon startup', async () => {
  const logPath = daemonLogPath();
  mockRestoreLegacyXctestDeviceSetRedirect.mockRejectedValueOnce(
    Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
  );

  await expect(restoreLegacyXctestDeviceSetForDaemonStartup(logPath)).resolves.toBeUndefined();

  expect(loggedPhases(logPath)).toEqual(['ios_runner_legacy_xctest_device_set_restore_failed']);
});

test('a host with nothing to put back leaves daemon.log untouched', async () => {
  const logPath = daemonLogPath();
  mockRestoreLegacyXctestDeviceSetRedirect.mockResolvedValueOnce(undefined);

  await restoreLegacyXctestDeviceSetForDaemonStartup(logPath);

  expect(fs.existsSync(logPath)).toBe(false);
});
