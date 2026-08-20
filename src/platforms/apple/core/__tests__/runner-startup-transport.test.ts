import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { ExecBackgroundResult } from '../../../../utils/exec.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { RunnerSession } from '../runner/runner-session-types.ts';
import {
  iosDevice,
  iosSimulator,
  makeTunnelIpLookup,
  makeTunnelIpLookupSequence,
  stubSuccessfulFetch,
  usbmuxDeviceUnattachedError,
  xctestIosDevice,
} from './runner-transport.fixtures.ts';

const { mockRunCmd, mockUsbmuxPostCommand } = vi.hoisted(() => ({
  mockRunCmd: vi.fn(),
  mockUsbmuxPostCommand: vi.fn(),
}));

vi.mock('../../../../utils/exec.ts', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/exec.ts')>(
    '../../../../utils/exec.ts',
  );
  return {
    ...actual,
    runCmd: mockRunCmd,
  };
});

vi.mock('../runner/runner-usbmux.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner/runner-usbmux.ts')>();
  return {
    ...actual,
    usbmuxRunnerTransport: {
      postCommand: mockUsbmuxPostCommand,
    },
  };
});

import { clearDeviceTunnelIpCache } from '../runner/runner-command-route.ts';
import { waitForRunner } from '../runner/runner-startup-transport.ts';

beforeEach(() => {
  clearDeviceTunnelIpCache();
  mockRunCmd.mockReset();
  mockUsbmuxPostCommand.mockReset();
  mockUsbmuxPostCommand.mockResolvedValue(new Response('{}'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
  mockUsbmuxPostCommand.mockRejectedValue(usbmuxDeviceUnattachedError());
  stubSuccessfulFetch();
  mockRunCmd.mockImplementation(makeTunnelIpLookup('fd00::123'));

  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);
  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);

  assert.equal(mockRunCmd.mock.calls.length, 1);
  const fetchCalls = vi.mocked(fetch).mock.calls;
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0]?.[0], 'http://[fd00::123]:8100/command');
  assert.equal(fetchCalls[1]?.[0], 'http://[fd00::123]:8100/command');
});

test('waitForRunner keeps tunnel IP lookup request-local when no tunnel IP is available', async () => {
  mockUsbmuxPostCommand.mockRejectedValue(usbmuxDeviceUnattachedError());
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
    iosSimulator.id,
    '/usr/bin/curl',
    '-s',
  ]);
});

test('waitForRunner wakes a simulator startup retry when the listener reports ready', async () => {
  vi.useFakeTimers();
  const readiness = new AbortController();
  const session: RunnerSession = {
    ...makeReadyRunnerSession(),
    ready: false,
    startupRetryWake: readiness.signal,
  };
  let fetchAttempts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      fetchAttempts += 1;
      if (fetchAttempts === 1) throw new Error('ECONNREFUSED');
      return new Response('{}');
    }),
  );

  const response = waitForRunner(
    iosSimulator,
    8100,
    { command: 'uptime' },
    undefined,
    5_000,
    session,
  );
  try {
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetchAttempts, 1);
    readiness.abort();
    assert.equal((await response).status, 200);
    assert.equal(fetchAttempts, 2);
  } finally {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  }
});

test('waitForRunner invalidates cached tunnel IP when localhost fallback succeeds', async () => {
  mockUsbmuxPostCommand.mockRejectedValue(usbmuxDeviceUnattachedError());
  mockRunCmd.mockImplementation(makeTunnelIpLookupSequence(['fd00::123', 'fd00::456']));
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

test('waitForRunner preserves xcodebuild diagnostics when the runner exits during the final probe', async () => {
  const session: RunnerSession = {
    sessionId: 'starting-device-session',
    device: xctestIosDevice,
    deviceId: xctestIosDevice.id,
    port: 8100,
    xctestrunPath: '/tmp/runner.xctestrun',
    jsonPath: '/tmp/runner.json',
    testPromise: Promise.resolve({
      exitCode: 65,
      stdout: '',
      stderr:
        'The application could not be launched because the Developer App Certificate is not trusted.',
    }),
    child: { pid: 1234, exitCode: null } as ExecBackgroundResult['child'],
    ready: false,
  };
  mockUsbmuxPostCommand.mockImplementation(async () => {
    (session.child as { exitCode: number | null }).exitCode = 65;
    throw new Error('ECONNREFUSED');
  });

  await assert.rejects(
    () =>
      waitForRunner(xctestIosDevice, 8100, { command: 'uptime' }, '/tmp/runner.log', 100, session),
    (error: unknown) => {
      const appError = error as AppError;
      assert.equal(appError.message, 'Runner did not accept connection (xcodebuild exited early)');
      assert.equal(
        (appError.details?.xcodebuild as { exitCode?: number } | undefined)?.exitCode,
        65,
      );
      assert.match(
        String((appError.details?.xcodebuild as { stderr?: string } | undefined)?.stderr),
        /Developer App Certificate is not trusted/,
      );
      return true;
    },
  );

  assert.equal(mockUsbmuxPostCommand.mock.calls.length, 1);
});

test('waitForRunner reports the usbmux verdict for xctest devices without retrying', async () => {
  // Regression: an XCTest device has no tunnel, so retrying cannot attach a
  // cable. Before this was terminal, readiness preflight and read-only
  // commands burned the whole connect budget and lost the recovery hint.
  mockUsbmuxPostCommand.mockRejectedValue(usbmuxDeviceUnattachedError());
  stubSuccessfulFetch();

  await assert.rejects(
    () => waitForRunner(xctestIosDevice, 8100, { command: 'snapshot' }, undefined, 5_000),
    (error: unknown) => {
      const appError = error as AppError;
      assert.equal(appError.code, 'DEVICE_NOT_FOUND');
      assert.match(String(appError.details?.hint), /Connect the device by cable/);
      assert.equal(appError.message.includes('Runner did not accept connection'), false);
      return true;
    },
  );

  assert.equal(mockUsbmuxPostCommand.mock.calls.length, 1);
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('waitForRunner routes coredevice physical devices through usbmux first', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const response = await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);

  assert.equal(response.status, 200);
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.equal(mockRunCmd.mock.calls.length, 0);
  assert.equal(mockUsbmuxPostCommand.mock.calls.length, 1);
});

test('waitForRunner falls back to the tunnel route inside the same attempt', async () => {
  mockUsbmuxPostCommand.mockRejectedValue(usbmuxDeviceUnattachedError());
  stubSuccessfulFetch();
  mockRunCmd.mockImplementation(makeTunnelIpLookup('fd00::123'));

  const response = await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);

  assert.equal(response.status, 200);
  // One usbmux probe, then the tunnel endpoint — no retry round trip in between.
  assert.equal(mockUsbmuxPostCommand.mock.calls.length, 1);
  assert.equal(vi.mocked(fetch).mock.calls[0]?.[0], 'http://[fd00::123]:8100/command');
});

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
