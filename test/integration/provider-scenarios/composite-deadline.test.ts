import assert from 'node:assert/strict';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../src/__tests__/test-utils/android-snapshot-helper.ts';
import { createProviderScenarioHarness } from './harness.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { respondToAndroidSettingsAdbCommand } from './android-world.ts';
import { assertRpcOk } from './assertions.ts';

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
    let signal: AbortSignal | undefined;
    let retired = false;
    let diagnosticCaptureAfterAbort = false;
    let pendingDeadlineResult = true;
    const completedActions: string[] = [];
    let searchText = '';
    const daemon = await createProviderScenarioHarness({
      deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      env: { AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION: '0' },
      androidAdbProvider: () => ({
        snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
        text: async (request) => {
          searchText = request.text;
          completedActions.push('fill');
        },
        exec: async (args, options) => {
          if (args.join(' ').includes('AGENT_DEVICE_NO_HELPER'))
            return { exitCode: 0, stdout: 'AGENT_DEVICE_NO_HELPER\n', stderr: '' };
          if (args[0] === 'shell' && args[1] === 'input' && args[2] === 'tap') {
            completedActions.push('press');
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (args.includes('instrument') && args.includes('gesture')) {
            signal = options?.signal;
            started();
            assert.ok(signal, 'longpress must carry the request signal to its helper');
            return await new Promise<never>((_resolve, reject) => {
              signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
            });
          }
          if (pendingDeadlineResult && signal?.aborted && args.includes('instrument')) {
            diagnosticCaptureAfterAbort = true;
            throw new Error('post-failure snapshot transport is stalled');
          }
          if (args.includes('force-stop')) {
            if (signal?.aborted) retired = true;
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
          if (searchText && args.includes('instrument')) observedFill();
          return respondToAndroidSettingsAdbCommand([...args], searchText, '', {});
        },
      }),
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
      assert.deepEqual(completedActions, ['press', 'fill']);
      await vi.advanceTimersByTimeAsync(timeoutMs);
      const response = await pending;
      pendingDeadlineResult = false;
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
      assert.equal(signal?.aborted, true);
      assert.equal(diagnosticCaptureAfterAbort, false);
      assert.equal(
        retired,
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
