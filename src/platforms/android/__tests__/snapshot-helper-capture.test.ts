import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { captureAndroidSnapshotWithHelper } from '../snapshot-helper-capture.ts';
import { resetAndroidSnapshotHelperRetirements } from '../snapshot-helper-retirement.ts';
import type { AndroidAdbExecutor } from '../snapshot-helper-types.ts';

beforeEach(() => {
  resetAndroidSnapshotHelperRetirements();
});

test('one-shot capture that resolves during cancellation retires before rejecting', async () => {
  const controller = new AbortController();
  const cancellation = new Error('wait deadline exceeded');
  const events: string[] = [];
  let releaseRetirement: (() => void) | undefined;
  const retirementCanFinish = new Promise<void>((resolve) => {
    releaseRetirement = resolve;
  });
  const adb: AndroidAdbExecutor = async (args, options) => {
    if (args.join(' ').includes('am instrument')) {
      return await new Promise((resolve) => {
        const onAbort = () => {
          events.push('instrumentation-resolved');
          resolve({
            exitCode: 0,
            stdout: helperOutput('<hierarchy></hierarchy>'),
            stderr: '',
          });
        };
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        if (options?.signal?.aborted) onAbort();
      });
    }
    assert.deepEqual(args, [
      'shell',
      'am',
      'force-stop',
      'com.callstack.agentdevice.snapshothelper',
    ]);
    assert.notEqual(options?.signal, controller.signal);
    assert.equal(options?.signal?.aborted, false);
    events.push('retirement-started');
    await retirementCanFinish;
    events.push('retirement-finished');
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const capture = captureAndroidSnapshotWithHelper({
    adb,
    deviceKey: 'android:emulator-5554',
    signal: controller.signal,
  });
  let rejected = false;
  void capture.catch(() => {
    rejected = true;
    events.push('capture-rejected');
  });

  controller.abort(cancellation);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rejected, false);
  assert.deepEqual(events, ['instrumentation-resolved', 'retirement-started']);

  releaseRetirement?.();
  await assert.rejects(capture, cancellation);
  assert.deepEqual(events, [
    'instrumentation-resolved',
    'retirement-started',
    'retirement-finished',
    'capture-rejected',
  ]);
});

test('uncertain one-shot retirement is quarantined until the next capture recovers it', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  let forceStopCount = 0;
  const adb: AndroidAdbExecutor = async (args, options) => {
    if (args.join(' ').includes('am force-stop')) {
      forceStopCount += 1;
      events.push(`force-stop-${forceStopCount}`);
      return {
        exitCode: forceStopCount === 1 ? 1 : 0,
        stdout: '',
        stderr: forceStopCount === 1 ? 'runtime still busy' : '',
      };
    }
    events.push(`instrument-${forceStopCount}`);
    if (forceStopCount === 0) {
      return await new Promise((_resolve, reject) => {
        const onAbort = () => reject(options?.signal?.reason);
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        if (options?.signal?.aborted) onAbort();
      });
    }
    return {
      exitCode: 0,
      stdout: helperOutput('<hierarchy><node text="recovered" /></hierarchy>'),
      stderr: '',
    };
  };
  const canceledCapture = captureAndroidSnapshotWithHelper({
    adb,
    deviceKey: 'android:emulator-5554',
    signal: controller.signal,
  });
  controller.abort(new Error('wait deadline exceeded'));

  await assert.rejects(
    canceledCapture,
    (error: unknown) =>
      (error as { details?: { reason?: string } }).details?.reason ===
      'android_snapshot_helper_retirement_unconfirmed',
  );
  const recovered = await captureAndroidSnapshotWithHelper({
    adb,
    deviceKey: 'android:emulator-5554',
  });

  assert.match(recovered.xml, /recovered/);
  assert.deepEqual(events, ['instrument-0', 'force-stop-1', 'force-stop-2', 'instrument-2']);
});

function helperOutput(xml: string): string {
  return [
    'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_STATUS: helperApiVersion=1',
    'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_STATUS: chunkIndex=0',
    'INSTRUMENTATION_STATUS: chunkCount=1',
    `INSTRUMENTATION_STATUS: payloadBase64=${Buffer.from(xml, 'utf8').toString('base64')}`,
    'INSTRUMENTATION_STATUS_CODE: 1',
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_RESULT: helperApiVersion=1',
    'INSTRUMENTATION_RESULT: ok=true',
    'INSTRUMENTATION_RESULT: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');
}
