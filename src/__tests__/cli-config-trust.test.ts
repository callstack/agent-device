import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { runCliCapture } from './cli-capture.ts';
import { makeTempWorkspace } from './cli-config-fixtures.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

test('project config rejects remote connection fields before daemon dispatch without echoing values', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({
      daemonBaseUrl: 'https://daemon.example.test',
      daemonAuthToken: 'token-123',
      daemonTransport: 'http',
      tenant: 'tenant-123',
      runId: 'run-123',
      leaseId: 'lease-123',
      platform: 'ios',
    }),
    'utf8',
  );

  const result = await runCliCapture(['press', '10', '20'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /daemonBaseUrl/);
  assert.match(output, /not allowed in project config file/i);
  assert.doesNotMatch(output, /daemon\.example\.test|token-123|tenant-123|run-123|lease-123/);

  fs.rmSync(root, { recursive: true, force: true });
});

test.each([
  ['daemonAuthToken', 'synthetic-token'],
  ['daemonTransport', 'http'],
  ['daemonServerMode', 'http'],
  ['tenant', 'tenant-controlled-by-project'],
  ['sessionIsolation', 'tenant'],
  ['runId', 'project-run'],
  ['leaseId', 'project-lease'],
  ['leaseBackend', 'android-instance'],
  ['provider', 'browserstack'],
  ['metroBearerToken', 'synthetic-metro-token'],
  ['header', ['authorization: Bearer synthetic-header-token']],
] as const)(
  'project config rejects protected %s without dispatching or echoing its value',
  async (key, value) => {
    const { root, home, project } = makeTempWorkspace();
    fs.writeFileSync(
      path.join(project, 'agent-device.json'),
      JSON.stringify({ [key]: value }),
      'utf8',
    );

    const result = await runCliCapture(['devices'], {
      cwd: project,
      env: { HOME: home },
    });

    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, new RegExp(key));
    assert.doesNotMatch(
      output,
      /synthetic-token|tenant-controlled-by-project|project-run|project-lease|browserstack|synthetic-metro-token|synthetic-header-token/,
    );

    fs.rmSync(root, { recursive: true, force: true });
  },
);

test('project config rejects a custom reporter before importing repository code or dispatching', async () => {
  const { root, home, project } = makeTempWorkspace();
  const importMarker = path.join(project, 'reporter-imported');
  fs.writeFileSync(
    path.join(project, 'project-reporter.mjs'),
    [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(importMarker)}, 'imported', 'utf8');`,
      "export default { name: 'project-controlled-reporter' };",
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ reporter: ['./project-reporter.mjs'] }),
    'utf8',
  );

  const result = await runCliCapture(['test', './suite'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.equal(fs.existsSync(importMarker), false);
  assert.match(`${result.stdout}\n${result.stderr}`, /reporter/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /project-reporter\.mjs/);

  fs.rmSync(root, { recursive: true, force: true });
});

test.each([
  ['reportJunit', './project.junit.xml', ['test', './suite']],
  ['saveScript', './project.ad', ['open', 'Demo']],
  ['launchConsole', './project.console.log', ['open', 'Demo']],
] as const)(
  'project config rejects local write sink %s before dispatch or file creation',
  async (key, value, argv) => {
    const { root, home, project } = makeTempWorkspace();
    const dispatchMarker = path.join(project, 'daemon-dispatched');
    const outputPath = path.join(project, value);
    fs.writeFileSync(
      path.join(project, 'agent-device.json'),
      JSON.stringify({ [key]: value }),
      'utf8',
    );

    const result = await runCliCapture([...argv], {
      cwd: project,
      env: { HOME: home },
      sendToDaemon: async () => {
        fs.writeFileSync(dispatchMarker, 'dispatched', 'utf8');
        return { ok: true, data: {} };
      },
    });

    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
    assert.equal(fs.existsSync(dispatchMarker), false);
    assert.equal(fs.existsSync(outputPath), false);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(key));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(path.basename(value)));

    fs.rmSync(root, { recursive: true, force: true });
  },
);

test('project config cannot pair an endpoint with an environment token', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ daemonBaseUrl: 'https://example.trycloudflare.com/agent-device' }),
    'utf8',
  );

  const result = await runCliCapture(['devices'], {
    cwd: project,
    env: { HOME: home, AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'operator-token' },
  });

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /daemonBaseUrl/);
  assert.doesNotMatch(output, /example\.trycloudflare\.com|operator-token/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('project-selected endpoint with an environment token makes no health or RPC request', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'project config transport rejection coverage')) return;
  const { root, home, project } = makeTempWorkspace();
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, rpcProtocolVersion: 2 }));
  });
  const port = await listenOnLoopback(server);
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ daemonBaseUrl: `http://127.0.0.1:${port}/agent-device` }),
    'utf8',
  );

  try {
    const result = await runCliCapture(['devices'], {
      cwd: project,
      env: { HOME: home, AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'operator-token' },
      useRealDaemonClient: true,
    });

    assert.equal(result.code, 1);
    assert.deepEqual(requests, []);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /operator-token/);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('user and explicit config retain remote auth through the ordinary CLI adapter', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.agent-device', 'config.json'),
    JSON.stringify({
      daemonBaseUrl: 'https://daemon.example.test',
      daemonAuthToken: 'user-token',
      daemonTransport: 'http',
      tenant: 'user-tenant',
    }),
    'utf8',
  );

  const userResult = await runCliCapture(['devices'], {
    cwd: project,
    env: { HOME: home },
  });
  assert.equal(userResult.code, null);
  assert.equal(userResult.calls[0]?.flags?.daemonBaseUrl, 'https://daemon.example.test');
  assert.equal(Object.hasOwn(userResult.calls[0]?.flags ?? {}, 'daemonAuthToken'), false);
  assert.equal(userResult.transportOptions[0]?.authToken, 'user-token');

  const explicitConfig = path.join(root, 'explicit.json');
  fs.writeFileSync(
    explicitConfig,
    JSON.stringify({
      daemonBaseUrl: 'https://explicit.example.test',
      daemonAuthToken: 'explicit-token',
    }),
    'utf8',
  );
  const explicitResult = await runCliCapture(['devices', '--config', explicitConfig], {
    cwd: project,
    env: { HOME: home },
  });
  assert.equal(explicitResult.code, null);
  assert.equal(explicitResult.calls[0]?.flags?.daemonBaseUrl, 'https://explicit.example.test');
  assert.equal(Object.hasOwn(explicitResult.calls[0]?.flags ?? {}, 'daemonAuthToken'), false);
  assert.equal(explicitResult.transportOptions[0]?.authToken, 'explicit-token');

  fs.rmSync(root, { recursive: true, force: true });
});
