import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { afterEach, test, vi } from 'vitest';

import { createAres } from './ares.ts';

function fakeAresBin(outputs: Record<string, string>) {
  const bin = mkdtempForTestSync('ares-');
  for (const [name, output] of Object.entries(outputs)) {
    const script = path.join(bin, name);
    writeFileSync(script, `#!/bin/sh\ncat <<'OUTPUT'\n${output}\nOUTPUT\n`);
    chmodSync(script, 0o755);
  }
  return bin;
}

test('listDevices returns only TV profiles, each at its ip:port, or at its name for a USB entry', async () => {
  const bin = fakeAresBin({
    'ares-setup-device': JSON.stringify([
      {
        profile: 'tv',
        name: 'living-room',
        default: true,
        deviceinfo: { ip: '192.0.2.10', port: '9922' },
      },
      {
        profile: 'ose',
        name: 'signage',
        default: false,
        deviceinfo: { ip: '192.0.2.20', port: '9922' },
      },
      { profile: 'tv', name: 'usb-tv', default: false, deviceinfo: { uid: 'usb-1' } },
    ]),
  });

  const devices = await createAres(bin, process.env).listDevices();

  assert.deepEqual(devices, [
    { name: 'living-room', endpoint: '192.0.2.10:9922', isDefault: true },
    { name: 'usb-tv', endpoint: 'usb-tv', isDefault: false },
  ]);
});

test('listApps reads each app id with its title from ares-install --listfull', async () => {
  const bin = fakeAresBin({
    'ares-install': [
      '[Info] Set target device : living-room',
      'id : com.sdk.ares.hostedapp',
      'title : Ares Hosted App',
      'version : 1.1.0',
      '',
      'id : com.example.tvapp',
      'title : Example TV',
      'requiredACG',
      '',
      'id : com.example.untitled',
    ].join('\n'),
  });

  const apps = await createAres(bin, process.env).forDevice('living-room').listApps();

  assert.deepEqual(apps, [
    { id: 'com.sdk.ares.hostedapp', name: 'Ares Hosted App' },
    { id: 'com.example.tvapp', name: 'Example TV' },
    { id: 'com.example.untitled', name: 'com.example.untitled' },
  ]);
});

test('a missing webOS CLI fails as TOOL_MISSING with a hint naming aresBin', async () => {
  const bin = fakeAresBin({});

  const listing = createAres(bin, process.env).listDevices();

  await assert.rejects(listing, (error: { code?: string; details?: { hint?: string } }) => {
    assert.equal(error.code, 'TOOL_MISSING');
    assert.match(error.details?.hint ?? '', /aresBin/);
    return true;
  });
});

test('a failing ares command reports its stderr in a COMMAND_FAILED message', async () => {
  const bin = mkdtempForTestSync('ares-');
  const script = path.join(bin, 'ares-launch');
  writeFileSync(script, `#!/bin/sh\necho 'ERR! Connection timed out' >&2\nexit 1\n`);
  chmodSync(script, 0o755);

  const launch = createAres(bin, process.env).forDevice('living-room').launch('com.example.app');

  await assert.rejects(launch, (error: { code?: string; message?: string }) => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.message, 'ares-launch failed: ERR! Connection timed out');
    return true;
  });
});

test('a cancelled ares-launch keeps its request-canceled reason', async () => {
  const bin = mkdtempForTestSync('ares-');
  const script = path.join(bin, 'ares-launch');
  writeFileSync(script, '#!/bin/sh\nsleep 30\n');
  chmodSync(script, 0o755);
  const cancel = new AbortController();

  const launch = createAres(bin, process.env)
    .forDevice('living-room')
    .launch('com.example.app', cancel.signal);
  cancel.abort();

  await assert.rejects(launch, isRequestCanceledError);
});

const APP_ID = 'com.example.app';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function writeScript(bin: string, name: string, body: string) {
  const script = path.join(bin, name);
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
}

