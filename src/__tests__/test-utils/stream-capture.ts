/**
 * Fakes for tests that drive stderr behavior: capturing what a stream's `write` receives and
 * toggling `isTTY` on a real process stream. Every fake restores exactly what it changed — in
 * particular, a property the stream inherited from the Writable/Socket prototype is restored by
 * deleting the test's own property, never by assignment, so no shadow survives the test.
 */

export type StreamCapture = {
  read(): string;
  restore(): void;
};

export type StreamCaptureOptions = {
  /**
   * Forward Buffer chunks to the real stream (some CLI paths need raw binary writes) instead of
   * only recording them, matching the pre-helper `runCliCapture` behavior.
   */
  passthroughBufferWrites?: boolean;
  /**
   * Pretend the stream is attached to an interactive terminal while capturing: `isTTY` reads
   * true and `CI` is unset until `restore()`.
   */
  interactive?: boolean;
};

function restoreInheritedProperty(
  stream: NodeJS.WriteStream,
  key: 'write' | 'isTTY',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(stream, key, descriptor);
    return;
  }
  // Absent before the capture: the stream inherited this property, so leave no own shadow behind.
  delete (stream as unknown as Record<string, unknown>)[key];
}

/** Captures `process.stderr.write` until `restore()`. The primitive the scoped forms derive from. */
export function beginStderrCapture(options: StreamCaptureOptions = {}): StreamCapture {
  const stream = process.stderr;
  const mutableStream = stream as unknown as Record<string, unknown>;
  const writeDescriptor = Object.getOwnPropertyDescriptor(stream, 'write');
  const originalWrite = stream.write;
  const isTTYDescriptor = options.interactive
    ? Object.getOwnPropertyDescriptor(stream, 'isTTY')
    : undefined;
  const originalCi = options.interactive ? process.env.CI : undefined;
  let output = '';
  if (options.interactive) {
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
    delete process.env.CI;
  }
  mutableStream.write = (chunk: unknown, ...args: unknown[]) => {
    if (options.passthroughBufferWrites && Buffer.isBuffer(chunk)) {
      // Call with the stream as receiver: Writable.prototype.write reads `this._writableState`.
      return (
        originalWrite as (this: NodeJS.WriteStream, c: unknown, ...a: unknown[]) => boolean
      ).call(stream, chunk, ...args);
    }
    output += String(chunk);
    return true;
  };
  return {
    read: () => output,
    restore: () => {
      restoreInheritedProperty(stream, 'write', writeDescriptor);
      if (options.interactive) {
        if (originalCi === undefined) delete process.env.CI;
        else process.env.CI = originalCi;
        restoreInheritedProperty(stream, 'isTTY', isTTYDescriptor);
      }
    },
  };
}

/**
 * Runs `run` with `process.stderr.write` captured and returns everything it received. Pass
 * `interactive: true` to also fake an attached terminal (isTTY set, CI unset) for the duration.
 */
export function withCapturedStderr(run: () => void, options: StreamCaptureOptions = {}): string {
  const capture = beginStderrCapture(options);
  try {
    run();
  } finally {
    capture.restore();
  }
  return capture.read();
}

/**
 * Scoped capture through an interactive terminal: `process.stderr` reports `isTTY`, `CI` is
 * unset, and everything `process.stderr.write` receives is captured and returned.
 */
export function withInteractiveStderr(run: () => void): string {
  return withCapturedStderr(run, { interactive: true });
}

/** Toggles `isTTY` on a real process stream for the duration of `run`, then restores it. */
export function withStreamTty<T>(stream: NodeJS.WriteStream, isTTY: boolean, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  Object.defineProperty(stream, 'isTTY', { configurable: true, value: isTTY });
  try {
    return run();
  } finally {
    restoreInheritedProperty(stream, 'isTTY', descriptor);
  }
}
