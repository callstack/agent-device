import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';
import { assertRpcOk } from './assertions.ts';
import {
  PROVIDER_SCENARIO_ANDROID,
  PROVIDER_SCENARIO_IOS_SIMULATOR,
  PROVIDER_SCENARIO_LINUX,
  PROVIDER_SCENARIO_MACOS,
  PROVIDER_SCENARIO_WEB,
} from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';

test('Provider-backed integration doctor reports Android RN/Metro readiness through daemon route', async () => {
  const server = await startMetroStatusServer();
  const adbCalls: string[][] = [];
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => {
      adbCalls.push([...args]);
      return androidDoctorAdbResult(args, server.port);
    },
  };

  try {
    await withProviderScenarioResource(
      async () =>
        await createProviderScenarioHarness({
          androidAdbProvider: () => adbProvider,
          deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
        }),
      async (daemon) => {
        const response = await daemon.callCommand('doctor', [], {
          platform: 'android',
          targetApp: 'com.example.app',
          kind: 'react-native',
          metroPort: server.port,
        });
        assertRpcOk(response);
        const data = response.json.result.data;
        assert.equal(data.status, 'pass');
        assertDoctorCheck(data, 'metro', 'pass');
        assertDoctorCheck(data, 'android-reverse', 'pass');
        assertDoctorCheck(data, 'android-animations', 'pass');
        assert.ok(
          adbCalls.some((args) => args.join(' ') === 'reverse --list'),
          JSON.stringify(adbCalls),
        );
      },
    );
  } finally {
    await server.close();
  }
});

test('Provider-backed integration doctor runs predictably for supported platform selectors', async () => {
  const devices = [
    PROVIDER_SCENARIO_ANDROID,
    PROVIDER_SCENARIO_IOS_SIMULATOR,
    PROVIDER_SCENARIO_MACOS,
    PROVIDER_SCENARIO_LINUX,
    PROVIDER_SCENARIO_WEB,
  ];
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => androidDoctorAdbResult(args, 8081),
  };

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        androidAdbProvider: () => adbProvider,
        deviceInventoryProvider: async () => devices,
      }),
    async (daemon) => {
      for (const device of devices) {
        const response = await daemon.callCommand('doctor', [], {
          platform: device.platform,
          kind: device.platform === 'ios' || device.platform === 'android' ? 'auto' : 'expo',
        });
        assertRpcOk(response);
        const data = response.json.result.data;
        assert.equal(data.platform, device.platform);
        assert.ok(Array.isArray(data.checks), `${device.platform} checks`);
        if (device.platform !== 'ios' && device.platform !== 'android') {
          assertDoctorCheck(data, 'platform-scope', 'info');
        }
      }
    },
  );
});

function assertDoctorCheck(
  data: { checks: Array<{ id: string; status: string }> },
  id: string,
  status: string,
): void {
  const check = data.checks.find((entry) => entry.id === id);
  assert.ok(check, `missing ${id}: ${JSON.stringify(data.checks)}`);
  assert.equal(check.status, status);
}

function androidDoctorAdbResult(
  args: string[],
  metroPort: number,
): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const command = args.join(' ');
  if (command === 'shell dumpsys window windows') {
    return {
      stdout: 'mCurrentFocus=Window{123 u0 com.example.app/.MainActivity}\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (command === 'reverse --list') {
    return {
      stdout: `emulator-5554 tcp:${metroPort} tcp:${metroPort}\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  if (command.startsWith('shell settings get global ')) {
    return { stdout: '0\n', stderr: '', exitCode: 0 };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

async function startMetroStatusServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('packager-status:running');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
