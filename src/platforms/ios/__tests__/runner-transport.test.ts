import fs from 'node:fs';
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '../../../kernel/device.ts';
import type { ExecBackgroundResult } from '../../../utils/exec.ts';
import { AppError } from '../../../kernel/errors.ts';
import type { RunnerSession } from '../../apple/core/runner/runner-session-types.ts';

const { mockRunCmd } = vi.hoisted(() => ({
  mockRunCmd: vi.fn(),
}));

vi.mock('../../../utils/exec.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../../../utils/exec.ts')>('../../../utils/exec.ts');
  return {
    ...actual,
    runCmd: mockRunCmd,
  };
});

import {
  clearDeviceTunnelIpCache,
  sendRunnerCommandOnce,
  waitForRunner,
} from '../../apple/core/runner/runner-transport.ts';

const iosSimulator: DeviceInfo = {
  platform: 'ios',
  id: 'sim-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

const iosDevice: DeviceInfo = {
  platform: 'ios',
  id: 'device-1',
  name: 'iPhone',
  kind: 'device',
  booted: true,
};

beforeEach(() => {
  clearDeviceTunnelIpCache();
  mockRunCmd.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('waitForRunner propagates request cancellation without fallback', async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(
    () =>
      waitForRunner(
        iosSimulator,
        8100,
        { command: 'snapshot' },
        undefined,
        5_000,
        undefined,
        signal,
      ),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      const appError = error as AppError;
      assert.equal(appError.code, 'COMMAND_FAILED');
      assert.equal(appError.message, 'request canceled');
      assert.equal(appError.message.includes('Runner did not accept connection'), false);
      return true;
    },
  );
});

test('waitForRunner reuses cached physical-device tunnel IP across commands', async () => {
  stubSuccessfulFetch();
  mockRunCmd.mockImplementation(async (_cmd: string, args: string[]) => {
    const jsonPath = args[args.indexOf('--json-output') + 1]!;
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        info: { outcome: 'success' },
        result: { connectionProperties: { tunnelIPAddress: 'fd00::123' } },
      }),
    );
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);
  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);

  assert.equal(mockRunCmd.mock.calls.length, 1);
  const fetchCalls = vi.mocked(fetch).mock.calls;
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0]?.[0], 'http://[fd00::123]:8100/command');
  assert.equal(fetchCalls[1]?.[0], 'http://[fd00::123]:8100/command');
});

test('waitForRunner keeps tunnel IP lookup request-local when no tunnel IP is available', async () => {
  stubSuccessfulFetch();
  mockRunCmd.mockImplementation(async () => ({ exitCode: 1, stdout: '', stderr: '' }));

  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);

  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.equal(vi.mocked(fetch).mock.calls[0]?.[0], 'http://127.0.0.1:8100/command');
});

test('waitForRunner uses simulator fallback within the attempt for ready sessions', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }),
  );
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '{"ok":true}', stderr: '' });

  const response = await waitForRunner(
    iosSimulator,
    8100,
    { command: 'uptime' },
    undefined,
    5_000,
    makeReadyRunnerSession(),
  );

  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(vi.mocked(fetch).mock.calls.length, 1);
  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.equal(mockRunCmd.mock.calls[0]?.[0], 'xcrun');
  assert.deepEqual(mockRunCmd.mock.calls[0]?.[1]?.slice(0, 5), [
    'simctl',
    'spawn',
    'sim-1',
    '/usr/bin/curl',
    '-s',
  ]);
});

test('waitForRunner invalidates cached tunnel IP when localhost fallback succeeds', async () => {
  const tunnelIps = ['fd00::123', 'fd00::456'];
  mockRunCmd.mockImplementation(async (_cmd: string, args: string[]) => {
    const jsonPath = args[args.indexOf('--json-output') + 1]!;
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        info: { outcome: 'success' },
        result: { connectionProperties: { tunnelIPAddress: tunnelIps.shift() } },
      }),
    );
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  let staleTunnelFailed = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'http://[fd00::123]:8100/command' && staleTunnelFailed) {
        throw new Error('stale tunnel');
      }
      if (url === 'http://[fd00::123]:8100/command') {
        staleTunnelFailed = true;
      }
      return new Response('{}');
    }),
  );

  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);
  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);
  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);

  const fetchCalls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
  assert.equal(mockRunCmd.mock.calls.length, 2);
  assert.deepEqual(fetchCalls, [
    'http://[fd00::123]:8100/command',
    'http://[fd00::123]:8100/command',
    'http://127.0.0.1:8100/command',
    'http://[fd00::456]:8100/command',
  ]);
});

test('sendRunnerCommandOnce does not retry or simulator fallback after request failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('request timed out after reaching runner');
    }),
  );

  await assert.rejects(() =>
    sendRunnerCommandOnce(iosSimulator, 8100, { command: 'tap', x: 120, y: 240 }, 5_000),
  );

  assert.equal(vi.mocked(fetch).mock.calls.length, 1);
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

function stubSuccessfulFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}')),
  );
}

function makeReadyRunnerSession(): RunnerSession {
  return {
    sessionId: 'ready-session',
    device: iosSimulator,
    deviceId: iosSimulator.id,
    port: 8100,
    xctestrunPath: '/tmp/runner.xctestrun',
    jsonPath: '/tmp/runner.json',
    testPromise: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    child: { pid: 1234, exitCode: null } as ExecBackgroundResult['child'],
    ready: true,
  };
}
