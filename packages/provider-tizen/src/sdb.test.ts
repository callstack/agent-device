import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { afterEach, test, vi } from 'vitest';

import { createSdb, parseAppList, parseDebugPort, parseDevices, sdbSerial } from './sdb.ts';

const APP_ID = 'AbCdE12345.example';
const SERIAL = '192.0.2.10:26101';
const DEBUG_PORT = 34567;

// Records every call. SDB_DEBUG picks how `0 debug` answers, SDB_REMOVE_FAIL makes `forward --remove`
// exit 1 with it on stderr, and SDB_FAIL does the same for the other commands. One script serves every test, because macOS checks each new
// executable on its first run.
const SDB = path.join(mkdtempForTestSync('sdb-'), 'sdb');
writeFileSync(
  SDB,
  `#!/bin/sh
echo "$*" >> "$SDB_CALLS"
case "$*" in
  *" debug "*)
    case "$SDB_DEBUG" in
      port) echo 'successfully launched pid = 4242 with debug 1 port: ${DEBUG_PORT}' ;;
      hang) exec sleep 30 ;;
      *) echo 'closed'; exit 1 ;;
    esac ;;
  *"forward --remove"*) if [ -n "$SDB_REMOVE_FAIL" ]; then echo "$SDB_REMOVE_FAIL" >&2; exit 1; fi ;;
  *vd_applist*) printf '%s\\n' '--app_title   =Example TV----' '--app_tizen_id   =${APP_ID}----' ;;
  *) if [ -n "$SDB_FAIL" ]; then echo "$SDB_FAIL" >&2; exit 1; fi ;;
esac
`,
);
chmodSync(SDB, 0o755);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fakeTv(env: Record<string, string> = {}) {
  const log = path.join(mkdtempForTestSync('sdb-calls-'), 'calls');
  writeFileSync(log, '');
  const sdb = createSdb(() => SDB, { ...process.env, SDB_CALLS: log, ...env });
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { sdb, tv: sdb.forDevice(SERIAL), calls };
}

const forwardedPort = (calls: readonly string[]) =>
  calls
    .map((call) => call.match(new RegExp(`forward tcp:(\\d+) tcp:${DEBUG_PORT}$`))?.[1])
    .find(Boolean);

// Serves the page list the TV's inspector exposes, on the local port sdb was asked to forward.
async function servePageOnForward(calls: () => string[]) {
  const port = await vi.waitFor(
    () => {
      const forwarded = forwardedPort(calls());
      assert.ok(forwarded);
      return Number(forwarded);
    },
    { timeout: 3000 },
  );
  const server = createServer((_request, response) => {
    response.end(
      JSON.stringify([
        {
          title: 'Example TV',
          url: `file:///opt/usr/apps/${APP_ID}/index.html`,
          webSocketDebuggerUrl: 'ws://localhost/devtools/page/1',
        },
      ]),
    );
  });
  server.listen(port);
  await once(server, 'listening');
  cleanups.push(() => void server.close());
}

test('launch kills the app, forwards the debug port it prints and returns the page; close removes the forward', async () => {
  const { tv, calls } = fakeTv({ SDB_DEBUG: 'port' });

  const launching = tv.launch(APP_ID, { settleMs: 0 });
  await servePageOnForward(calls);
  const tunnel = await launching;
  let notified = false;
  tunnel.onClose(() => {
    notified = true;
  });
  await tunnel.close();

  assert.equal(tunnel.target.webSocketDebuggerUrl, 'ws://localhost/devtools/page/1');
  assert.equal(notified, true);
  const localPort = forwardedPort(calls());
  assert.deepEqual(calls(), [
    `-s ${SERIAL} shell 0 was_kill ${APP_ID}`,
    `-s ${SERIAL} shell 0 debug ${APP_ID}`,
    `-s ${SERIAL} forward tcp:${localPort} tcp:${DEBUG_PORT}`,
    `-s ${SERIAL} forward --remove tcp:${localPort}`,
  ]);
});

test('a debug launch that prints no port in time says the app was probably still running', async () => {
  const { tv } = fakeTv({ SDB_DEBUG: 'hang' });

  const launching = tv.launch(APP_ID, { settleMs: 0, timeoutMs: 300 });

  await assert.rejects(launching, (error: { message?: string; details?: { hint?: string } }) => {
    assert.equal(error.message, `${APP_ID} gave no debug port in 300ms`);
    assert.match(error.details?.hint ?? '', /still running/);
    return true;
  });
});

test('a debug launch that exits without a port fails before any forward', async () => {
  const { tv, calls } = fakeTv({ SDB_DEBUG: 'none' });

  const launching = tv.launch(APP_ID, { settleMs: 0 });

  await assert.rejects(launching, { message: `sdb debug ${APP_ID} exited without a port` });
  assert.equal(forwardedPort(calls()), undefined);
});

test('a cancelled launch keeps its request-canceled reason and opens no forward', async () => {
  const { tv, calls } = fakeTv({ SDB_DEBUG: 'hang' });
  const cancel = new AbortController();

  const launching = tv.launch(APP_ID, { settleMs: 0, signal: cancel.signal });
  await vi.waitFor(() => assert.ok(calls().includes(`-s ${SERIAL} shell 0 debug ${APP_ID}`)));
  cancel.abort();

  await assert.rejects(launching, isRequestCanceledError);
  assert.equal(forwardedPort(calls()), undefined);
});

