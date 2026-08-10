import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';

test('Provider-backed integration daemon command policies gate admission and provider scoping', async () => {
  const adbCalls: string[][] = [];
  let activeRecordingPath: string | undefined;
  const inactiveLeaseMeta = {
    tenantId: 'tenant-a',
    runId: 'run-a',
    leaseId: '0'.repeat(32),
    sessionIsolation: 'tenant' as const,
  };
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => {
      adbCalls.push([...args]);
      const command = args.join(' ');
      const startedPath = screenRecordingPath(command);
      if (startedPath) activeRecordingPath = startedPath;
      return androidAdbResult(args, activeRecordingPath);
    },
  };

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        platformRuntime: true,
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

      const recordStart = await daemon.callCommand('record', ['start', '/tmp/policy-record.mp4'], {
        recordingScope: 'device',
      });
      assertRpcOk(recordStart);
      assert.ok(
        adbCalls.some((args) => isAndroidScreenrecordStartCommand(args.join(' '))),
        JSON.stringify(adbCalls),
      );
    },
  );
});

function androidAdbResult(args: string[], activeRecordingPath: string | undefined): AdbResult {
  const command = args.join(' ');
  return (
    deviceStatusResponse(command) ??
    recordingManifestResponse(command) ??
    screenRecordingProcessResponse(command, activeRecordingPath) ??
    recordingArtifactResponse(command, activeRecordingPath) ??
    adbResult()
  );
}

type AdbResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function adbResult(stdout = '', exitCode = 0): AdbResult {
  return { stdout, stderr: '', exitCode };
}

function deviceStatusResponse(command: string): AdbResult | undefined {
  if (command === 'shell getprop sys.boot_completed') {
    return adbResult('1\n');
  }
  if (command === 'shell wm size') {
    return adbResult('Physical size: 1080x1920\n');
  }
  return undefined;
}

function recordingManifestResponse(command: string): AdbResult | undefined {
  if (
    command.startsWith('shell test -e ') &&
    command.includes('agent-device-recording-active.json')
  ) {
    return adbResult('', 1);
  }
  if (command.startsWith('shell printf %s ') && command.includes('agent-device-recording-active')) {
    return adbResult();
  }
  return undefined;
}

function screenRecordingProcessResponse(
  command: string,
  activeRecordingPath: string | undefined,
): AdbResult | undefined {
  if (isAndroidScreenrecordStartCommand(command)) {
    return adbResult('4321\n');
  }
  if (command === 'shell cat /proc/4321/stat') {
    return adbResult(processStat(4321, '424242'));
  }
  if (command === 'shell cat /proc/4321/cmdline' && activeRecordingPath) {
    return adbResult(`screenrecord\u0000--bit-rate\u00008000000\u0000${activeRecordingPath}\u0000`);
  }
  if (command === 'shell ps -o pid= -p 4321') {
    return adbResult('4321\n');
  }
  return undefined;
}

function recordingArtifactResponse(
  command: string,
  activeRecordingPath: string | undefined,
): AdbResult | undefined {
  if (!activeRecordingPath) return undefined;
  if (command.startsWith('shell test -e ') && command.includes(activeRecordingPath)) {
    return adbResult();
  }
  if (/^shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)) {
    return adbResult('2048\n');
  }
  return undefined;
}

function isAndroidScreenrecordStartCommand(command: string): boolean {
  return command.startsWith('shell screenrecord ') && command.endsWith(' & echo $!');
}

function screenRecordingPath(command: string): string | undefined {
  const match = command.match(
    /^shell screenrecord .* (?:'([^']+)'|(\/\S+)) >\/dev\/null 2>&1 & echo \$!$/,
  );
  return match?.[1] ?? match?.[2];
}

function processStat(pid: number, startTime: string): string {
  return `${pid} (screenrecord) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${startTime}\n`;
}
