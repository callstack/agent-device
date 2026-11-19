// Versioned activation for persistent helper sessions (#4519): what a host may put in
// `am instrument` argv. A helper launched with `sessionPort` keeps an unauthenticated loopback TCP
// listener, so these tests own the rule that keeps that argument out of the launch. A helper that
// does not implement the launched mode rejects it in `onStart` before it binds anything, which is
// the whole answer to an old build: no capability declaration on the artifact is consulted.
//
// The two contract literals are restated here on purpose: they are the cross-platform contract that
// `SessionPeerPolicy.java` carries, and these tests must keep holding the host to it even if one
// side of it is renamed.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';
import { captureAndroidSnapshotWithHelperSession } from '../snapshot-helper-session.ts';
import { bindAndroidAdbTestHost } from './test-utils/android-host-test-setup.ts';
import type { AndroidAdbExecutor, AndroidAdbProcess, AndroidAdbProvider } from '../adb-executor.ts';

bindAndroidAdbTestHost();

const SESSION_MODE = 'authenticated-session-v1';
const SOCKET_PREFIX = 'agentdevice-snapshot-helper-';

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

type FakeDevice = {
  provider: AndroidAdbProvider;
  spawnArgs: (readonly string[])[];
  forwards: (readonly string[])[];
};

/**
 * A device that answers forwards, launches the helper, and never announces readiness: enough for a
 * command to reach `am instrument` so its argv can be read. No test here needs the session to come
 * up — the claim is about what the host sends.
 */
function createFakeDevice(): FakeDevice {
  const spawnArgs: (readonly string[])[] = [];
  const forwards: (readonly string[])[] = [];
  const exec: AndroidAdbExecutor = async (args) => {
    // `forward tcp:<port> <target>` sets the forward up; `forward --remove` is teardown.
    if (args[0] === 'forward' && String(args[1] ?? '').startsWith('tcp:')) forwards.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const provider = {
    exec,
    spawn: (args: readonly string[]) => {
      spawnArgs.push(args);
      return new FakeHelperProcess();
    },
  } as unknown as AndroidAdbProvider;
  return { provider, spawnArgs, forwards };
}

async function runOneCommand(device: FakeDevice, deviceKey: string): Promise<unknown> {
  return captureAndroidSnapshotWithHelperSession({
    deviceKey,
    commandTimeoutMs: 50,
    adb: device.provider.exec,
    adbProvider: device.provider,
  });
}

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

test('a session launch names the authenticated mode and its socket, and never a session port', async () => {
  const device = createFakeDevice();
  await runOneCommand(device, 'android:activation-argv');

  assert.equal(device.spawnArgs.length, 1, 'expected the helper to be launched into a session');
  const args = device.spawnArgs[0]!;
  assert.equal(argumentValue(args, 'mode'), SESSION_MODE);
  assert.match(argumentValue(args, 'sessionSocket') ?? '', new RegExp(`^${SOCKET_PREFIX}\\d+$`));
  // The decisive regression: a helper that receives `sessionPort` binds a loopback TCP listener
  // before the host can notice what answered, so no session launch may ever carry that argument.
  assert.equal(args.includes('sessionPort'), false);
});

test('the launched socket name is the socket the host forwards to', async () => {
  const device = createFakeDevice();
  await runOneCommand(device, 'android:activation-forward');

  assert.equal(device.forwards.length, 1);
  const socketName = argumentValue(device.spawnArgs[0]!, 'sessionSocket');
  // One name, owned by the host: argv says what the helper must bind, and the forward says where the
  // host connects. If these two ever differ, readiness rejects the helper instead of talking to it.
  assert.equal(device.forwards[0]![2], `localabstract:${socketName}`);
  assert.match(socketName ?? '', new RegExp(`^${SOCKET_PREFIX}\\d+$`));
});
