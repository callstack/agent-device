// What server mode a client makes the daemon it starts serve, for the transport that client asked to
// talk over. A socket-mode daemon opens no HTTP listener and publishes no `httpPort`, so an http
// client that started one could never observe it as ready, would retire it, and would fail every
// later call at an endpoint that does not exist.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  resolveClientSettings,
  resolveLocalDaemonSettings,
  type DaemonClientSettings,
} from '../daemon-client-lifecycle.ts';
import { startLocalDaemon } from '../daemon-client-startup.ts';
import { finishRegisteredDaemonFixtures } from './registered-daemon-fixture.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';

const spawn = vi.mocked(runCmdDetachedMonitored);

afterEach(async () => {
  spawn.mockReset();
  await finishRegisteredDaemonFixtures();
});

/** The settings one managed client resolves from named request flags and a named host environment. */
function settingsFor(
  flags: NonNullable<Parameters<typeof resolveClientSettings>[0]['flags']>,
  env: EnvMap = {},
  authToken?: string,
): DaemonClientSettings {
  return resolveClientSettings(
    { session: 'default', command: 'devices', positionals: [], flags },
    authToken,
    createTestHostEnvironment({ env, cwd: '/tmp/agent-device-client-server-mode' }),
  );
}

test.for([
  { name: 'client flag', flags: { daemonTransport: 'http' } },
  { name: 'environment', flags: {}, env: { AGENT_DEVICE_DAEMON_TRANSPORT: 'http' } },
] as const)(
  'an explicit http transport starts its daemon in $name-sourced http server mode',
  ({ flags, env }) => {
    const settings = settingsFor(flags, env);
    assert.equal(settings.serverMode, 'http');
    assert.equal(settings.transportPreference, 'http');
  },
);

test('an explicit dual transport still starts its daemon in dual server mode', () => {
  // `dual` normalizes to the `auto` preference, so it rides the same derivation `http` now uses.
  assert.equal(settingsFor({}, { AGENT_DEVICE_DAEMON_TRANSPORT: 'dual' }).serverMode, 'dual');
});

test.for([
  { name: 'no transport', flags: {} },
  { name: 'auto transport', flags: { daemonTransport: 'auto' } },
  { name: 'socket transport', flags: { daemonTransport: 'socket' } },
] as const)('a $name client keeps the socket-only server mode it always had', ({ flags }) => {
  assert.equal(settingsFor(flags).serverMode, 'socket');
});

test('an explicit --daemon-server-mode wins over what the http transport would derive', () => {
  assert.equal(
    settingsFor({ daemonTransport: 'http', daemonServerMode: 'dual' }).serverMode,
    'dual',
  );
});

test('an explicit AGENT_DEVICE_DAEMON_SERVER_MODE wins over what the http transport would derive', () => {
  assert.equal(
    settingsFor({ daemonTransport: 'http' }, { AGENT_DEVICE_DAEMON_SERVER_MODE: 'dual' })
      .serverMode,
    'dual',
  );
});

test('the ensure route derives the same server modes as a request does', () => {
  const host = createTestHostEnvironment({ env: {}, cwd: '/tmp/agent-device-client-server-mode' });
  assert.equal(resolveLocalDaemonSettings({ daemonTransport: 'http' }, host).serverMode, 'http');
  assert.equal(
    resolveLocalDaemonSettings({ daemonTransport: 'http', daemonServerMode: 'dual' }, host)
      .serverMode,
    'dual',
  );
});

test('a client with a daemon base URL asks for no server mode: it starts no daemon', () => {
  // A base URL answers "which daemon" with a remote instance, so nothing is launched to serve this
  // client and an explicit socket mode decides nothing. Only a `socket` transport is refused there.
  const settings = settingsFor(
    { daemonTransport: 'http', daemonBaseUrl: 'http://127.0.0.1:9' },
    { AGENT_DEVICE_DAEMON_SERVER_MODE: 'socket' },
    'token',
  );
  assert.equal(settings.remoteBaseUrl, 'http://127.0.0.1:9');
  assert.equal(settings.serverMode, 'socket');
});

test('a launch that would serve no endpoint this client can call is refused before anything spawns', async () => {
  const stateDir = mkdtempForTestSync('agent-device-http-server-mode-refusal-');
  const settings = settingsFor({ daemonTransport: 'http', daemonServerMode: 'socket', stateDir });
  assert.equal(settings.transportPreference, 'http');
  assert.equal(settings.serverMode, 'socket');

  let refusal: AppError | undefined;
  try {
    await startLocalDaemon(settings);
    assert.fail('expected the launch to be refused');
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    refusal = error;
  }
  assert.equal(refusal.code, 'INVALID_ARGS');
  assert.equal(refusal.details?.reason, 'daemon_server_mode_serves_no_http_endpoint');
  assert.equal(refusal.details?.daemonServerMode, 'socket');
  assert.match(String(refusal.details?.hint), /--daemon-server-mode/);
  assert.equal(spawn.mock.calls.length, 0, 'a daemon this client cannot use was launched anyway');
  assert.equal(fs.existsSync(settings.paths.infoPath), false);
});
