import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { recordInstrumentationProcess } from '../instrumentation-helper.ts';
import {
  SESSION_TRANSPORT_UNSUPPORTED_REASON,
  waitForAndroidSnapshotHelperSessionReady,
} from '../snapshot-helper-session-protocol.ts';
import { FakeAndroidProcess } from './snapshot-helper-session.fixtures.ts';

const READY_HEAD = [
  'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
  'INSTRUMENTATION_STATUS: sessionCommands=input,snapshot-immediate',
].join('\n');

function waitForReady(process: FakeAndroidProcess) {
  return waitForAndroidSnapshotHelperSessionReady(
    process,
    5_000,
    undefined,
    recordInstrumentationProcess(process),
  );
}

test('an adb warning on stderr between two halves of the transport line keeps the record whole', async () => {
  const process = new FakeAndroidProcess();
  const ready = waitForReady(process);
  process.stdout.write(`${READY_HEAD}\nINSTRUMENTATION_STATUS: sessionTrans`);
  process.stderr.write('adb: warning: stdout is not a tty\n');
  process.stdout.write(
    'port=localabstract-peer-uid-v1\nINSTRUMENTATION_STATUS: sessionReady=true\nINSTRUMENTATION_STATUS_CODE: 2\n',
  );

  assert.deepEqual([...(await ready)], ['input', 'snapshot-immediate']);
});

test('a complete readiness record without the transport line is an unsupported transport', async () => {
  const process = new FakeAndroidProcess();
  const ready = waitForReady(process).catch((error: unknown) => error);
  process.stdout.write(
    `${READY_HEAD}\nINSTRUMENTATION_STATUS: sessionReady=true\nINSTRUMENTATION_STATUS_CODE: 2\n`,
  );

  const error = await ready;
  assert.ok(error instanceof AppError);
  assert.equal(error.details?.reason, SESSION_TRANSPORT_UNSUPPORTED_REASON);
});

test('a readiness record from another protocol is malformed, not an unsupported transport', async () => {
  const process = new FakeAndroidProcess();
  const ready = waitForAndroidSnapshotHelperSessionReady(
    process,
    1_000,
    undefined,
    recordInstrumentationProcess(process),
  ).catch((error: unknown) => error);
  process.stdout.write(
    [
      'INSTRUMENTATION_STATUS: agentDeviceProtocol=some-other-protocol',
      'INSTRUMENTATION_STATUS: sessionReady=true',
      'INSTRUMENTATION_STATUS_CODE: 2',
      '',
    ].join('\n'),
  );

  const error = await ready;
  assert.ok(error instanceof AppError);
  assert.equal(error.details?.reason, 'android_snapshot_helper_session_ready_malformed');
});
