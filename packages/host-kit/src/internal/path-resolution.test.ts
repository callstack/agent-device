import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { expandUserHomePath, resolveUserConfigPath, resolveUserPath } from './path-resolution.ts';

test('expandUserHomePath expands the current user home prefix', () => {
  const env = { HOME: '/tmp/agent-device-home' };

  assert.equal(expandUserHomePath('~', { env }), '/tmp/agent-device-home');
  assert.equal(
    expandUserHomePath('~/flows/replay.ad', { env }),
    path.join('/tmp/agent-device-home', 'flows', 'replay.ad'),
  );
});

test('resolveUserPath expands home-prefixed and absolute paths', () => {
  const env = { HOME: '/tmp/agent-device-home' };
  const absolutePath = '/tmp/agent-device-absolute.ad';

  assert.equal(
    resolveUserPath('~/flows/replay.ad', { cwd: '/tmp/ignored', env }),
    path.join('/tmp/agent-device-home', 'flows', 'replay.ad'),
  );
  assert.equal(resolveUserPath(absolutePath, { cwd: '/tmp/ignored', env }), absolutePath);
});

// The plugin store and the CLI config loader both need this answer, so it is owned here rather
// than behind either of them; these are the three shapes both consumers depend on.
test('resolveUserConfigPath resolves the home, the relocated home, and rejects a relative one', () => {
  assert.equal(
    resolveUserConfigPath({ HOME: '/tmp/agent-device-home' }),
    path.join('/tmp/agent-device-home', '.agent-device', 'config.json'),
  );
  // `~/...` expands through this same env object, so HOME is pinned here too: omitting it would
  // let the expectation drift to `os.homedir()` while the expansion went elsewhere.
  assert.equal(
    resolveUserConfigPath({ HOME: '/tmp/agent-device-home', AGENT_DEVICE_HOME: '~/relocated' }),
    path.join('/tmp/agent-device-home', 'relocated', 'config.json'),
  );
  assert.throws(() => resolveUserConfigPath({ AGENT_DEVICE_HOME: './relative' }), {
    code: 'INVALID_ARGS',
  });
});
