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
  'INSTRUMENTATION_STATUS: sessionPort=18093',
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

const MALFORMED = 'android_snapshot_helper_session_ready_malformed';
const TRANSPORT = 'INSTRUMENTATION_STATUS: sessionTransport=localabstract-peer-uid-v1';
const READY_TAIL = 'INSTRUMENTATION_STATUS: sessionReady=true\nINSTRUMENTATION_STATUS_CODE: 2\n';

async function readinessReason(stdout: string): Promise<unknown> {
  const process = new FakeAndroidProcess();
  const ready = waitForAndroidSnapshotHelperSessionReady(
    process,
    1_000,
    undefined,
    recordInstrumentationProcess(process),
  ).catch((error: unknown) => error);
  process.stdout.write(stdout);
  const outcome = await ready;
  return outcome instanceof AppError ? outcome.details?.reason : outcome;
}

test.each([
  {
    label: 'another protocol',
    stdout: `${READY_HEAD.replace('android-snapshot-helper-v1', 'some-other-protocol')}\n${TRANSPORT}\n${READY_TAIL}`,
  },
  {
    label: 'an empty transport',
    stdout: `${READY_HEAD}\nINSTRUMENTATION_STATUS: sessionTransport=\n${READY_TAIL}`,
  },
  {
    label: 'an unknown transport',
    stdout: `${READY_HEAD}\nINSTRUMENTATION_STATUS: sessionTransport=tcp-token-v0\n${READY_TAIL}`,
  },
  {
    label: 'a conflicting duplicate transport',
    stdout: `${READY_HEAD}\nINSTRUMENTATION_STATUS: sessionTransport=tcp-token-v0\n${TRANSPORT}\n${READY_TAIL}`,
  },
  {
    label: 'a repeated field',
    stdout: `${READY_HEAD}\n${TRANSPORT}\n${TRANSPORT}\n${READY_TAIL}`,
  },
  {
    label: 'an unparsed status line',
    stdout: `${READY_HEAD}\nINSTRUMENTATION_STATUS: sessionTransport\n${READY_TAIL}`,
  },
  {
    label: 'a missing session port',
    stdout: `${READY_HEAD.replace('INSTRUMENTATION_STATUS: sessionPort=18093\n', '').replace('\nINSTRUMENTATION_STATUS: sessionPort=18093', '')}\n${TRANSPORT}\n${READY_TAIL}`,
  },
])('a ready record with $label is malformed, not an unsupported transport', async ({ stdout }) => {
  assert.equal(await readinessReason(stdout), MALFORMED);
});

test('fields from an earlier record never complete a later ready record', async () => {
  const process = new FakeAndroidProcess();
  const ready = waitForAndroidSnapshotHelperSessionReady(
    process,
    1_000,
    undefined,
    recordInstrumentationProcess(process),
  ).catch((error: unknown) => error);
  // The transport line belongs to a record that INSTRUMENTATION_CODE ended. The ready record after
  // it has no transport line, and the protocol line of an earlier status record does not count.
  process.stdout.write(`${TRANSPORT}\nINSTRUMENTATION_CODE: -1\n`);
  process.stdout.write(
    'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1\nINSTRUMENTATION_STATUS_CODE: 1\n',
  );
  process.stdout.write(`INSTRUMENTATION_STATUS: sessionPort=18093\n${READY_TAIL}`);

  const outcome = await ready;
  assert.ok(outcome instanceof AppError);
  assert.equal(outcome.details?.reason, MALFORMED);
});
