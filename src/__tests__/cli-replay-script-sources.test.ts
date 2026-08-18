/**
 * #1802, at the surface the reporter drives: a Linux CI runner with
 * `AGENT_DEVICE_DAEMON_BASE_URL` pointed at a remote daemon, and the `.ad` flows in the runner's
 * own checkout. The request the CLI puts on the wire must carry the script's CONTENT — a bare
 * path is a path on a filesystem the daemon cannot see.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import { runCliCapture } from './cli-capture.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

const REMOTE_DAEMON_ENV = {
  AGENT_DEVICE_DAEMON_BASE_URL: 'http://remote-mac.example.test:7777/agent-device',
  AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'remote-secret',
};

function makeFlowsCheckout(files: Record<string, string>): string {
  const root = mkdtempForTestSync('agent-device-cli-remote-replay-');
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
  }
  // The CLI reports its cwd as the resolved real path (macOS `/tmp` is a symlink), and that is
  // what the bundle's keys are built from.
  return fs.realpathSync(root);
}

test('replay against a remote daemon sends the script content, not just the path', async () => {
  const script = 'open "Demo"\nclick "Checkout"\n';
  const cwd = makeFlowsCheckout({ 'flows/login.ad': script });

  const result = await runCliCapture(['replay', './flows/login.ad', '--platform', 'ios'], {
    cwd,
    env: REMOTE_DAEMON_ENV,
    defaultResponse: { ok: true, data: { replayed: 2 } },
  });

  assert.equal(result.calls.length, 1);
  const request = result.calls[0];
  assert.equal(request?.command, 'replay');
  assert.deepEqual(request?.positionals, ['./flows/login.ad']);
  const bundle = request?.flags?.replayScriptSource as ReplayScriptSourceBundle | undefined;
  assert.equal(bundle?.entry, path.join(cwd, 'flows/login.ad'));
  assert.deepEqual(bundle?.files, { [path.join(cwd, 'flows/login.ad')]: script });
});

test('test against a remote daemon expands its inputs locally and sends every suite source', async () => {
  const first = 'open "First"\n';
  const second = 'open "Second"\n';
  const cwd = makeFlowsCheckout({ 'flows/01-first.ad': first, 'flows/02-second.ad': second });

  const result = await runCliCapture(['test', './flows'], {
    cwd,
    env: REMOTE_DAEMON_ENV,
    defaultResponse: { ok: true, data: { tests: [], total: 0, passed: 0, failed: 0 } },
  });

  assert.equal(result.calls.length, 1);
  const bundles = result.calls[0]?.flags?.replayScriptSources as
    | ReplayScriptSourceBundle[]
    | undefined;
  assert.deepEqual(bundles?.map((bundle) => path.basename(bundle.entry)).sort(), [
    '01-first.ad',
    '02-second.ad',
  ]);
  assert.deepEqual(
    bundles?.map((bundle) => bundle.files[bundle.entry]).sort(),
    [first, second].sort(),
  );
});

test('a Maestro replay against a remote daemon sends its runFlow includes too', async () => {
  const entry = 'appId: com.example.app\n---\n- runFlow: shared/login.yaml\n';
  const included = '---\n- back\n';
  const cwd = makeFlowsCheckout({
    'flows/checkout.yaml': entry,
    'flows/shared/login.yaml': included,
  });

  const result = await runCliCapture(
    ['replay', './flows/checkout.yaml', '--maestro', '--platform', 'ios'],
    { cwd, env: REMOTE_DAEMON_ENV, defaultResponse: { ok: true, data: { replayed: 1 } } },
  );

  const bundle = result.calls[0]?.flags?.replayScriptSource as ReplayScriptSourceBundle | undefined;
  assert.deepEqual(bundle?.files, {
    [path.join(cwd, 'flows/checkout.yaml')]: entry,
    [path.join(cwd, 'flows/shared/login.yaml')]: included,
  });
});
