// What server mode a client makes the daemon it starts serve, and what a client refuses to start or
// take over for the transport it asked to talk over. A socket-mode daemon opens no HTTP listener and
// publishes no `httpPort`; an http-mode daemon opens no socket listener and publishes no `port`. A
// client that requires the listener the mode does not open could never reach the daemon it started,
// would retire it, and would fail every later call at an endpoint that does not exist.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
  startHttpDaemonFixture,
} from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { isProcessAlive, readProcessStartTime } from '@agent-device/host-kit/process';
import { readVersion } from '@agent-device/host-kit/version';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  resolveClientSettings,
  resolveLocalDaemonSettings,
  type DaemonClientSettings,
} from '../daemon-client-lifecycle.ts';
import { ensureDaemon, sendToDaemon } from '../index.ts';
import { startLocalDaemon } from '../daemon-client-startup.ts';
import { currentDaemonCodeSignature } from './code-signature-fixture.ts';
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

const REFUSAL = 'daemon_server_mode_serves_no_client_transport';

/** Publishes a `daemon.json` naming `fields`, for a daemon the fixtures do not start. */
function writeDaemonRecord(stateDir: string, fields: Record<string, unknown>): void {
  const paths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    `${JSON.stringify({
      token: 'local-secret',
      // A pid that is not alive, so the client judges the record's daemon replaceable rather than
      // still starting. Nothing here retires it: the refusal under test comes first.
      pid: 999_999,
      version: readVersion(),
      codeSignature: currentDaemonCodeSignature(),
      ...fields,
    })}\n`,
    'utf8',
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

test.for([
  {
    name: 'an http client naming socket server mode',
    flags: { daemonTransport: 'http', daemonServerMode: 'socket' } as const,
    transport: 'http',
    mode: 'socket',
  },
  {
    name: 'a socket client naming http server mode',
    flags: { daemonTransport: 'socket', daemonServerMode: 'http' } as const,
    transport: 'socket',
    mode: 'http',
  },
] as const)(
  '$name is refused before anything spawns: the launch would serve no endpoint this client can call',
  async ({ flags, transport, mode }) => {
    const stateDir = mkdtempForTestSync('agent-device-server-mode-refusal-');
    const settings = settingsFor({ ...flags, stateDir });
    assert.equal(settings.transportPreference, transport);
    assert.equal(settings.serverMode, mode);

    const refusal = await startLocalDaemon(settings).then(
      () => assert.fail('expected the launch to be refused'),
      (error: unknown) => error,
    );
    assert.ok(refusal instanceof AppError, String(refusal));
    assert.equal(refusal.code, 'INVALID_ARGS');
    assert.equal(refusal.details?.reason, REFUSAL);
    assert.equal(refusal.details?.daemonTransport, transport);
    assert.equal(refusal.details?.daemonServerMode, mode);
    assert.match(String(refusal.details?.hint), /--daemon-server-mode/);
    assert.match(String(refusal.details?.hint), /AGENT_DEVICE_DAEMON_SERVER_MODE/);
    assert.equal(spawn.mock.calls.length, 0, 'a daemon this client cannot use was launched anyway');
    assert.equal(fs.existsSync(settings.paths.infoPath), false);
  },
);

test('the refusal names both override sources, because either one alone keeps the mode in effect', async () => {
  // A socket value in the environment still starts a socket daemon after the flag is dropped, so
  // advice to drop only one of them would send the caller back to the same refusal.
  const settings = settingsFor({
    daemonTransport: 'http',
    daemonServerMode: 'socket',
    stateDir: mkdtempForTestSync('agent-device-server-mode-hint-'),
  });
  let refusal: AppError | undefined;
  try {
    await startLocalDaemon(settings);
    assert.fail('expected the launch to be refused');
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    refusal = error;
  }
  const hint = String(refusal.details?.hint);
  assert.match(hint, /--daemon-server-mode/);
  assert.match(hint, /AGENT_DEVICE_DAEMON_SERVER_MODE/);
  assert.match(hint, /every place it is set/);
  assert.match(hint, /--daemon-transport/);
});

test('the request route refuses a launch its own transport cannot answer', async () => {
  const stateDir = mkdtempForTestSync('agent-device-server-mode-request-');
  const refusal = await sendToDaemon({
    session: 'default',
    command: 'devices',
    positionals: [],
    flags: { stateDir, daemonTransport: 'http', daemonServerMode: 'socket' },
    meta: { requestId: 'req-server-mode-refusal' },
  }).then(
    () => assert.fail('expected the request to be refused'),
    (error: unknown) => error,
  );
  assert.ok(refusal instanceof AppError, String(refusal));
  assert.equal(refusal.details?.reason, REFUSAL);
  assert.equal(spawn.mock.calls.length, 0);
  assert.equal(fs.existsSync(resolveDaemonPaths(stateDir).infoPath), false);
});

test('a daemon this client can reach is reused, whatever server mode this client would have asked for', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const daemon = await startHttpDaemonFixture({ devices: [] });
  const stateDir = mkdtempForTestSync('agent-device-server-mode-reuse-');
  const paths = resolveDaemonPaths(stateDir);
  writeDaemonRecord(stateDir, {
    httpPort: daemon.port,
    transport: 'http',
    processStartTime: readProcessStartTime(process.pid) ?? undefined,
    pid: process.pid,
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'devices',
      positionals: [],
      // The pair the refusal above rejects: it decides only what this client would LAUNCH, and a
      // daemon already serving the endpoint this client calls is used as it stands.
      flags: { stateDir, daemonTransport: 'http', daemonServerMode: 'socket' },
      meta: { requestId: 'req-server-mode-reuse' },
    });
    assert.equal(response.ok, true);
    assert.ok(
      daemon.rpcRequests.length > 0,
      'the request did not reach the daemon it found already running',
    );
    assert.equal(spawn.mock.calls.length, 0, 'a reusable daemon was replaced');
    assert.equal(fs.existsSync(paths.infoPath), true);
    assert.equal(isProcessAlive(process.pid), true);
  } finally {
    await closeLoopbackServer(daemon.server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test.for([
  {
    name: 'managed request',
    address: async (stateDir: string) =>
      await sendToDaemon({
        session: 'default',
        command: 'devices',
        positionals: [],
        flags: { stateDir, daemonTransport: 'http', daemonServerMode: 'socket' },
        meta: { requestId: 'req-server-mode-before-takeover' },
      }),
  },
  {
    name: 'ensure',
    address: async (stateDir: string) =>
      await ensureDaemon({ stateDir, daemonTransport: 'http', daemonServerMode: 'socket' }),
  },
] as const)(
  'the $name route refuses an unusable launch before it retires the daemon it found',
  async ({ address }) => {
    const stateDir = mkdtempForTestSync('agent-device-server-mode-takeover-');
    const paths = resolveDaemonPaths(stateDir);
    // Registered, version-matched, and reachable on neither endpoint: the takeover ladder would
    // judge it unreachable and retire it, which is the retirement this refusal has to prevent.
    writeDaemonRecord(stateDir, { port: 1, transport: 'socket' });

    const refusal = await address(stateDir).then(
      () => assert.fail('expected the route to be refused'),
      (error: unknown) => error,
    );
    assert.ok(refusal instanceof AppError, String(refusal));
    assert.equal(refusal.details?.reason, REFUSAL);
    assert.equal(spawn.mock.calls.length, 0);
    assert.equal(
      fs.existsSync(paths.infoPath),
      true,
      'the registered daemon was retired for a configuration that cannot succeed',
    );
    fs.rmSync(stateDir, { recursive: true, force: true });
  },
);
