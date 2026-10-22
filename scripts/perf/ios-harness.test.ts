import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { test, vi } from 'vitest';

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
  const { iosRunFinalizer } = await import('./ios-harness.ts');

  const finalize = iosRunFinalizer(
    { stateDir, udid: 'sim', appId: 'app', artifactsDir: path.join(rawDir, 'artifacts'), rawDir },
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
