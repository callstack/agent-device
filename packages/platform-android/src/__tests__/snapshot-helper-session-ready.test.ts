// Readiness for a persistent helper session (#4519). A session becomes ready only on one complete
// status record that names this protocol and the abstract socket this host launched the helper with.
// A record naming anything else is not this launch's session, and readiness answers nothing about
// what the helper build can do — the host decided that from the artifact before launching it (#4519).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';
import { recordInstrumentationProcess } from '../instrumentation-helper.ts';
import { waitForAndroidSnapshotHelperSessionReady } from '../snapshot-helper-session-protocol.ts';
import type { AndroidAdbProcess } from '../adb-executor.ts';

const LAUNCHED_SOCKET_NAME = 'agentdevice-snapshot-helper-18093';
const PROTOCOL = 'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1';
const SESSION_SECRET = 'ab'.repeat(32);
// Every ready record carries the session secret; the commands line keeps it next to the commands.
const COMMANDS = `INSTRUMENTATION_STATUS: sessionCommands=input,snapshot-immediate\nINSTRUMENTATION_STATUS: sessionSecret=${SESSION_SECRET}`;
const SOCKET = `INSTRUMENTATION_STATUS: sessionSocket=${LAUNCHED_SOCKET_NAME}`;
const READY = 'INSTRUMENTATION_STATUS: sessionReady=true';
const READY_CODE = 'INSTRUMENTATION_STATUS_CODE: 2';
const MALFORMED = 'android_snapshot_helper_session_ready_malformed';

class FakeHelperProcess extends EventEmitter implements AndroidAdbProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}

function waitForReady(process: FakeHelperProcess) {
  return waitForAndroidSnapshotHelperSessionReady(
    process,
    5_000,
    undefined,
    recordInstrumentationProcess(process),
    LAUNCHED_SOCKET_NAME,
  );
}

/** Writes `record` to a helper process and reports what readiness decided: commands, or the reason. */
async function readinessOutcome(record: string): Promise<ReadonlySet<string> | unknown> {
  const process = new FakeHelperProcess();
  const ready = waitForAndroidSnapshotHelperSessionReady(
    process,
    1_000,
    undefined,
    recordInstrumentationProcess(process),
    LAUNCHED_SOCKET_NAME,
  ).then(
    (ready) => ready.commands,
    (error: unknown) => error,
  );
  process.stdout.write(record);
  return ready;
}

function reasonOf(outcome: unknown): unknown {
  return typeof outcome === 'object' && outcome !== null
    ? (outcome as { details?: { reason?: unknown } }).details?.reason
    : undefined;
}

test('readiness is the launched socket, and a helper naming another socket is refused', async () => {
  const process = new FakeHelperProcess();
  const ready = waitForReady(process);
  process.stdout.write([PROTOCOL, COMMANDS, SOCKET, READY, READY_CODE, ''].join('\n'));

  assert.deepEqual([...(await ready).commands], ['input', 'snapshot-immediate']);

  // The same record, naming a socket this host did not launch: another helper's readiness, or a
  // stale one, and the host must refuse it rather than send commands through the wrong forward.
  const other = await readinessOutcome(
    [
      PROTOCOL,
      COMMANDS,
      'INSTRUMENTATION_STATUS: sessionSocket=agentdevice-snapshot-helper-18094',
      READY,
      READY_CODE,
      '',
    ].join('\n'),
  );
  assert.equal(reasonOf(other), MALFORMED);
});

test('an adb warning between two halves of the socket line keeps the record whole', async () => {
  const process = new FakeHelperProcess();
  const ready = waitForReady(process);
  // The split lands in the middle of the socket value: an adb warning on the other stream must not
  // turn one status record into two.
  process.stdout.write(`${PROTOCOL}\n${COMMANDS}\nINSTRUMENTATION_STATUS: sessionSocket=agent`);
  process.stderr.write('adb: warning: stdout is not a tty\n');
  process.stdout.write(
    'device-snapshot-helper-18093\nINSTRUMENTATION_STATUS: sessionReady=true\nINSTRUMENTATION_STATUS_CODE: 2\n',
  );

  assert.deepEqual([...(await ready).commands], ['input', 'snapshot-immediate']);
});

