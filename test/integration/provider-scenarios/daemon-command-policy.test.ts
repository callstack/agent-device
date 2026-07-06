import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';

test('Provider-backed integration daemon command policies gate admission and provider scoping', async () => {
  const adbCalls: string[][] = [];
  const inactiveLeaseMeta = {
    tenantId: 'tenant-a',
    runId: 'run-a',
    leaseId: '0'.repeat(32),
    sessionIsolation: 'tenant' as const,
  };
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => {
      adbCalls.push([...args]);
      return androidAdbResult(args);
    },
  };

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        androidAdbProvider: () => adbProvider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      }),
    async (daemon) => {
      const devices = await daemon.callCommand(
        'devices',
        [],
        { platform: 'android' },
        { meta: inactiveLeaseMeta },
      );
      assertRpcOk(devices);

      const capabilities = await daemon.callCommand(
        'capabilities',
        [],
        { platform: 'android' },
        { meta: inactiveLeaseMeta },
      );
      const capabilitiesData = assertRpcOk<{
        device?: { id?: unknown; platform?: unknown; kind?: unknown };
        availableCommands?: string[];
      }>(capabilities);
      assert.equal(capabilitiesData.device?.id, PROVIDER_SCENARIO_ANDROID.id);
      assert.equal(capabilitiesData.device?.platform, 'android');
      assert.equal(capabilitiesData.device?.kind, 'emulator');
      assert.ok(Array.isArray(capabilitiesData.availableCommands));
      assert.ok(capabilitiesData.availableCommands.includes('open'));
      assert.ok(capabilitiesData.availableCommands.includes('press'));

      const blockedSnapshot = await daemon.callCommand(
        'snapshot',
        [],
        { platform: 'android' },
        { meta: inactiveLeaseMeta },
      );
      assertRpcError(blockedSnapshot, 'UNAUTHORIZED', /Lease is not active/);

      const recordStart = await daemon.callCommand('record', ['start', '/tmp/policy-record.mp4']);
      assertRpcOk(recordStart);
      assert.ok(
        adbCalls.some((args) => isAndroidScreenrecordStartCommand(args.join(' '))),
        JSON.stringify(adbCalls),
      );
    },
  );
});

function androidAdbResult(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const command = args.join(' ');
  if (command === 'shell getprop sys.boot_completed') {
    return { stdout: '1\n', stderr: '', exitCode: 0 };
  }
  if (command === 'shell wm size') {
    return { stdout: 'Physical size: 1080x1920\n', stderr: '', exitCode: 0 };
  }
  if (isAndroidScreenrecordStartCommand(command)) {
    return { stdout: '4321\n', stderr: '', exitCode: 0 };
  }
  if (/^shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)) {
    return { stdout: '2048\n', stderr: '', exitCode: 0 };
  }
  if (command === 'shell ps -o pid= -p 4321') {
    return { stdout: '4321\n', stderr: '', exitCode: 0 };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

function isAndroidScreenrecordStartCommand(command: string): boolean {
  return command.startsWith('shell screenrecord ') && command.endsWith(' & echo $!');
}
