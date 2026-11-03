import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'vitest';

test.each([false, true])('script exit flushes piped diagnostics (throws=%s)', async (throws) => {
  const bytes = 4 * 1024 * 1024;
  const stdoutTail = 'stdout diagnostic tail\n';
  const stderrTail = 'stderr diagnostic tail\n';
  const failure = 'fixture: expected failure\n';
  const source = [
    `import { runEntrypoint } from ${JSON.stringify(new URL('./cli-entrypoint.ts', import.meta.url).href)};`,
    'runEntrypoint("fixture", async () => {',
    `process.stdout.write('o'.repeat(${bytes}) + ${JSON.stringify(stdoutTail)});`,
    `process.stderr.write('e'.repeat(${bytes}) + ${JSON.stringify(stderrTail)});`,
    throws ? 'throw new Error("expected failure");' : 'return 7;',
    '});',
  ].join('\n');
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', source],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null);
  assert.equal(code, throws ? 1 : 7);
  assert.equal(stdout.length, bytes + stdoutTail.length);
  assert.ok(stdout.endsWith(stdoutTail));
  assert.equal(stderr.length, bytes + stderrTail.length + (throws ? failure.length : 0));
  assert.ok(stderr.endsWith(throws ? failure : stderrTail));
});
