import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { expandUserHomePath, resolveUserPath } from './path-resolution.ts';

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
