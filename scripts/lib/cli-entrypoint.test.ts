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

test.each([0, 7])('closed output pipe preserves command exit code %s', async (exitCode) => {
  const source = [
    `import { runEntrypoint } from ${JSON.stringify(new URL('./cli-entrypoint.ts', import.meta.url).href)};`,
    'process.once("message", () => {',
    '  process.disconnect();',
    `  runEntrypoint("fixture", async () => { process.stdout.write("closed-consumer output"); return ${exitCode}; });`,
    '});',
    'process.send("ready");',
  ].join('\n');
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', source],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const ready = once(child, 'message');
  const outputClosed = once(child.stdout, 'close');
  child.stdout.destroy();
  await outputClosed;
  await ready;
  const exited = once(child, 'close');
  child.send('run');
  const [code, signal] = await exited;
  assert.equal(signal, null);
  assert.equal(code, exitCode);
  assert.equal(stderr, '');
});

test.each(
  ['EIO', 'ENOSPC', 'ERR_STREAM_DESTROYED'].flatMap((errorCode) =>
    [0, 7].map((exitCode) => ({ errorCode, exitCode })),
  ),
)(
  'unexpected output error is reported without losing command failure ($errorCode, code=$exitCode)',
  async ({ errorCode, exitCode }) => {
    const source = [
      `import { runEntrypoint } from ${JSON.stringify(new URL('./cli-entrypoint.ts', import.meta.url).href)};`,
      "import { Writable } from 'node:stream';",
      `const output = new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('fixture write failure'), { code: ${JSON.stringify(errorCode)} })); } });`,
      "Object.defineProperty(process, 'stdout', { value: output });",
      `runEntrypoint('fixture', async () => ${exitCode});`,
    ].join('\n');
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '--eval', source],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null);
    assert.equal(code, exitCode || 1);
    assert.equal(stderr, 'fixture: unable to flush stdout: fixture write failure\n');
  },
);

// A real pipe must stay unread: synthetic write callbacks cannot prove process termination under backpressure.
test.each([0, 7])(
  'a stalled output reader cannot keep a finished command alive (code=%s)',
  async (exitCode) => {
    const source = [
      `import { runEntrypoint } from ${JSON.stringify(new URL('./cli-entrypoint.ts', import.meta.url).href)};`,
      'setTimeout(() => process.exit(99), 3000);',
      'runEntrypoint("fixture", async () => {',
      "  process.stdout.write('o'.repeat(4 * 1024 * 1024));",
      '  process.send({ queuedBytes: process.stdout.writableLength });',
      `  return ${exitCode};`,
      '});',
    ].join('\n');
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '--eval', source],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const stderrEnded = once(child.stderr, 'end');
    const exited = once(child, 'exit');
    try {
      const [message] = await once(child, 'message');
      assert.ok(
        message.queuedBytes > 0,
        'the real producer must have queued output behind the unread pipe',
      );
      const [code, signal] = await exited;
      await stderrEnded;
      assert.equal(signal, null);
      assert.equal(
        code,
        exitCode || 1,
        'the flush deadline must win before the independent leak guard',
      );
      assert.equal(stderr, 'fixture: unable to flush stdout: output drain timed out\n');
    } finally {
      child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  },
);
