import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { createAgentDeviceClient } from '../index.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  writeMetroSessionFixture,
} from '@agent-device/test-kit';
import type { MetroAppTarget } from '@agent-device/react-native';

// `metro reload` may look a dev server up on this machine only when the client's daemon is local and
// the session's app is recorded as hosted here. These pin that decision through the real client path.
// The port listing is answered from a table, so a test sweeps its own ports instead of the machine's,
// and never reaches the default port a refused search would otherwise call.

const listing = vi.hoisted(() => ({ ports: [] as number[], commands: [] as string[] }));

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmd: async (cmd: string) => {
    listing.commands.push(cmd);
    return cmd === 'lsof'
      ? {
          stdout: listing.ports.map((port) => `n127.0.0.1:${port}`).join('\n'),
          stderr: '',
          exitCode: 0,
        }
      : { stdout: '', stderr: '', exitCode: 1 };
  },
}));

const localApp = {
  platform: 'android',
  deviceKind: 'emulator',
  deviceId: 'emulator-5554',
  appId: 'com.example.app',
  hostedLocally: true,
} as const satisfies MetroAppTarget;

function devServer(projectRoot: string) {
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

function workspace(name: string) {
  const root = mkdtempForTestSync(`agent-device-client-reload-${name}`);
  const projectRoot = path.join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"p","private":true}');
  return { stateDir: path.join(root, 'state'), projectRoot };
}

/** A client whose daemon is local unless `daemonBaseUrl` says otherwise, and that never gets a command. */
function clientFor(options: { stateDir: string; projectRoot: string; daemonBaseUrl: string }) {
  return createAgentDeviceClient(
    {
      session: 'qa',
      stateDir: options.stateDir,
      cwd: options.projectRoot,
      daemonBaseUrl: options.daemonBaseUrl,
    },
    {
      transport: async () => {
        throw new Error('flagless metro reload must stay local and never call the daemon');
      },
      host: { env: {}, cwd: options.projectRoot },
    },
  );
}

async function withDevServer<T>(
  projectRoot: string,
  ports: boolean,
  run: (port: number, requests: string[]) => Promise<T>,
): Promise<T> {
  const { server, requests } = devServer(projectRoot);
  const port = await listenOnLoopback(server);
  listing.ports = ports ? [port] : [];
  listing.commands = [];
  try {
    return await run(port, requests);
  } finally {
    listing.ports = [];
    listing.commands = [];
    await closeLoopbackServer(server);
  }
}

test('a local daemon reload reloads the local dev server that serves this project', async () => {
  const { stateDir, projectRoot } = workspace('local-found');
  writeMetroSessionFixture({ stateDir, session: 'qa', hints: { app: localApp } });
  try {
    await withDevServer(projectRoot, true, async (port, requests) => {
      const client = clientFor({
        stateDir,
        projectRoot,
        daemonBaseUrl: `http://127.0.0.1:${port}`,
      });
      const result = await client.metro.reload();
      assert.equal(result.reloadUrl, `http://127.0.0.1:${port}/reload`);
      assert.equal(result.body, 'RELOADED');
      assert.deepEqual(listing.commands, ['lsof']);
      assert.ok(requests.some((url) => url.startsWith('/status')));
    });
  } finally {
    rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('a local daemon reload refuses another project’s server and fails typed', async () => {
  const { stateDir, projectRoot } = workspace('local-foreign');
  writeMetroSessionFixture({ stateDir, session: 'qa', hints: { app: localApp } });
  try {
    await withDevServer('/someone/else/project', true, async (port, requests) => {
      const client = clientFor({
        stateDir,
        projectRoot,
        daemonBaseUrl: `http://127.0.0.1:${port}`,
      });
      await assert.rejects(
        () => client.metro.reload(),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.details?.reason, 'metro_dev_server_unresolved');
          return true;
        },
      );
      // The foreign server was probed and refused — never reloaded.
      assert.equal(
        requests.some((url) => url.startsWith('/reload')),
        false,
      );
    });
  } finally {
    rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('a bound session address is used as given, with no search of this machine', async () => {
  const { stateDir, projectRoot } = workspace('local-bound');
  writeMetroSessionFixture({
    stateDir,
    session: 'qa',
    hints: { app: localApp, controlBaseUrl: 'http://127.0.0.1:1/' },
  });
  try {
    await withDevServer(projectRoot, true, async (port) => {
      const client = clientFor({
        stateDir,
        projectRoot,
        daemonBaseUrl: `http://127.0.0.1:${port}`,
      });
      // The bound address is unreachable, so the reload fails — but only after the client committed to
      // it without probing this machine's ports, which is what the caller asked for.
      await client.metro.reload().catch(() => undefined);
      assert.deepEqual(listing.commands, []);
    });
  } finally {
    rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

/**
 * Answers every HTTP call reload makes from a table: records the address, serves `/status` as this
 * project's dev server, and `/reload` as a reload. Used by the cases that must prove *which* address
 * reload settled on, including the default one, without a server on that port.
 */
function recordFetchCalls(run: () => Promise<unknown>, projectRoot: string) {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.pathname === '/status') {
      return new Response('packager-status:running', {
        headers: { 'x-react-native-project-root': projectRoot },
      });
    }
    return new Response('RELOADED');
  }) as typeof globalThis.fetch;
  return run()
    .catch(() => undefined)
    .then(() => {
      globalThis.fetch = originalFetch;
      return calls;
    });
}

test('a client aimed at a remote daemon does not offer this machine’s dev servers', async () => {
  const { stateDir, projectRoot } = workspace('remote-daemon');
  writeMetroSessionFixture({ stateDir, session: 'qa', hints: { app: localApp } });
  listing.ports = [8081];
  listing.commands = [];
  try {
    const client = clientFor({
      stateDir,
      projectRoot,
      daemonBaseUrl: 'https://fleet.example.test',
    });
    const calls = await recordFetchCalls(() => client.metro.reload(), projectRoot);
    // The devices a remote daemon drives are not on this machine, so reload stays on the address the
    // session's own hints resolve to and never sweeps these ports.
    assert.deepEqual(listing.commands, []);
    assert.deepEqual(calls, ['http://localhost:8081/reload']);
  } finally {
    listing.ports = [];
    listing.commands = [];
    rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('a session whose app this machine does not host skips the local search', async () => {
  const { stateDir, projectRoot } = workspace('remote-device');
  writeMetroSessionFixture({
    stateDir,
    session: 'qa',
    hints: { app: { ...localApp, deviceKind: 'device', hostedLocally: false } },
  });
  listing.ports = [8081];
  listing.commands = [];
  try {
    const client = clientFor({
      stateDir,
      projectRoot,
      daemonBaseUrl: 'http://127.0.0.1:1',
    });
    const calls = await recordFetchCalls(() => client.metro.reload(), projectRoot);
    assert.deepEqual(listing.commands, []);
    assert.deepEqual(calls, ['http://localhost:8081/reload']);
  } finally {
    listing.ports = [];
    listing.commands = [];
    rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('a session with no recorded app skips the local search', async () => {
  const { stateDir, projectRoot } = workspace('no-app');
  listing.ports = [8081];
  listing.commands = [];
  try {
    const client = clientFor({ stateDir, projectRoot, daemonBaseUrl: 'http://127.0.0.1:1' });
    const calls = await recordFetchCalls(() => client.metro.reload(), projectRoot);
    assert.deepEqual(listing.commands, []);
    assert.deepEqual(calls, ['http://localhost:8081/reload']);
  } finally {
    listing.ports = [];
    listing.commands = [];
    rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});
