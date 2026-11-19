// Versioned activation for persistent helper sessions (#4519): what a host may put in
// `am instrument` argv, and which helper builds it may start a session for. A helper launched with
// `sessionPort` keeps an unauthenticated loopback TCP listener, so these tests own the rule that
// keeps that argument out of the launch, and keeps an artifact that cannot prove an authenticated
// session off the session path.
//
// The two contract literals are restated here on purpose: they are the cross-platform contract that
// `SessionPeerPolicy.java` and the packaged manifest carry, and these tests must keep holding the
// host to it even if one side of it is renamed.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';
import { captureAndroidSnapshotWithHelperSession } from '../snapshot-helper-session.ts';
import { parseAndroidSnapshotHelperManifest } from '../snapshot-helper-artifact.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import { bindAndroidAdbTestHost } from './test-utils/android-host-test-setup.ts';
import type { AndroidAdbExecutor, AndroidAdbProcess, AndroidAdbProvider } from '../adb-executor.ts';

bindAndroidAdbTestHost();

const SESSION_MODE = 'authenticated-session-v1';
const SOCKET_PREFIX = 'agentdevice-snapshot-helper-';

// Every test gets its own device key: a start that fails earns a timed backoff under the capture
// identity, and one test's failed start must not make another test's host skip the launch.
const CAPTURE_SETTINGS = {
  commandTimeoutMs: 50,
};

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
 * up — the claim is about what the host sends, and about whether it sends anything at all.
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

async function runOneCommand(
  device: FakeDevice,
  deviceKey: string,
  options: Record<string, unknown> = {},
): Promise<unknown> {
  return captureAndroidSnapshotWithHelperSession({
    ...CAPTURE_SETTINGS,
    deviceKey,
    adb: device.provider.exec,
    adbProvider: device.provider,
    ...options,
  });
}

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('a session launch names the authenticated mode and its socket, and never a session port', async () => {
  const device = createFakeDevice();
  await runOneCommand(device, 'android:activation-argv', { helperSessionMode: SESSION_MODE });

  assert.equal(device.spawnArgs.length, 1, 'expected the session-capable artifact to be launched');
  const args = device.spawnArgs[0]!;
  assert.equal(argumentValue(args, 'mode'), SESSION_MODE);
  assert.match(argumentValue(args, 'sessionSocket') ?? '', new RegExp(`^${SOCKET_PREFIX}\\d+$`));
  // The decisive regression: a helper that receives `sessionPort` binds a loopback TCP listener
  // before the host can notice what answered, so no session launch may ever carry that argument.
  assert.equal(args.includes('sessionPort'), false);
});

test('the launched socket name is the socket the host forwards to', async () => {
  const device = createFakeDevice();
  await runOneCommand(device, 'android:activation-forward', { helperSessionMode: SESSION_MODE });

  assert.equal(device.forwards.length, 1);
  const socketName = argumentValue(device.spawnArgs[0]!, 'sessionSocket');
  // One name, owned by the host: argv says what the helper must bind, and the forward says where the
  // host connects. If these two ever differ, readiness rejects the helper instead of talking to it.
  assert.equal(device.forwards[0]![2], `localabstract:${socketName}`);
  assert.match(socketName ?? '', new RegExp(`^${SOCKET_PREFIX}\\d+$`));
});

test('an artifact that does not declare the session mode is never asked to start a session', async () => {
  const device = createFakeDevice();

  // An older or provider-supplied artifact whose manifest does not declare the authenticated session
  // mode is unknown, and unknown is one-shot: the host gives that build nothing to answer (#4519).
  const output = await runOneCommand(device, 'android:activation-undeclared');

  assert.equal(output, undefined);
  assert.deepEqual(device.spawnArgs, []);
  assert.deepEqual(device.forwards, []);
});

test('the manifest parser reads the declared mode and treats an unknown one as no session', () => {
  const manifest = ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.manifest as Record<string, unknown>;

  assert.equal(
    parseAndroidSnapshotHelperManifest({ ...manifest, sessionMode: SESSION_MODE }).sessionMode,
    SESSION_MODE,
  );
  assert.equal(
    parseAndroidSnapshotHelperManifest({ ...manifest, sessionMode: 'unauthenticated-session-v0' })
      .sessionMode,
    undefined,
  );
  const { sessionMode: _sessionMode, ...withoutMode } = manifest;
  assert.equal(parseAndroidSnapshotHelperManifest(withoutMode).sessionMode, undefined);
});

test('the helper source and the packaging script carry the mode the host launches', () => {
  const policy = readSource(
    '../../../../android/snapshot-helper/src/main/java/com/callstack/agentdevice/snapshothelper/SessionPeerPolicy.java',
  );
  const packaging = readSource('../../../../scripts/package-android-helper.sh');

  // The helper refuses any mode but this one, and the manifest that ships the APK has to promise the
  // same string: a manifest that overstates the APK would put sessions on an old build.
  assert.match(policy, new RegExp(`AUTHENTICATED_SESSION_MODE = "${SESSION_MODE}"`));
  assert.match(packaging, new RegExp(`sessionMode = '${SESSION_MODE}'`));
});
