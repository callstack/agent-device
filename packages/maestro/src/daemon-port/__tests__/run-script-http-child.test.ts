import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { runCmdSync } from '@agent-device/host-kit/command';
import { runScriptHttpChild } from '../run-script-http-child.ts';

test('the packaged HTTP child reports malformed input', () => {
  assert.equal(typeof runScriptHttpChild, 'function');
  const childPath = fileURLToPath(new URL('../run-script-http-child.ts', import.meta.url));
  const result = runCmdSync(process.execPath, ['--experimental-strip-types', childPath], {
    stdin: '{',
    allowFailure: true,
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /SyntaxError/);
});
