import { vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { runCmd } from '@agent-device/host-kit/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import * as diagnosticsModule from '@agent-device/host-kit/diagnostics';
import { sleep } from '../../adb.ts';
import { snapshotAndroid } from '../../snapshot.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../../snapshot-helper-session-lifecycle.ts';
import type { AndroidAdbExecutor } from '../../snapshot-helper.ts';
import { mkdtempForTest } from './android-host-test-setup.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './android-snapshot-helper.ts';
import {
  androidHelperInstrumentationOutput as helperOutput,
  isAndroidHelperRuntimeForceStop as isHelperRuntimeReset,
  ANDROID_HELPER_INSTALLED_VERSION_PROBE as installedHelperProbe,
} from '../snapshot-helper-session.fixtures.ts';

export const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+b9xkAAAAASUVORK5CYII=',
  'base64',
);

export const mockRunCmd = vi.mocked(runCmd);

export const mockSleep = vi.mocked(sleep);

export const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

export const helperArtifact = ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT;

export function snapshotAndroidWithHelper(
  helperAdb: AndroidAdbExecutor,
  options: Omit<
    NonNullable<Parameters<typeof snapshotAndroid>[1]>,
    'helperAdb' | 'helperArtifact'
  > = {},
) {
  return snapshotAndroid(device, {
    ...options,
    helperAdb,
    helperArtifact,
  });
}

export function createHelperAdb(
  handlers: Partial<Record<'instrument' | 'activity', AndroidAdbExecutor>>,
): AndroidAdbExecutor {
  return async (args, options) => {
    if (isHelperVersionProbe(args)) return installedHelperProbe;
    if (isHelperRuntimeReset(args)) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const operation = helperAdbOperation(args);
    const handler = operation ? handlers[operation] : undefined;
    if (handler) return await handler(args, options);
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };
}

function isHelperVersionProbe(args: readonly string[]): boolean {
  return args.includes('--show-versioncode');
}

function helperAdbOperation(args: readonly string[]): 'instrument' | 'activity' | undefined {
  if (args.includes('instrument')) return 'instrument';
  return args.includes('dumpsys') && args.includes('activity') ? 'activity' : undefined;
}

export function androidSnapshotHelperAdb(xml: string, activityDump?: string): AndroidAdbExecutor {
  return createHelperAdb({
    instrument: async () => ({ exitCode: 0, stdout: helperOutput(xml), stderr: '' }),
    ...(activityDump === undefined
      ? {}
      : { activity: async () => ({ exitCode: 0, stdout: activityDump, stderr: '' }) }),
  });
}

export function isAndroidSdkVersionCommand(args: readonly string[]): boolean {
  return (
    args.includes('shell') && args.includes('getprop') && args.includes('ro.build.version.sdk')
  );
}

export async function captureDiagnostics(
  scope: Parameters<typeof diagnosticsModule.withDiagnosticsScope>[0],
  callback: () => Promise<string | null>,
): Promise<string> {
  const previousHome = process.env.HOME;
  process.env.HOME = await mkdtempForTest('agent-device-android-diag-');
  try {
    const diagnosticsPath = await diagnosticsModule.withDiagnosticsScope(scope, callback);
    assert.ok(diagnosticsPath);
    return await fs.readFile(diagnosticsPath, 'utf8');
  } finally {
    process.env.HOME = previousHome;
  }
}

export async function resetSnapshotTestState(): Promise<void> {
  await resetAndroidSnapshotHelperSessions();
  resetAndroidSnapshotHelperInstallCache();
  mockRunCmd.mockReset();
  mockSleep.mockReset();
  mockSleep.mockResolvedValue(undefined);
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('exec-out')) {
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: VALID_PNG };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}
