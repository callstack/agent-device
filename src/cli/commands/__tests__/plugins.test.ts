import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { runCli } from '../../../cli.ts';
import { pluginHome, selectPlugin } from '@agent-device/test-kit/plugin.fixtures';
import { parseRawArgs, usageForCommand } from '../../parser/args.ts';
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
  assert.match(help, /plugins list\|add/);
});
