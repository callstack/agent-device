import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import path from 'node:path';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  listLocalListeningPorts,
  probeLocalMetroServer,
  readAppReportedMetroServerUrl,
  type MetroAppTarget,
} from './metro-dev-server-discovery.ts';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';

const simulatorApp: MetroAppTarget = {
  platform: 'ios',
  deviceKind: 'simulator',
  deviceId: 'UDID-1',
  appId: 'com.example.app',
  hostedLocally: true,
};

function hostWithHome(home: string): HostEnvironment {
  return { env: { HOME: home }, cwd: home };
}

/** A simulator container holding this app's preferences file, as `open` leaves it. */
function simulatorHomeWithPreferences(udid: string, appId: string): string {
  const home = mkdtempForTestSync('agent-device-metro-plist-');
  const preferences = path.join(
    home,
    'Library/Developer/CoreSimulator/Devices',
    udid,
    'data/Library/Preferences',
  );
  mkdirSync(preferences, { recursive: true });
  writeFileSync(path.join(preferences, `${appId}.plist`), 'binary plist', 'utf8');
  return home;
}

test('the app-reported address is read from the preferences the simulator host converts', async () => {
  const home = simulatorHomeWithPreferences('UDID-1', 'com.example.app');
  try {
    let convertedPath = '';
    const reported = await withCommandExecutorOverride(
      (command, args) => {
        assert.equal(command, 'plutil');
        assert.deepEqual(args.slice(0, 4), ['-convert', 'json', '-o', '-']);
        convertedPath = args[4] ?? '';
        return Promise.resolve({
          stdout: '{"RCT_jsLocation":"127.0.0.1:8096"}',
          stderr: '',
          exitCode: 0,
        });
      },
      async () => await readAppReportedMetroServerUrl(simulatorApp, hostWithHome(home)),
    );
    assert.equal(reported?.toString(), 'http://127.0.0.1:8096/');
    assert.equal(convertedPath.endsWith(path.join('com.example.app.plist')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an app reports nothing when its preferences, HOME, or the converter is unavailable', async () => {
  const home = simulatorHomeWithPreferences('UDID-1', 'com.example.app');
  try {
    // Another app's container has no preferences file for this app.
    assert.equal(
      await readAppReportedMetroServerUrl(
        { ...simulatorApp, appId: 'com.other.app' },
        hostWithHome(home),
      ),
      undefined,
    );

    // No HOME means no simulator tree to read, and nothing is even spawned.
    const spawnedWithoutHome: string[] = [];
    assert.equal(
      await withCommandExecutorOverride(
        (command) => {
          spawnedWithoutHome.push(command);
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        },
        async () => await readAppReportedMetroServerUrl(simulatorApp, { env: {}, cwd: home }),
      ),
      undefined,
    );
    assert.deepEqual(spawnedWithoutHome, []);

    // `plutil` refusing to convert is a host that cannot answer for the app.
    assert.equal(
      await withCommandExecutorOverride(
        () => Promise.resolve({ stdout: '', stderr: 'plutil: conversion failed', exitCode: 1 }),
        async () => await readAppReportedMetroServerUrl(simulatorApp, hostWithHome(home)),
      ),
      undefined,
    );

    // A host without `plutil` at all: the spawn itself fails, and reload must not crash on it.
    assert.equal(
      await withCommandExecutorOverride(
        () => Promise.reject(new Error('plutil ENOENT')),
        async () => await readAppReportedMetroServerUrl(simulatorApp, hostWithHome(home)),
      ),
      undefined,
    );

    // Anything that is not an iOS simulator app has no stored address to read.
    for (const app of [
      { ...simulatorApp, platform: 'android' as const },
      { ...simulatorApp, deviceKind: 'device' as const },
      { ...simulatorApp, deviceKind: undefined },
      { ...simulatorApp, appId: undefined },
    ]) {
      assert.equal(await readAppReportedMetroServerUrl(app, hostWithHome(home)), undefined);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ports come from lsof when it is installed', async () => {
  const spawned: string[] = [];
  const ports = await withCommandExecutorOverride(
    (command) => {
      spawned.push(command);
      return Promise.resolve({
        stdout: command === 'lsof' ? 'p1\nn127.0.0.1:8081\nn*:8096\n' : '',
        stderr: '',
        exitCode: 0,
      });
    },
    async () => await listLocalListeningPorts(),
  );
  assert.deepEqual(ports, [8081, 8096]);
  // netstat is only asked where lsof could not answer.
  assert.deepEqual(spawned, ['lsof']);
});

test('ports fall back to netstat on a host without lsof', async () => {
  const spawned: string[] = [];
  const ports = await withCommandExecutorOverride(
    (command) => {
      spawned.push(command);
      if (command === 'lsof') return Promise.reject(new Error('lsof ENOENT'));
      return Promise.resolve({
        stdout: 'tcp4 0 0 127.0.0.1.8081 *.* LISTEN\ntcp4 0 0 127.0.0.1.9999 *.* ESTABLISHED\n',
        stderr: '',
        exitCode: 0,
      });
    },
    async () => await listLocalListeningPorts(),
  );
  assert.deepEqual(ports, [8081]);
  assert.deepEqual(spawned, ['lsof', 'netstat']);
});

test('a host with neither lsof nor netstat reports no ports instead of failing', async () => {
  const ports = await withCommandExecutorOverride(
    (command) => Promise.reject(new Error(`${command} ENOENT`)),
    async () => await listLocalListeningPorts(),
  );
  assert.deepEqual(ports, []);
});

test('a tool that answers with an empty success still lets the other tool answer', async () => {
  const ports = await withCommandExecutorOverride(
    (command) =>
      command === 'lsof'
        ? Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
        : Promise.resolve({
            stdout: 'tcp4 0 0 127.0.0.1:8081 0.0.0.0:* LISTEN',
            stderr: '',
            exitCode: 0,
          }),
    async () => await listLocalListeningPorts(),
  );
  assert.deepEqual(ports, [8081]);
});

test('a /status that says the packager is running reports the server and its project root', async () => {
  const server = answerStatusServer({
    body: 'packager-status:running',
    projectRoot: '/app/project',
  });
  const port = await listenOnLoopback(server);
  try {
    const running = await probeLocalMetroServer(new URL(`http://127.0.0.1:${port}`), 2_000);
    assert.equal(running?.serverUrl.port, String(port));
    assert.equal(running?.projectRoot, '/app/project');
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a server without a project-root header is reported without one', async () => {
  const server = answerStatusServer({ body: 'packager-status:running' });
  const port = await listenOnLoopback(server);
  try {
    const running = await probeLocalMetroServer(new URL(`http://127.0.0.1:${port}`), 2_000);
    assert.equal(running?.projectRoot, undefined);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a /status that is not Metro, or is not there at all, reports no server', async () => {
  const notMetro = answerStatusServer({ body: '<h1>Nothing here</h1>' });
  const notMetroPort = await listenOnLoopback(notMetro);
  const unavailable = answerStatusServer({
    body: 'packager-status:running',
    statusCode: 503,
  });
  const unavailablePort = await listenOnLoopback(unavailable);
  try {
    assert.equal(
      await probeLocalMetroServer(new URL(`http://127.0.0.1:${notMetroPort}`), 2_000),
      undefined,
    );
    assert.equal(
      await probeLocalMetroServer(new URL(`http://127.0.0.1:${unavailablePort}`), 2_000),
      undefined,
    );
    // A port nothing listens on: a connection error, not a crash.
    assert.equal(await probeLocalMetroServer(new URL('http://127.0.0.1:1'), 500), undefined);
  } finally {
    await closeLoopbackServer(notMetro);
    await closeLoopbackServer(unavailable);
  }
});

function answerStatusServer(answer: {
  body: string;
  projectRoot?: string;
  statusCode?: number;
}): Server {
  return createServer((_req, res) => {
    if (answer.projectRoot) {
      res.setHeader('x-react-native-project-root', answer.projectRoot);
    }
    res.statusCode = answer.statusCode ?? 200;
    res.end(answer.body);
  });
}
