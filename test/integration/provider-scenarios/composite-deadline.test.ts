import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import type {
  AndroidAdbExecutorResult,
  AndroidAdbProvider,
} from '@agent-device/platform-android/mechanics';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../src/__tests__/test-utils/android-snapshot-helper.ts';
import { createProviderScenarioHarness } from './harness.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { respondToAndroidSettingsAdbCommand } from './android-world.ts';
import { assertRpcOk } from './assertions.ts';

type DeadlineAdbState = {
  started: () => void;
  observedFill: () => void;
  signal?: AbortSignal;
  retired: boolean;
  diagnosticCaptureAfterAbort: boolean;
  pendingDeadlineResult: boolean;
  completedActions: string[];
  searchText: string;
};

function awaitGestureAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function deadlineAdbInfrastructureResponse(
  args: readonly string[],
  state: DeadlineAdbState,
): AndroidAdbExecutorResult | undefined {
  if (args.join(' ').includes('AGENT_DEVICE_NO_HELPER'))
    return { exitCode: 0, stdout: 'AGENT_DEVICE_NO_HELPER\n', stderr: '' };
  if (args[0] === 'shell' && args[1] === 'input' && args[2] === 'tap') {
    state.completedActions.push('press');
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  if (args.includes('force-stop')) {
    if (state.signal?.aborted) state.retired = true;
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  if (args.includes('--show-versioncode'))
    return {
      exitCode: 0,
      stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:999999',
      stderr: '',
    };
  if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start')
    return { exitCode: 0, stdout: 'Starting: Intent', stderr: '' };
  return undefined;
}

function deadlineAdbProvider(state: DeadlineAdbState): AndroidAdbProvider {
  return {
    snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    text: async (request) => {
      state.searchText = request.text;
      state.completedActions.push('fill');
    },
    exec: async (args, options) => {
      const infrastructure = deadlineAdbInfrastructureResponse(args, state);
      if (infrastructure) return infrastructure;
      if (args.includes('instrument') && args.includes('gesture')) {
        state.signal = options?.signal;
        state.started();
        assert.ok(state.signal, 'longpress must carry the request signal to its helper');
        return await awaitGestureAbort(state.signal);
      }
      if (state.pendingDeadlineResult && state.signal?.aborted && args.includes('instrument')) {
        state.diagnosticCaptureAfterAbort = true;
        throw new Error('post-failure snapshot transport is stalled');
      }
      if (state.searchText && args.includes('instrument')) state.observedFill();
      return respondToAndroidSettingsAdbCommand([...args], state.searchText, '', {});
    },
  };
}

test('routed batch install reports its deadline and does not dispatch a later step', async () => {
  let installStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    installStarted = resolve;
  });
  let installSignal: AbortSignal | undefined;
  const actions: string[] = [];
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
    androidAdbProvider: () => ({
      exec: async (args) => {
        if (args[0] === 'shell' && args[1] === 'input' && args[2] === 'tap') {
          actions.push('press');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start')
          return { exitCode: 0, stdout: 'Starting: Intent', stderr: '' };
        return respondToAndroidSettingsAdbCommand([...args], '', '', {});
      },
      install: async (_apk, options) => {
        actions.push('install');
        installSignal = options?.signal;
        installStarted();
        assert.ok(installSignal, 'install must receive the routed request signal');
        return await awaitGestureAbort(installSignal);
      },
    }),
  });
  try {
    await daemon.client().apps.open({
      app: 'com.android.settings',
      platform: 'android',
      serial: PROVIDER_SCENARIO_ANDROID.id,
    });
    const apkPath = path.join(daemon.stateDir, 'deadline-install.apk');
    fs.writeFileSync(apkPath, 'fixture apk');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = daemon.callCommand('batch', [], {
      platform: 'android',
      serial: PROVIDER_SCENARIO_ANDROID.id,
      batchSteps: [
        { command: 'press', positionals: ['20', '30'] },
        { command: 'install', positionals: [apkPath] },
        { command: 'press', positionals: ['40', '50'] },
      ],
    });
    await Promise.race([
      started,
      pending.then((response) => assert.fail(JSON.stringify(response.json))),
    ]);
    assert.deepEqual(actions, ['press', 'install']);
    await vi.advanceTimersByTimeAsync(60_000);
    const response = await pending;
    assert.equal(response.json.error?.data?.details?.reason, 'daemon_request_timeout');
    expect(response.json.error.data.details).toMatchObject({
      timeoutMs: 60_000,
      executed: 1,
      total: 3,
      step: 2,
      command: 'install',
      partialResults: [{ step: 1, command: 'press', ok: true }],
    });
    assert.equal(installSignal?.aborted, true);
    assert.equal(isRequestCanceledError(installSignal.reason), true);
    assert.deepEqual(actions, ['press', 'install']);
  } finally {
    vi.useRealTimers();
    await daemon.close();
  }
});

