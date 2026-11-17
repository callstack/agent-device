import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  childPath,
  expandUserHomePath,
  parentDirectoryPath,
  resolveDeviceClaimRoot,
  resolveUserConfigPath,
  resolveUserPath,
  withoutTrailingSeparators,
} from './path-resolution.ts';

test('withoutTrailingSeparators cuts a run of separators in linear time and keeps the root', () => {
  // The scan is an index walk from the end, so a long run costs its own length: this is the input a
  // polynomial regular expression would reconsider, and the reason the helper does not use one.
  const many = '/'.repeat(200_000);
  const started = process.hrtime.bigint();
  assert.equal(withoutTrailingSeparators(`${many}sessions${many}`), `${many}sessions`);
  assert.equal(withoutTrailingSeparators(`${many}${many}`), '/');
  assert.ok(
    Number(process.hrtime.bigint() - started) < 2_000_000_000,
    'cutting separators must not scan twice',
  );

  assert.equal(withoutTrailingSeparators('/'), '/');
  assert.equal(withoutTrailingSeparators('//'), '/');
  assert.equal(withoutTrailingSeparators('/tmp/state'), '/tmp/state');
  assert.equal(withoutTrailingSeparators('/tmp/state//'), '/tmp/state');
  assert.equal(withoutTrailingSeparators('state'), 'state');
});

test('parentDirectoryPath cuts the parent without normalizing a step the kernel still has to take', () => {
  assert.equal(parentDirectoryPath('/r/state/sessions'), '/r/state');
  assert.equal(parentDirectoryPath('/r/state/sessions/'), '/r/state');
  // The `..` survives: it is a step the kernel resolves against the directory physically stood in, and a
  // caller that folded it here would be shown a different directory than the one resolution arrives at.
  assert.equal(parentDirectoryPath('/r/alias/../state'), '/r/alias/..');
  assert.equal(parentDirectoryPath('/state'), '/');
  assert.equal(parentDirectoryPath('state'), undefined);
});

test('childPath appends a name where the directory stands, and does not fold a step away', () => {
  // `path.join` normalizes, and that is the divergence this exists to prevent: with `alias` a link to
  // `actual/x`, the kernel creates `alias/../state/sessions` under `actual/state/sessions`, while `join`
  // answers `state/sessions` beside the alias. A repair that judged one and a writer that used the other
  // would each be right about a different directory.
  assert.equal(childPath('/r/alias/../state', 'sessions'), '/r/alias/../state/sessions');
  assert.notEqual(childPath('/r/alias/../state', 'sessions'), '/r/state/sessions');
  assert.equal(childPath('/r/state/', 'sessions'), '/r/state/sessions');
  assert.equal(childPath('/r/state', 'a', 'b'), `/r/state/a${path.sep}b`);
});

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

test('a relative claims dir is refused instead of following the working directory', () => {
  assert.throws(
    () => resolveDeviceClaimRoot({ AGENT_DEVICE_CLAIMS_DIR: 'claims' }),
    (error: unknown) =>
      (error as { details?: { reason?: string } }).details?.reason === 'relative_claims_dir',
  );
});