test('fields of an earlier record never complete a later ready record', async () => {
  // Positive control first: the same fields inside one record are what makes a session ready.
  assert.ok(
    (await readinessOutcome(
      [PROTOCOL, COMMANDS, SOCKET, READY, READY_CODE, ''].join('\n'),
    )) instanceof Set,
  );

  // The socket line belongs to a record that INSTRUMENTATION_CODE ended. The ready record after it
  // has no socket line, and the protocol line of an earlier status record does not count.
  const process = new FakeHelperProcess();
  const ready = waitForAndroidSnapshotHelperSessionReady(
    process,
    1_000,
    undefined,
    recordInstrumentationProcess(process),
    LAUNCHED_SOCKET_NAME,
  ).catch((error: unknown) => error);
  process.stdout.write(`${SOCKET}\nINSTRUMENTATION_CODE: -1\n`);
  process.stdout.write(`${PROTOCOL}\nINSTRUMENTATION_STATUS_CODE: 1\n`);
  process.stdout.write(`${READY}\n${READY_CODE}\n`);

  assert.equal(reasonOf(await ready), MALFORMED);
});

test('a record that disagrees about the socket, or repeats a field, is a failed start', async () => {
  // Positive control: one socket line naming the launch is enough.
  assert.ok(
    (await readinessOutcome(
      [PROTOCOL, COMMANDS, SOCKET, READY, READY_CODE, ''].join('\n'),
    )) instanceof Set,
  );

  for (const fields of [
    [PROTOCOL, COMMANDS, SOCKET, SOCKET],
    [PROTOCOL, COMMANDS, SOCKET, 'INSTRUMENTATION_STATUS: sessionSocket='],
    [
      PROTOCOL,
      COMMANDS,
      'INSTRUMENTATION_STATUS: sessionSocket=agentdevice-snapshot-helper-18094',
      SOCKET,
    ],
    [PROTOCOL, COMMANDS, SOCKET, 'INSTRUMENTATION_STATUS: sessionSocket'],
  ]) {
    const outcome = await readinessOutcome([...fields, READY, READY_CODE, ''].join('\n'));
    assert.equal(reasonOf(outcome), MALFORMED, `expected ${fields.join(' | ')} to be refused`);
  }
});

test('a helper that announces no socket is a failed start, not a capability answer', async () => {
  // Positive control: with the socket named, this exact record makes the session ready.
  assert.ok(
    (await readinessOutcome(
      [PROTOCOL, COMMANDS, SOCKET, READY, READY_CODE, ''].join('\n'),
    )) instanceof Set,
  );

  // A build that predates the session mode is never launched into it, so readiness never has to
  // classify it: a record without the socket is a start failure, and the caller's finite start
  // backoff is the only thing that follows. The fields an older helper reported do not rescue it.
  for (const fields of [
    [PROTOCOL, COMMANDS],
    [PROTOCOL, COMMANDS, 'INSTRUMENTATION_STATUS: sessionPort=18093'],
    [
      PROTOCOL,
      COMMANDS,
      'INSTRUMENTATION_STATUS: sessionPort=18093',
      'INSTRUMENTATION_STATUS: sessionTransport=localabstract-peer-uid-v1',
    ],
  ]) {
    const outcome = await readinessOutcome([...fields, READY, READY_CODE, ''].join('\n'));
    assert.equal(reasonOf(outcome), MALFORMED, `expected ${fields.join(' | ')} to be refused`);
  }
});

test('a ready record must carry a 32-byte session secret, and readiness returns it', async () => {
  const process = new FakeHelperProcess();
  const ready = waitForReady(process);
  process.stdout.write([PROTOCOL, COMMANDS, SOCKET, READY, READY_CODE, ''].join('\n'));
  assert.equal((await ready).secret.toString('hex'), SESSION_SECRET);

  const commandsOnly = 'INSTRUMENTATION_STATUS: sessionCommands=input,snapshot-immediate';
  for (const secret of ['', 'ab'.repeat(31), 'AB'.repeat(32), `${'ab'.repeat(32)}00`]) {
    const fields = [PROTOCOL, commandsOnly, SOCKET];
    if (secret) fields.push(`INSTRUMENTATION_STATUS: sessionSecret=${secret}`);
    const outcome = await readinessOutcome([...fields, READY, READY_CODE, ''].join('\n'));
    assert.equal(reasonOf(outcome), MALFORMED, `expected secret "${secret}" to be refused`);
  }
});
