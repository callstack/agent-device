import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  beginStderrCapture,
  withCapturedStderr,
  withCapturedStderrAsync,
  withCapturedOutput,
  withStreamTty,
} from './stream-capture.ts';

function hasOwnWrite(stream: NodeJS.WriteStream): boolean {
  return Object.prototype.hasOwnProperty.call(stream, 'write');
}

test('withCapturedStderr restores an inherited write without leaving an own property', () => {
  const writeBefore = Object.getOwnPropertyDescriptor(process.stderr, 'write');
  const captured = withCapturedStderr(() => {
    process.stderr.write('into the capture\n');
  });
  assert.equal(captured, 'into the capture\n');
  assert.deepEqual(Object.getOwnPropertyDescriptor(process.stderr, 'write'), writeBefore);
});

test('withCapturedStderr puts back a pre-existing own-property write', () => {
  const stream = process.stderr as unknown as Record<string, unknown>;
  const originalWrite = Object.getOwnPropertyDescriptor(process.stderr, 'write');
  let sentinelHits = 0;
  stream.write = () => {
    sentinelHits += 1;
    return true;
  };
  try {
    withCapturedStderr(() => {
      process.stderr.write('captured\n');
    });
    assert.equal(hasOwnWrite(process.stderr), true);
    process.stderr.write('sentinel\n');
    assert.equal(sentinelHits, 1, 'the pre-capture own write must be the live one again');
  } finally {
    if (originalWrite) Object.defineProperty(process.stderr, 'write', originalWrite);
    else delete stream.write;
  }
});

test('passthroughBufferWrites forwards Buffers to the real stream with the stream as receiver', () => {
  const capture = beginStderrCapture({ passthroughBufferWrites: true });
  try {
    // An empty Buffer reaches the real Writable.write without emitting output; called
    // unbound it throws while reading `this._writableState`.
    assert.equal(process.stderr.write(Buffer.alloc(0)), true);
  } finally {
    capture.restore();
  }
});

test('discard keeps the stream quiet even with passthroughBufferWrites enabled', () => {
  const stream = process.stderr as unknown as Record<string, unknown>;
  const originalWrite = Object.getOwnPropertyDescriptor(process.stderr, 'write');
  let realWrites = 0;
  stream.write = () => {
    realWrites += 1;
    return true;
  };
  try {
    const capture = beginStderrCapture({ passthroughBufferWrites: true, discard: true });
    try {
      assert.equal(process.stderr.write(Buffer.from('quiet')), true);
      assert.equal(process.stderr.write('quiet too\n'), true);
      assert.equal(capture.read(), '');
    } finally {
      capture.restore();
    }
    // With discard winning, nothing reached the sentinel during the capture window —
    // a passthrough-before-discard leak would have counted the Buffer there.
    assert.equal(realWrites, 0);
    process.stderr.write('now counted\n');
    assert.equal(realWrites, 1, 'the restored sentinel is the live write again');
  } finally {
    if (originalWrite) Object.defineProperty(process.stderr, 'write', originalWrite);
    else delete stream.write;
  }
});

test('interactive capture hides CI, marks the stream a TTY, and restores all three', () => {
  const originalCi = process.env.CI;
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  process.env.CI = '1';
  try {
    const captured = withCapturedStderr(
      () => {
        assert.equal(process.env.CI, undefined);
        assert.equal(process.stderr.isTTY, true);
        process.stderr.write('interactive line\n');
      },
      { interactive: true },
    );
    assert.equal(captured, 'interactive line\n');
    assert.equal(process.env.CI, '1');
    assert.deepEqual(Object.getOwnPropertyDescriptor(process.stderr, 'isTTY'), originalIsTTY);
    assert.deepEqual(Object.getOwnPropertyDescriptor(process.stderr, 'write'), undefined);
  } finally {
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  }
});

test('withStreamTty restores the original isTTY descriptor state', () => {
  const isTTYBefore = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const toggled = !isTTYBefore?.value;
  const sawToggled = withStreamTty(process.stdout, toggled, () => process.stdout.isTTY === toggled);
  assert.equal(sawToggled, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'), isTTYBefore);
});

test('the async and dual-stream forms restore both process streams to their own descriptors', async () => {
  const stderrBefore = Object.getOwnPropertyDescriptor(process.stderr, 'write');
  const stdoutBefore = Object.getOwnPropertyDescriptor(process.stdout, 'write');
  const stderr = await withCapturedStderrAsync(async () => {
    await Promise.resolve();
    process.stderr.write('async line\n');
  });
  assert.equal(stderr, 'async line\n');
  const both = await withCapturedOutput(async () => {
    process.stdout.write('out\n');
    process.stderr.write('err\n');
  });
  assert.deepEqual(both, { stdout: 'out\n', stderr: 'err\n' });
  assert.deepEqual(Object.getOwnPropertyDescriptor(process.stderr, 'write'), stderrBefore);
  assert.deepEqual(Object.getOwnPropertyDescriptor(process.stdout, 'write'), stdoutBefore);
});
