import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'vitest';

test('loads the executable spike entrypoint', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/ios-ax-bridge-spike/run.ts', '--help'],
    { encoding: 'utf8' },
  );

  assert.match(output, /Usage: pnpm bench:ios-ax-bridge/);
});