// Serves the inspector target list the way the ares-inspect tunnel exposes it on localhost.
async function fakeInspector(status = 200) {
  const server = createServer((_request, response) => {
    response.statusCode = status;
    response.end(
      JSON.stringify([
        {
          title: APP_ID,
          url: `file:///media/developer/apps/usr/palm/applications/${APP_ID}/index.html`,
          webSocketDebuggerUrl: 'ws://localhost/devtools/page/1',
        },
      ]),
    );
  });
  server.listen(0);
  await once(server, 'listening');
  cleanups.push(() => void server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

// Prints the inspector port like ares-inspect, records its pid, then stays up as the tunnel. One
// script serves every test, because macOS checks each new executable on its first run.
const TUNNEL_BIN = mkdtempForTestSync('ares-');
writeScript(
  TUNNEL_BIN,
  'ares-inspect',
  'echo $$ > "$PID_FILE"\necho "Application Debugging - http://localhost:$INSPECTOR_PORT"\nexec sleep 30',
);

function tunnel(port: number) {
  const pidFile = path.join(mkdtempForTestSync('ares-tunnel-'), 'ares-inspect.pid');
  const isRunning = () => {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
      return true;
    } catch {
      return false;
    }
  };
  const ares = createAres(TUNNEL_BIN, {
    ...process.env,
    INSPECTOR_PORT: String(port),
    PID_FILE: pidFile,
  });
  return { tv: ares.forDevice('living-room'), isRunning };
}

test('inspect returns the app page on the port ares-inspect prints, and close ends the tunnel', async () => {
  const { tv, isRunning } = tunnel(await fakeInspector());

  const opened = await tv.inspect(APP_ID);
  const ended = new Promise((resolve) => opened.onClose(() => resolve(undefined)));
  opened.close();
  await ended;

  assert.equal(opened.target.webSocketDebuggerUrl, 'ws://localhost/devtools/page/1');
  assert.equal(isRunning(), false);
});

test('an ares-inspect that exits before the page appears reports its output', async () => {
  const bin = mkdtempForTestSync('ares-');
  writeScript(bin, 'ares-inspect', "echo 'ERR! device unreachable'\nexit 1");

  const inspecting = createAres(bin, process.env).forDevice('living-room').inspect(APP_ID);

  await assert.rejects(inspecting, (error: { code?: string; message?: string }) => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.message, 'ares-inspect exited: ERR! device unreachable');
    return true;
  });
});

test('a missing ares-inspect fails as TOOL_MISSING', async () => {
  const inspecting = createAres(mkdtempForTestSync('ares-'), process.env)
    .forDevice('living-room')
    .inspect(APP_ID);

  await assert.rejects(inspecting, (error: { code?: string }) => error.code === 'TOOL_MISSING');
});

test('no page within the timeout ends the tunnel and names the last inspector failure', async () => {
  const port = await fakeInspector(500);
  const { tv, isRunning } = tunnel(port);

  const inspecting = tv.inspect(APP_ID, undefined, 1000);

  await assert.rejects(inspecting, (error: { message?: string }) => {
    assert.equal(
      error.message,
      `ares-inspect found no page for ${APP_ID} on living-room within 1000ms; the inspector last failed with: The inspector at localhost:${port} answered 500`,
    );
    return true;
  });
  await vi.waitFor(() => assert.equal(isRunning(), false), { timeout: 3000 });
});

test('a cancelled inspect ends the tunnel and keeps its request-canceled reason', async () => {
  const { tv, isRunning } = tunnel(await fakeInspector(500));
  const cancel = new AbortController();

  const inspecting = tv.inspect(APP_ID, cancel.signal);
  await vi.waitFor(() => assert.equal(isRunning(), true), { timeout: 3000 });
  cancel.abort();

  await assert.rejects(inspecting, isRequestCanceledError);
  await vi.waitFor(() => assert.equal(isRunning(), false), { timeout: 3000 });
});
