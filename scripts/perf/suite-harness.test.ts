import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { test, vi } from 'vitest';
import type { PerfConfig } from './config.ts';
import type { PlatformStep } from './suite.ts';

// Stands in for the CLI: records each teardown call, and whether the logs were already saved,
// then appends to the daemon log and fails like a teardown that went wrong.
const FAKE_CLI = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
const command = args[0] === 'daemon' ? 'daemon stop' : args[0];
const saved = fs.existsSync(process.env.PERF_FAKE_SAVED_LOG);
fs.appendFileSync(process.env.PERF_FAKE_CALLS, command + ' saved=' + saved + '\\n');
fs.appendFileSync(stateDir + '/daemon.log', command + '\\n');
process.exit(1);
`;

test('finalizing a run saves the logs before and after a failing teardown, once', async () => {
  const root = mkdtempForTestSync('perf-finalize-');
  const fakeCli = path.join(root, 'fake-cli.mjs');
  fs.writeFileSync(fakeCli, FAKE_CLI);
  const stateDir = path.join(root, 'state');
  const rawDir = path.join(root, 'out', 'raw');
  fs.mkdirSync(path.join(stateDir, 'sessions', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'daemon.log'), 'suite\n');
  fs.writeFileSync(path.join(stateDir, 'sessions', 'perf', 'runner.log'), 'runner\n');
  fs.writeFileSync(path.join(stateDir, 'daemon.json'), '{"token":"secret"}');
  const calls = path.join(root, 'calls.log');
  vi.stubEnv('AGENT_DEVICE_PERF_CLI', fakeCli);
  vi.stubEnv('PERF_FAKE_CALLS', calls);
  vi.stubEnv('PERF_FAKE_SAVED_LOG', path.join(rawDir, 'state', 'daemon.log'));
  // The CLI command is read when the harness loads, so load it after the stub.
  const { runFinalizer } = await import('./suite-harness.ts');

  const finalize = runFinalizer(
    {
      platform: 'ios',
      stateDir,
      device: 'sim',
      appId: 'app',
      artifactsDir: path.join(rawDir, 'artifacts'),
      rawDir,
    },
    false,
  );
  finalize();
  // The interrupt handler and the normal finish both call it; the second call does nothing.
  finalize();

  assert.equal(fs.readFileSync(calls, 'utf8'), 'close saved=true\ndaemon stop saved=true\n');
  const saved = path.join(rawDir, 'state');
  assert.equal(
    fs.readFileSync(path.join(saved, 'daemon.log'), 'utf8'),
    'suite\nclose\ndaemon stop\n',
  );
  assert.equal(
    fs.readFileSync(path.join(saved, 'sessions', 'perf', 'runner.log'), 'utf8'),
    'runner\n',
  );
  assert.equal(fs.existsSync(path.join(saved, 'daemon.json')), false);
  assert.equal(fs.existsSync(stateDir), false);
});

// Stands in for the CLI and its daemon: records each call with the session variable it saw, and
// answers a snapshot with the transport that variable selects.
const FAKE_DAEMON_CLI = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const command = args.slice(0, args.indexOf('--state-dir')).join(' ');
const session = process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION ?? 'default';
fs.appendFileSync(process.env.PERF_FAKE_CALLS, command + ' session=' + session + '\\n');
if (process.env.PERF_FAKE_FAIL_RESTORE && command === 'open app --serial emulator-5554' && session === 'default') {
  process.stdout.write(JSON.stringify({ success: false, error: { code: 'DEVICE_IN_USE', message: 'claimed' } }));
  process.exit(1);
}
const transport = session === '0' ? 'instrumentation' : 'persistent-session';
const data = args[0] === 'snapshot'
  ? { nodes: [{ depth: 0 }], androidSnapshot: { helperTransport: transport } }
  : {};
process.stdout.write(JSON.stringify({ success: true, data }));
`;

const ONE_SHOT: PlatformStep = {
  id: 'one-shot',
  command: 'snapshot',
  args: ['snapshot', '--raw'],
  daemonEnv: { AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION: '0' },
  expect: { transport: 'instrumentation' },
};

async function runFakeDaemonSuite(steps: PlatformStep[]) {
  const root = mkdtempForTestSync('perf-daemon-env-');
  const fakeCli = path.join(root, 'fake-cli.mjs');
  fs.writeFileSync(fakeCli, FAKE_DAEMON_CLI);
  const calls = path.join(root, 'calls.log');
  vi.stubEnv('AGENT_DEVICE_PERF_CLI', fakeCli);
  vi.stubEnv('PERF_FAKE_CALLS', calls);
  vi.resetModules();
  const { runSuite } = await import('./suite-harness.ts');
  const measurements = await runSuite(
    {
      platform: 'android',
      stateDir: path.join(root, 'state'),
      device: 'emulator-5554',
      appId: 'app',
      artifactsDir: path.join(root, 'artifacts'),
      rawDir: path.join(root, 'raw'),
    },
    { warmup: 0, rounds: 1 } as PerfConfig,
    [
      {
        id: 'heavy-feed',
        title: 'heavy feed',
        setup: [],
        steps,
      },
    ],
  );
  return { measurements, calls: fs.readFileSync(calls, 'utf8') };
}

test('a step with daemon variables runs against a restarted daemon and restores it after', async () => {
  const {
    measurements: [measurement],
    calls,
  } = await runFakeDaemonSuite([ONE_SHOT]);

  assert.equal(
    calls,
    [
      'open app --relaunch --serial emulator-5554 session=default',
      'daemon stop session=default',
      'open app --serial emulator-5554 session=0',
      'snapshot --raw --debug session=0',
      'daemon stop session=default',
      'open app --serial emulator-5554 session=default',
      '',
    ].join('\n'),
  );
  assert.equal(measurement!.failures, 0);
  assert.equal(measurement!.samples[0]!.snapshot?.transport, 'instrumentation');
});

test('a failed daemon restore skips the rest of the scenario as restore_failed', async () => {
  vi.stubEnv('PERF_FAKE_FAIL_RESTORE', '1');
  const { measurements } = await runFakeDaemonSuite([
    ONE_SHOT,
    { id: 'back', command: 'back', args: ['back'] },
  ]);
  assert.equal(measurements[0]!.failures, 0);
  assert.equal(measurements[1]!.samples[0]!.errorCode, 'restore_failed');
});
