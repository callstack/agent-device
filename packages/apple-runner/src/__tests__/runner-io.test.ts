import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  createRunnerLogFile,
  readRunnerLogTail,
  tailRunnerLogFile,
  type RunnerLogFile,
} from '../runner-io.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

function logPathIn(prefix = 'runner-log-tail-'): string {
  return path.join(mkdtempForTestSync(prefix), 'runner.log');
}

function handleAtEndOf(logPath: string): RunnerLogFile {
  return { logPath, startOffset: fs.statSync(logPath).size };
}

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) throw lastError;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('the tail starts where the handle says its generation starts', async () => {
  const logPath = logPathIn();
  fs.writeFileSync(logPath, 'previous generation output\n');
  const chunks: string[] = [];
  const tail = tailRunnerLogFile({
    file: handleAtEndOf(logPath),
    onOutput: (chunk) => chunks.push(chunk),
  });

  fs.appendFileSync(logPath, 'this generation\n');
  await waitFor(() => assert.equal(chunks.join(''), 'this generation\n'));

  tail.stop();
});

test('the tail follows a file its writer keeps appending to', async () => {
  const logPath = logPathIn();
  const chunks: string[] = [];
  const tail = tailRunnerLogFile({
    file: { logPath, startOffset: 0 },
    onOutput: (chunk) => chunks.push(chunk),
  });

  fs.appendFileSync(logPath, 'one\n');
  await waitFor(() => assert.match(chunks.join(''), /one/));
  fs.appendFileSync(logPath, 'two\n');
  await waitFor(() => assert.match(chunks.join(''), /two/));

  tail.stop();
  const seenAfterStop = chunks.join('');
  fs.appendFileSync(logPath, 'three\n');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(chunks.join(''), seenAfterStop);
});

test('a tail whose file disappears stops on its own instead of throwing', async () => {
  const logPath = logPathIn();
  fs.writeFileSync(logPath, '');
  const chunks: string[] = [];
  const tail = tailRunnerLogFile({
    file: { logPath, startOffset: 0 },
    onOutput: (chunk) => chunks.push(chunk),
  });
  fs.rmSync(logPath);

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(chunks, []);

  // Writing a fresh file must not restart a tail that already gave up.
  fs.writeFileSync(logPath, 'AGENT_DEVICE_RUNNER_LISTENER_READY\n');
  await new Promise((resolve) => setTimeout(resolve, 120));
  tail.drain();
  assert.deepEqual(chunks, []);
});

test('drain reads what the file gained and then stops following it', async () => {
  const logPath = logPathIn();
  const chunks: string[] = [];
  const tail = tailRunnerLogFile({
    file: { logPath, startOffset: 0 },
    onOutput: (chunk) => chunks.push(chunk),
  });

  fs.appendFileSync(logPath, 'tail bytes\n');
  tail.drain();

  assert.equal(chunks.join(''), 'tail bytes\n');
});

test('the log tail an error can quote is the end of the file, bounded', () => {
  const logPath = logPathIn();
  fs.writeFileSync(logPath, `${'x'.repeat(500)}SIGNATURE-TEXT`);

  assert.equal(
    readRunnerLogTail({ logPath, startOffset: 0 }, 64),
    `${'x'.repeat(50)}SIGNATURE-TEXT`,
  );
  assert.equal(
    readRunnerLogTail({ logPath, startOffset: 0 }, 4_096).endsWith('SIGNATURE-TEXT'),
    true,
  );
  assert.equal(readRunnerLogTail(undefined, 64), '');
  assert.equal(readRunnerLogTail({ logPath: `${logPath}.missing`, startOffset: 0 }, 64), '');
});

test('a quoted tail never reaches back before its own generation', () => {
  // The file is append-only across runner generations: an older generation's failure text sitting
  // under this one's bytes would otherwise be quoted as this launch's output (#2681).
  const logPath = logPathIn();
  fs.writeFileSync(logPath, 'Boot failure of an older runner generation\n');
  const file = handleAtEndOf(logPath);

  fs.appendFileSync(logPath, 'this generation said hello\n');

  assert.equal(readRunnerLogTail(file, 4_096), 'this generation said hello\n');
});

test('a generation that has written nothing yet has no tail to quote', () => {
  const logPath = logPathIn();
  fs.writeFileSync(logPath, 'older generation\n');

  assert.equal(readRunnerLogTail(handleAtEndOf(logPath), 4_096), '');
});

test('createRunnerLogFile records where the append descriptor sits', () => {
  const logPath = logPathIn();
  fs.writeFileSync(logPath, 'older generation\n');
  const fd = fs.openSync(logPath, 'a');
  try {
    assert.equal(createRunnerLogFile(logPath, fd).startOffset, 'older generation\n'.length);
  } finally {
    fs.closeSync(fd);
  }

  assert.equal(createRunnerLogFile(logPath, fd).startOffset, 0);
});
