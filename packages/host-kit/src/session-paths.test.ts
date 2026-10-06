import { test } from 'vitest';
import assert from 'node:assert/strict';
// oxlint-disable-next-line no-restricted-imports -- asserts a path under os.homedir
import os from 'node:os';
import path from 'node:path';
import { expandSessionPath } from './session-paths.ts';

test('expandSessionPath resolves tilde, relative-with-cwd, and absolute paths', () => {
  const homePath = expandSessionPath('~/flows/replay.ad');
  assert.equal(homePath, path.join(os.homedir(), 'flows', 'replay.ad'));

  const relativePath = expandSessionPath('workflows/replay.ad', '/tmp/agent-device-cwd');
  assert.equal(relativePath, path.resolve('/tmp/agent-device-cwd', 'workflows/replay.ad'));

  const absoluteInput = path.resolve('/tmp', 'agent-device-absolute.ad');
  const absolutePath = expandSessionPath(absoluteInput, '/tmp/ignored-cwd');
  assert.equal(absolutePath, absoluteInput);
});
