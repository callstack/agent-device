import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { reloadMetro } from './index.ts';
import { AppError } from '@agent-device/kernel/errors';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import type { MetroAppTarget } from './metro/metro-dev-server-discovery.ts';

// These run the whole local reload path against a loopback dev server: the session record's app, the
// host's listening ports, the real `/status` probe, and the real reload call. Only the port listing is
// answered from a table, so a test does not sweep whatever else this machine listens on.

const portListing = vi.hoisted(() => ({ ports: [] as number[] }));

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmd: async (cmd: string) =>
    cmd === 'lsof'
      ? {
          stdout: portListing.ports.map((port) => `n127.0.0.1:${port}`).join('\n'),
          stderr: '',
          exitCode: 0,
        }
      : { stdout: '', stderr: '', exitCode: 1 },
}));

const app: MetroAppTarget = {
  platform: 'android',
  deviceKind: 'emulator',
  deviceId: 'emulator-5554',
  appId: 'com.example.app',
  hostedLocally: true,
};

function answerStatus(projectRoot: string) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(url);
    if (url.startsWith('/status')) {
      res.setHeader('x-react-native-project-root', projectRoot);
      res.end('packager-status:running');
      return;
    }
    if (url.startsWith('/reload')) {
      res.end('RELOADED');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return { server, requests };
}

function projectDir(name: string): string {
  const root = mkdtempForTestSync(`agent-device-metro-reload-${name}`);
  const projectRoot = path.join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"p","private":true}');
  return projectRoot;
}

test('a local reload with no binding reloads the dev server that serves this project', async () => {
  const projectRoot = projectDir('match');
  const { server, requests } = answerStatus(projectRoot);
  const port = await listenOnLoopback(server);
  portListing.ports = [port];
  try {
    const result = await reloadMetro({
      host: { env: {}, cwd: projectRoot },
      projectRoot,
      app,
    });
    assert.equal(result.reloadUrl, `http://127.0.0.1:${port}/reload`);
    assert.equal(result.body, 'RELOADED');
    assert.ok(requests.some((url) => url.startsWith('/status')));
  } finally {
    portListing.ports = [];
    await closeLoopbackServer(server);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('a local reload never picks another project’s dev server and fails typed instead', async () => {
  const projectRoot = projectDir('foreign');
  const { server, requests } = answerStatus('/someone/else/project');
  const port = await listenOnLoopback(server);
  portListing.ports = [port];
  try {
    await assert.rejects(
      () => reloadMetro({ host: { env: {}, cwd: projectRoot }, projectRoot, app }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'metro_dev_server_unresolved');
        assert.equal(error.details?.triedUrl, 'http://localhost:8081/');
        return true;
      },
    );
    // The foreign server was probed and refused — never reloaded.
    assert.ok(requests.some((url) => url.startsWith('/status')));
    assert.equal(
      requests.some((url) => url.startsWith('/reload')),
      false,
    );
  } finally {
    portListing.ports = [];
    await closeLoopbackServer(server);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('an explicit target is never second-guessed: discovery does not run for a bound reload', async () => {
  const projectRoot = projectDir('bound');
  const { server, requests } = answerStatus('/someone/else/project');
  const port = await listenOnLoopback(server);
  portListing.ports = [port];
  try {
    const result = await reloadMetro({
      metroHost: '127.0.0.1',
      metroPort: port,
      host: { env: {}, cwd: projectRoot },
      projectRoot,
      app,
    });
    assert.equal(result.reloadUrl, `http://127.0.0.1:${port}/reload`);
    assert.equal(result.body, 'RELOADED');
    assert.equal(
      requests.some((url) => url.startsWith('/status')),
      false,
    );
  } finally {
    portListing.ports = [];
    await closeLoopbackServer(server);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('reload without a host keeps the pre-discovery default address', async () => {
  const { server, requests } = answerStatus('/someone/else/project');
  const port = await listenOnLoopback(server);
  portListing.ports = [port];
  try {
    // No `host`: no machine was named to look a dev server up on, so the hints resolve as before.
    const result = await reloadMetro({ metroHost: '127.0.0.1', metroPort: port });
    assert.equal(result.reloadUrl, `http://127.0.0.1:${port}/reload`);
    assert.equal(
      requests.some((url) => url.startsWith('/status')),
      false,
    );
  } finally {
    portListing.ports = [];
    await closeLoopbackServer(server);
  }
});