test.each(['batch', 'replay'])(
  '%s deadline cancels Android longpress instrumentation and preserves its session',
  async (command) => {
    let started!: () => void;
    const injecting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedFill!: () => void;
    const fillObservation = new Promise<void>((resolve) => {
      observedFill = resolve;
    });
    const state: DeadlineAdbState = {
      started,
      observedFill,
      retired: false,
      diagnosticCaptureAfterAbort: false,
      pendingDeadlineResult: true,
      completedActions: [],
      searchText: '',
    };
    const daemon = await createProviderScenarioHarness({
      deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      env: { AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION: '0' },
      androidAdbProvider: () => deadlineAdbProvider(state),
    });
    try {
      await daemon.client().apps.open({
        app: 'com.android.settings',
        platform: 'android',
        serial: PROVIDER_SCENARIO_ANDROID.id,
      });
      const script = path.join(daemon.stateDir, 'hold.ad');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const timeoutMs = command === 'batch' ? 60_000 : 1_000;
      const pending = daemon.callCommand(command, command === 'replay' ? [script] : [], {
        platform: 'android',
        serial: PROVIDER_SCENARIO_ANDROID.id,
        ...(command === 'batch'
          ? {
              batchSteps: [
                { command: 'press', positionals: ['20', '30'] },
                {
                  command: 'fill',
                  positionals: ['20', '40', 'deadline proof'],
                },
                { command: 'longpress', positionals: ['20', '30', '120000'] },
              ],
            }
          : {
              timeoutMs,
              replayScriptSource: {
                entry: script,
                files: {
                  [script]:
                    '# completed actions must not be replayed\npress 20 30\nfill 20 40 "deadline proof"\nlongpress 20 30 120000\n',
                },
              },
            }),
      });
      await fillObservation;
      await vi.advanceTimersByTimeAsync(150);
      await Promise.race([
        injecting,
        pending.then((response) => assert.fail(JSON.stringify(response.json))),
      ]);
      assert.deepEqual(state.completedActions, ['press', 'fill']);
      await vi.advanceTimersByTimeAsync(timeoutMs);
      const response = await pending;
      state.pendingDeadlineResult = false;
      assert.equal(
        response.json.error?.data?.details?.reason,
        'daemon_request_timeout',
        JSON.stringify(response.json),
      );
      assert.equal(response.json.error.data.details.timeoutMs, timeoutMs);
      if (command === 'batch') {
        expect(response.json.error.data.details).toMatchObject({
          executed: 2,
          total: 3,
          step: 3,
          command: 'longpress',
          dispatched: 'unknown',
          partialResults: [
            { step: 1, command: 'press', ok: true },
            { step: 2, command: 'fill', ok: true },
          ],
        });
      } else {
        expect(response.json.error.data.details).toMatchObject({
          divergence: { step: { source: { path: script, line: 4 } } },
        });
      }
      assert.equal(state.signal?.aborted, true);
      assert.equal(state.diagnosticCaptureAfterAbort, false);
      assert.equal(
        state.retired,
        true,
        'canceled one-shot instrumentation must release its device runtime',
      );
      vi.useRealTimers();
      assert.equal(await daemon.hasSession(), true);
      assertRpcOk(await daemon.callCommand('snapshot', [], { snapshotInteractiveOnly: true }));
    } finally {
      vi.useRealTimers();
      await daemon.close();
    }
  },
  20_000,
);

test('annotated replay capture aborts within its deadline without post-failure fallback', async () => {
  let captureStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    captureStarted = resolve;
  });
  let captureSignal: AbortSignal | undefined;
  let captureAfterAbort = false;
  let captureAttempts = 0;
  let stallReplayCapture = false;
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
    env: { AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION: '0' },
    androidAdbProvider: () => ({
      snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
      exec: async (args, options) => {
        if (stallReplayCapture && args.includes('instrument')) {
          captureAttempts += 1;
          if (captureSignal?.aborted) captureAfterAbort = true;
          captureSignal = options?.signal;
          captureStarted();
          if (!captureSignal) throw new Error('annotated replay capture lost the request signal');
          return await awaitGestureAbort(captureSignal);
        }
        if (args.includes('--show-versioncode'))
          return {
            exitCode: 0,
            stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:999999',
            stderr: '',
          };
        if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start')
          return { exitCode: 0, stdout: 'Starting: Intent', stderr: '' };
        return respondToAndroidSettingsAdbCommand([...args], '', '', {});
      },
    }),
  });
  try {
    await daemon.client().apps.open({
      app: 'com.android.settings',
      platform: 'android',
      serial: PROVIDER_SCENARIO_ANDROID.id,
    });
    stallReplayCapture = true;
    const script = path.join(daemon.stateDir, 'annotated.ad');
    const source = [
      '# agent-device:target-v1 {"role":"button","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"unverifiable"}',
      'click @e1',
      '',
    ].join('\n');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = daemon.callCommand('replay', [script], {
      platform: 'android',
      serial: PROVIDER_SCENARIO_ANDROID.id,
      timeoutMs: 1_000,
      replayScriptSource: { entry: script, files: { [script]: source } },
    });
    await started;
    assert.ok(captureSignal, 'target observation must carry the request signal');
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await pending;
    assert.equal(
      response.json.error?.data?.details?.reason,
      'daemon_request_timeout',
      JSON.stringify(response.json),
    );
    expect(response.json.error.data.details).toMatchObject({
      timeoutMs: 1_000,
      divergence: { step: { source: { path: script, line: 2 } } },
    });
    assert.equal(captureSignal.aborted, true);
    assert.equal(captureAttempts, 1);
    assert.equal(captureAfterAbort, false);
  } finally {
    vi.useRealTimers();
    await daemon.close();
  }
}, 20_000);
