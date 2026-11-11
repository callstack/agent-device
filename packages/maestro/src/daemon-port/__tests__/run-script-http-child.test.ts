import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { runCmdSync } from '@agent-device/host-kit/command';

test.each(['canonical', 'directory-symlink'])(
  'the HTTP child reports malformed input through a %s path',
  (kind) => {
    const childPath = fileURLToPath(new URL('../run-script-http-child.ts', import.meta.url));
    let entryPath = childPath;
    if (kind === 'directory-symlink') {
      const alias = path.join(mkdtempForTestSync('run-script-http-child-'), 'entry');
      fs.symlinkSync(path.dirname(childPath), alias, 'junction');
      entryPath = path.join(alias, path.basename(childPath));
    }
    const result = runCmdSync(process.execPath, ['--experimental-strip-types', entryPath], {
      stdin: '{',
      allowFailure: true,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /SyntaxError/);
  },
);
