import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTest } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  boundConnectionPlatform,
  buildConnectionDeviceKey,
  connectionPlatformMatchesSelection,
  buildRemoteConnectionDaemonState,
  hashRemoteConfigFile,
  resolveConnectionDeviceScope,
  resolveRemoteConnectionDefaults,
  writeRemoteConnectionState,
  type RemoteConnectionState,
} from '../remote-connection-state.ts';

// Regression coverage for ADR 0007: generated connection profiles must strip
// the daemon bearer token. `connect` used to write it straight into the
// persisted connection-state file; these tests guard against that shadow
// coming back.

const FAKE_DAEMON_TOKEN = 'test-not-a-real-daemon-token';

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  target: 'mobile',
  kind: 'simulator',
  id: 'SIM-001',
  name: 'iPhone 16',
};

const ANDROID_EMULATOR: DeviceInfo = {
  platform: 'android',
  target: 'mobile',
  kind: 'emulator',
  id: 'emulator-5554',
  name: 'Pixel 8',
};

const MACOS_HOST: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  target: 'desktop',
  kind: 'device',
  id: 'HOST-MAC',
  name: 'Mac',
};

const VEGA_VVD: DeviceInfo = {
  platform: 'vega',
  target: 'mobile',
  kind: 'emulator',
  id: 'vvd-1',
  name: 'Vega VVD',
};

// #2962: a resolved device wrote its internal `apple` platform into the fields a remote connection
// records, which speaks the public leaf, and the scope check refused every iOS install and open.
test('resolveConnectionDeviceScope names a device on the public platform axis, never the internal one', () => {
  assert.equal(resolveConnectionDeviceScope(IOS_SIMULATOR).platform, 'ios');
  assert.equal(resolveConnectionDeviceScope(MACOS_HOST).platform, 'macos');
  assert.equal(resolveConnectionDeviceScope(ANDROID_EMULATOR).platform, 'android');
});

test('resolveConnectionDeviceScope pairs each device with the backend and identity flag that address it', () => {
  assert.deepEqual(resolveConnectionDeviceScope(IOS_SIMULATOR), {
    platform: 'ios',
    target: 'mobile',
    leaseBackend: 'ios-instance',
    identityFlag: 'udid',
    id: 'SIM-001',
  });
  assert.equal(resolveConnectionDeviceScope(ANDROID_EMULATOR).leaseBackend, 'android-instance');
  assert.equal(resolveConnectionDeviceScope(ANDROID_EMULATOR).identityFlag, 'serial');
  // A platform no lease backend rents cannot be bound by a remote connection, so it names no
  // identity flag either: the command fails on the missing backend rather than on a `--udid` the
  // daemon reads as iOS-family-only and reports as a conflict against the session being opened.
  assert.deepEqual(resolveConnectionDeviceScope(MACOS_HOST), {
    platform: 'macos',
    target: 'desktop',
    leaseBackend: undefined,
    identityFlag: undefined,
    id: 'HOST-MAC',
  });
  assert.equal(resolveConnectionDeviceScope(VEGA_VVD).leaseBackend, undefined);
  assert.equal(resolveConnectionDeviceScope(VEGA_VVD).identityFlag, undefined);
});

test('buildConnectionDeviceKey keys a device by its public platform and defaulted target', () => {
  assert.equal(
    buildConnectionDeviceKey(resolveConnectionDeviceScope(IOS_SIMULATOR)),
    'ios:mobile:SIM-001',
  );
  assert.equal(
    buildConnectionDeviceKey(resolveConnectionDeviceScope(MACOS_HOST)),
    'macos:desktop:HOST-MAC',
  );
  assert.equal(
    buildConnectionDeviceKey(resolveConnectionDeviceScope({ ...IOS_SIMULATOR, target: undefined })),
    'ios:mobile:SIM-001',
  );
});

test('buildRemoteConnectionDaemonState does not persist the daemon auth token', () => {
  const daemon = buildRemoteConnectionDaemonState({
    daemonBaseUrl: 'https://daemon.example.test',
    daemonAuthToken: FAKE_DAEMON_TOKEN,
    daemonTransport: 'http',
    daemonServerMode: 'http',
  });

  assert.equal(Object.hasOwn(daemon ?? {}, 'authToken'), false);
  assert.equal(daemon?.baseUrl, 'https://daemon.example.test');
  assert.equal(daemon?.transport, 'http');
  assert.equal(daemon?.serverMode, 'http');
});

