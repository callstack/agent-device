import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { runCli } from '../../../cli.ts';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { pluginHome, selectPlugin } from '@agent-device/test-kit';
import { parseArgs, parseRawArgs, usageForCommand } from '../../parser/args.ts';
import { beginStdoutCapture } from '../../../__tests__/test-utils/stream-capture.ts';

vi.mock('../../../provider-device-runtimes.ts', () => {
  throw new Error('provider runtimes must remain unloaded');
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('plugins list and remove route through the CLI and emits JSON without daemon access or plugin evaluation', async () => {
  const { home } = pluginHome();
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', path.join(home, 'state'));
  vi.stubEnv('AGENT_DEVICE_NO_UPDATE_NOTIFIER', '1');
  const marker = path.join(home, 'evaluated');
  selectPlugin(
    home,
    'example',
    'example',
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'yes');`,
  );
  const sendToDaemon = vi.fn(async () => {
    throw new Error('unexpected daemon access');
  });
  const stdoutCapture = beginStdoutCapture();
  let stdout = '';
  try {
    await runCli(['plugins', 'list', '--json'], {
      sendToDaemon,
    });
    stdout = stdoutCapture.read();
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.deepEqual(result.data.plugins, [
      { name: 'example', version: '1.2.3', provider: 'example', compatible: true },
    ]);
    assert.equal(sendToDaemon.mock.calls.length, 0);
    await runCli(['plugins', 'remove', 'example', '--json'], { sendToDaemon });
    assert.deepEqual(JSON.parse(stdoutCapture.read().slice(stdout.length)).data.plugins, []);
    assert.ok(!fs.existsSync(marker));
  } finally {
    stdoutCapture.restore();
  }
});

test('plugin schema exposes operator help and preserves scoped npm package specs', async () => {
  const args = parseRawArgs(['plugins', 'add', '@example/provider@^1.0.0', '--json']);
  assert.equal(args.command, 'plugins');
  assert.deepEqual(args.positionals, ['add', '@example/provider@^1.0.0']);
  const help = await usageForCommand('plugins');
  assert.ok(help);
  assert.match(help, /plugins list \[--state-dir <path>\]\|add/);
});

test('plugins list reports the running daemon inventory next to the store selections', async () => {
  const { home } = pluginHome();
  const stateDir = path.join(home, 'state');
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  vi.stubEnv('AGENT_DEVICE_NO_UPDATE_NOTIFIER', '1');
  const owner = readCurrentOwnerIdentity();
  const failed = {
    provider: 'example',
    source: 'store',
    package: 'example',
    version: '1.2.3',
    state: 'failed',
    error: { code: 'INVALID_ARGS', message: 'bad plugin', reason: 'invalid_plugin' },
    credentials: { variables: [], byBackend: {} },
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'daemon.json'),
    JSON.stringify({
      token: 't',
      port: 1,
      pid: owner.pid,
      processStartTime: owner.startTime,
      plugins: [failed],
    }),
  );
  selectPlugin(home, 'example', 'example', 'export default () => {};');
  const stdoutCapture = beginStdoutCapture();
  try {
    await runCli(['plugins', 'list', '--json'], {
      sendToDaemon: vi.fn(async () => {
        throw new Error('unexpected daemon access');
      }),
    });
    const { data } = JSON.parse(stdoutCapture.read());
    assert.deepEqual(data.daemon, { pid: owner.pid, stateDir, plugins: [failed] });
    assert.equal(data.plugins[0].name, 'example');
  } finally {
    stdoutCapture.restore();
  }
});

test('--state-dir belongs to plugins list and daemon status, not to the commands that change the store', async () => {
  assert.equal(
    parseArgs(['plugins', 'list', '--state-dir', '/tmp/state']).flags.stateDir,
    '/tmp/state',
  );
  assert.throws(() => parseArgs(['plugins', 'add', 'example', '--state-dir', '/tmp/state']), {
    code: 'INVALID_ARGS',
  });
  assert.equal(
    parseArgs(['daemon', 'status', '--state-dir', '/tmp/state']).flags.stateDir,
    '/tmp/state',
  );
  assert.throws(() => parseArgs(['daemon', 'status', '--clean']), { code: 'INVALID_ARGS' });
  const help = await usageForCommand('daemon');
  assert.match(help ?? '', /daemon status \[--state-dir <path>\]/);
});
