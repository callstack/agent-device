import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAgentDeviceClient } from 'agent-device';
import { startAgentDevice } from 'agent-device/host';

const exec = promisify(execFile);
const cwd = process.cwd();
const beforeEnv = { ...process.env };
const listeners = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'];
const beforeListeners = listeners.map((event) => process.listeners(event));
const disposed = [];
const setups = [];
function fixture(provider) {
  return {
    apiVersion: 2,
    provider,
    credentials: { variables: [] },
    setup: (host) => {
      setups.push([provider, host.env.HOST_MARKER]);
      return {
        runtime: {
          provider,
          leaseLifecycle: {},
          ownsDevice: () => false,
          getInteractor: () => undefined,
          deviceInventoryProvider: () => ({ listDevices: async () => [] }),
          shutdown: async () => {
            disposed.push(`${provider}:shutdown`);
          },
        },
        platformModule: {
          owner: { kind: 'provider-runtime', provider, instance: provider },
          loadRuntime: async () => ({}),
        },
        dispose: () => {
          disposed.push(`${provider}:dispose`);
        },
      };
    },
  };
}
fs.mkdirSync(path.join(cwd, '.agent-device'), { recursive: true });
fs.writeFileSync(path.join(cwd, '.agent-device/config.json'), '{broken plugin store');
const supplied = {
  cwd,
  env: {
    HOME: cwd,
    PATH: process.env.PATH,
    HOST_MARKER: 'A',
    AGENT_DEVICE_DAEMON_BASE_URL: 'http://127.0.0.1:9',
  },
};
const a = await startAgentDevice({
  stateDir: 'host-a',
  host: supplied,
  plugins: [
    fixture('fixture-a'),
    fixture('limrun'),
    {
      ...fixture('broken'),
      setup() {
        throw new Error('fixture setup failure');
      },
    },
  ],
});
const b = await startAgentDevice({
  stateDir: 'host-b',
  host: { cwd, env: { ...supplied.env, HOST_MARKER: 'B' } },
  plugins: [fixture('fixture-b')],
});
try {
  supplied.env.HOST_MARKER = 'mutated';
  assert.deepEqual(await a.client.sessions.list(), []);
  assert.deepEqual(await b.client.sessions.list(), []);
  assert.deepEqual(setups, [
    ['fixture-a', 'A'],
    ['fixture-b', 'B'],
  ]);
  assert.equal(a.plugins.find((p) => p.provider === 'fixture-a').state, 'active');
  assert.equal(
    a.plugins.filter((p) => p.provider === 'limrun' && p.source === 'embedder')[0].state,
    'failed',
  );
  assert.equal(a.plugins.find((p) => p.provider === 'broken').state, 'failed');
  assert.equal(process.cwd(), cwd);
  assert.deepEqual({ ...process.env }, beforeEnv);
  assert.deepEqual(
    listeners.map((event) => process.listeners(event)),
    beforeListeners,
  );
  const config = JSON.stringify(a.clientConfig);
  const child = await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createAgentDeviceClient } from 'agent-device'; console.log(JSON.stringify(await createAgentDeviceClient(${config}).sessions.list()));`,
    ],
    { cwd },
  );
  assert.deepEqual(JSON.parse(child.stdout), []);
  const cli = path.join(cwd, 'node_modules/agent-device/bin/agent-device.mjs');
  await assert.rejects(
    exec(
      process.execPath,
      [cli, 'daemon', 'stop', '--clean', '--state-dir', a.clientConfig.stateDir, '--json'],
      { cwd },
    ),
    (error) => {
      assert.equal(JSON.parse(error.stdout).error.details.reason, 'daemon-clean-not-detached');
      return true;
    },
  );
  assert.deepEqual(await a.client.sessions.list(), []);
  const stopped = await exec(
    process.execPath,
    [cli, 'daemon', 'stop', '--state-dir', a.clientConfig.stateDir, '--json'],
    { cwd },
  );
  assert.equal(JSON.parse(stopped.stdout).data.stopped, true);
  const [first, second, disposal] = await Promise.all([
    a.close(),
    a.close(),
    a[Symbol.asyncDispose](),
  ]);
  assert.strictEqual(first, second);
  assert.equal(disposal, undefined);
  assert.deepEqual(first.requests, { drained: 0, abandoned: 0 });
  assert.deepEqual(disposed, ['fixture-a:shutdown', 'fixture-a:dispose']);
  assert.deepEqual(await b.client.sessions.list(), []);
  const replacement = await startAgentDevice({
    stateDir: a.clientConfig.stateDir,
    host: { cwd, env: supplied.env },
  });
  try {
    await assert.rejects(
      createAgentDeviceClient(a.clientConfig).sessions.list(),
      (error) => error.details?.reason === 'daemon-binding-mismatch',
    );
    const wrongToken = createAgentDeviceClient({
      ...replacement.clientConfig,
      daemonBinding: { ...replacement.clientConfig.daemonBinding, token: 'wrong-token' },
    });
    await assert.rejects(
      wrongToken.sessions.list(),
      (error) => error.details?.reason === 'daemon-binding-mismatch',
    );
  } finally {
    await replacement.close();
  }
  console.log(
    JSON.stringify({
      attachedFromChild: true,
      cleanRefused: true,
      externalStop: true,
      siblingPreserved: true,
      replacementRefused: true,
      report: first,
    }),
  );
} finally {
  await a.close();
  await b.close();
}
assert.deepEqual(disposed, [
  'fixture-a:shutdown',
  'fixture-a:dispose',
  'fixture-b:shutdown',
  'fixture-b:dispose',
]);
assert.equal(fs.existsSync(path.join(cwd, 'host-a', 'daemon.json')), false);