test('written connection state contains no daemon auth token', async () => {
  const tempRoot = await mkdtempForTest('agent-device-remote-connection-state-write-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, '{}');

  const daemon = buildRemoteConnectionDaemonState({
    daemonBaseUrl: 'https://daemon.example.test',
    daemonAuthToken: FAKE_DAEMON_TOKEN,
    daemonTransport: 'http',
    daemonServerMode: 'http',
  });
  const now = new Date().toISOString();
  const state: RemoteConnectionState = {
    version: 1,
    session: 'adc-write-test',
    remoteConfigPath,
    remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
    daemon,
    tenant: 'acme',
    runId: 'run-1',
    connectedAt: now,
    updatedAt: now,
  };

  writeRemoteConnectionState({ stateDir, state });

  const writtenPath = path.join(stateDir, 'remote-connections', 'adc-write-test.json');
  const written = fs.readFileSync(writtenPath, 'utf8');
  assert.equal(written.includes(FAKE_DAEMON_TOKEN), false);
  assert.equal(written.includes('authToken'), false);
});

test('resolveRemoteConnectionDefaults falls back to the environment token', async () => {
  const tempRoot = await mkdtempForTest('agent-device-remote-connection-state-defaults-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, '{}');

  const daemon = buildRemoteConnectionDaemonState({
    daemonBaseUrl: 'https://daemon.example.test',
    daemonAuthToken: undefined,
    daemonTransport: 'http',
    daemonServerMode: 'http',
  });
  const now = new Date().toISOString();
  const state: RemoteConnectionState = {
    version: 1,
    session: 'adc-env-fallback',
    remoteConfigPath,
    remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
    daemon,
    tenant: 'acme',
    runId: 'run-1',
    connectedAt: now,
    updatedAt: now,
  };
  writeRemoteConnectionState({ stateDir, state });

  const defaults = resolveRemoteConnectionDefaults({
    stateDir,
    session: 'adc-env-fallback',
    cwd: tempRoot,
    env: { AGENT_DEVICE_DAEMON_AUTH_TOKEN: FAKE_DAEMON_TOKEN },
  });

  assert.equal(defaults?.flags.daemonAuthToken, FAKE_DAEMON_TOKEN);
});

// The rule that decides whether a recorded platform is still a family selection: the backend is what
// settles it. With none, the alias is kept rather than guessed — a connection that named no backend
// can legitimately serve either Apple leaf.
test('boundConnectionPlatform collapses apple only when a backend names the leaf', () => {
  const bound = boundConnectionPlatform({ platform: 'apple', leaseBackend: undefined });
  assert.equal(bound, 'apple');
  // A backend is what decides it, including one whose platform the backend does not name.
  assert.equal(
    boundConnectionPlatform({ platform: 'apple', leaseBackend: 'ios-simulator' }),
    'apple',
    'a runner-guard backend names no platform to collapse to',
  );
  assert.equal(
    boundConnectionPlatform({ platform: 'apple', leaseBackend: 'android-instance' }),
    'android',
  );
  // A leaf is already decided, whichever backend it leased on.
  assert.equal(
    boundConnectionPlatform({ platform: 'ios', leaseBackend: 'ios-instance' }),
    'ios',
    'a leaf passes through untouched',
  );
});

// The reuse question `connect` asks: is this the same connection? A record that still names the
// `apple` family beside an `ios-instance` backend must not answer yes to `--platform macos`, which
// is how a stored alias let a macOS request reuse an iOS device's connection. The selector rule
// alone says family-vs-leaf is no conflict, so the collapse has to be part of this answer too.
test('connectionPlatformMatchesSelection refuses the other leaf of a bound apple record', () => {
  const boundIos = { platform: 'apple', leaseBackend: 'ios-instance' } as const;
  assert.equal(connectionPlatformMatchesSelection(boundIos, 'macos'), false);
  assert.equal(
    connectionPlatformMatchesSelection(boundIos, 'apple'),
    true,
    'naming the family still matches the connection it named',
  );
  assert.equal(
    connectionPlatformMatchesSelection(boundIos, 'ios'),
    true,
    'and so does the leaf the backend rents',
  );
  assert.equal(
    connectionPlatformMatchesSelection(boundIos, undefined),
    true,
    'a request that names no platform asks for no platform',
  );
  // The other direction of #2962: an unbound record is bound to nothing, so a request naming a
  // platform is a different connection rather than a match.
  assert.equal(connectionPlatformMatchesSelection({ platform: undefined }, 'ios'), false);
  assert.equal(
    connectionPlatformMatchesSelection({ platform: 'apple' }, 'macos'),
    true,
    'with no backend, nothing has decided the family and the alias stands',
  );
});