test('a debug port that shows no page within the timeout removes the forward', async () => {
  const { tv, calls } = fakeTv({ SDB_DEBUG: 'port' });

  const launching = tv.launch(APP_ID, { settleMs: 0, timeoutMs: 600 });

  await assert.rejects(launching, {
    message: `${APP_ID} opened debug port ${DEBUG_PORT} but showed no page within 600ms`,
  });
  assert.match(calls().at(-1) ?? '', /forward --remove tcp:\d+$/);
});

test('a launch cancelled while waiting for the page removes the forward and stays cancelled', async () => {
  const { tv, calls } = fakeTv({ SDB_DEBUG: 'port' });
  const cancel = new AbortController();

  const launching = tv.launch(APP_ID, { settleMs: 0, signal: cancel.signal });
  await vi.waitFor(() => assert.ok(forwardedPort(calls())));
  cancel.abort();

  await assert.rejects(launching, isRequestCanceledError);
  assert.equal(calls().at(-1), `-s ${SERIAL} forward --remove tcp:${forwardedPort(calls())}`);
});

test('a failed launch whose forward cannot be removed keeps its error and names the removal failure', async () => {
  const { tv } = fakeTv({ SDB_DEBUG: 'port', SDB_REMOVE_FAIL: 'error: listener not found' });

  const launching = tv.launch(APP_ID, { settleMs: 0, timeoutMs: 300 });

  await assert.rejects(
    launching,
    (error: { message?: string; details?: Record<string, unknown> }) => {
      assert.match(error.message ?? '', /showed no page within 300ms$/);
      assert.match(String(error.details?.tunnelRemoval), /error: listener not found/);
      return true;
    },
  );
});

test('listApps reads the installed apps from vd_applist on the TV', async () => {
  const { tv, calls } = fakeTv();

  const apps = await tv.listApps();

  assert.deepEqual(apps, [{ id: APP_ID, name: 'Example TV' }]);
  assert.deepEqual(calls(), [`-s ${SERIAL} shell 0 vd_applist`]);
});

test('a forward sdb refuses fails with its stderr and runs no removal', async () => {
  const { tv, calls } = fakeTv({ SDB_DEBUG: 'port', SDB_FAIL: 'error: cannot bind listener' });

  const launching = tv.launch(APP_ID, { settleMs: 0 });

  await assert.rejects(
    launching,
    (error: { message?: string; details?: Record<string, unknown> }) => {
      assert.match(
        error.message ?? '',
        /forward tcp:\d+ tcp:34567 failed: error: cannot bind listener$/,
      );
      assert.equal(error.details?.tunnelRemoval, undefined);
      return true;
    },
  );
  assert.equal(
    calls().some((call) => call.includes('--remove')),
    false,
  );
});

test('a failing sdb command reports its stderr in a COMMAND_FAILED message', async () => {
  const { sdb } = fakeTv({ SDB_FAIL: `failed to connect to ${SERIAL}` });

  const connecting = sdb.connect(SERIAL);

  await assert.rejects(connecting, {
    code: 'COMMAND_FAILED',
    message: `sdb connect ${SERIAL} failed: failed to connect to ${SERIAL}`,
  });
});

test('an sdb missing at the configured path fails as TOOL_MISSING with the SDK hint', async () => {
  const sdb = createSdb(() => path.join(mkdtempForTestSync('sdb-'), 'sdb'), process.env);

  const listing = sdb.listDevices();

  await assert.rejects(listing, (error: { code?: string; details?: { hint?: string } }) => {
    assert.equal(error.code, 'TOOL_MISSING');
    assert.match(error.details?.hint ?? '', /sdbPath/);
    return true;
  });
});

test('parseDevices reads serial, state and model from sdb devices', () => {
  const output = [
    'List of devices attached ',
    '192.0.2.10:26101 \tdevice    \tQE55Q80',
    '192.0.2.11:26101 \toffline   \t',
    '',
  ].join('\n');

  const devices = parseDevices(output);

  assert.deepEqual(devices, [
    { serial: '192.0.2.10:26101', state: 'device', model: 'QE55Q80' },
    { serial: '192.0.2.11:26101', state: 'offline', model: '' },
  ]);
});

test('parseAppList reads each user app id with its title from vd_applist', () => {
  const output = [
    '',
    'get app list...',
    'apps count: 2',
    '---------------------------------------------------------------------------------------------',
    '--------------app_id                                =3201000000001-------------',
    '--------------app_title                             =Example TV: News, Sports-------------',
    '--------------app_tizen_id                          =AbCdE12345.example-------------',
    '---------------------------------------------------------------------------------------------',
    '--------------app_id                                =FgHiJ67890.dist-------------',
    '--------------app_title                             =-------------',
    '--------------app_tizen_id                          =FgHiJ67890.Untitled-------------',
  ].join('\n');

  const apps = parseAppList(output);

  assert.deepEqual(apps, [
    { id: 'AbCdE12345.example', name: 'Example TV: News, Sports' },
    { id: 'FgHiJ67890.Untitled', name: 'FgHiJ67890.Untitled' },
  ]);
});

test('parseDebugPort finds the port a debug launch prints, and nothing in other output', () => {
  assert.equal(
    parseDebugPort('... successfully launched pid = 4242 with debug 1\nport: 37145\n'),
    37145,
  );
  assert.equal(parseDebugPort('closed'), undefined);
});

test('a bare TV IP gets the sdb port, and a full serial is kept', () => {
  assert.equal(sdbSerial('192.0.2.10'), '192.0.2.10:26101');
  assert.equal(sdbSerial('192.0.2.10:26101'), '192.0.2.10:26101');
  assert.equal(sdbSerial('emulator-26101'), 'emulator-26101');
});
