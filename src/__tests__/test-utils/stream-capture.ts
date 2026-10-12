/**
 * Fakes for tests that drive stdout/stderr behavior: capturing what a stream's `write` receives
 * and toggling `isTTY` on a real process stream. Every fake restores exactly what it changed — in
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
   * true and `CI` is unset until `restore()`. Used to exercise TTY-gated stderr rendering.
   */
  interactive?: boolean;
  /**
   * Silently drop captured writes instead of recording them, for tool processes that must keep
   * a stream quiet for their whole life and never read what was swallowed. Takes precedence
   * over `passthroughBufferWrites`: a discarded stream stays quiet for every write.
   */
  discard?: boolean;
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
  return captureStream(process.stderr, options);
}

/** Captures `process.stdout.write` until `restore()`. The primitive the stdout scoped forms use. */
export function beginStdoutCapture(options: StreamCaptureOptions = {}): StreamCapture {
  return captureStream(process.stdout, options);
}

function captureStream(stream: NodeJS.WriteStream, options: StreamCaptureOptions): StreamCapture {
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
    // Discard means "keep this stream quiet", so it wins over passthrough when both are set.
    if (options.discard) {
      return true;
    }
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
 * `interactive: true` to also fake an attached terminal (isTTY set, CI unset) for the duration,
 * which is how TTY-gated stderr renderers are exercised.
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

/** Async form of {@link withCapturedStderr}. */
export async function withCapturedStderrAsync(
  run: () => Promise<unknown>,
  options: StreamCaptureOptions = {},
): Promise<string> {
  const capture = beginStderrCapture(options);
  try {
    await run();
  } finally {
    capture.restore();
  }
  return capture.read();
}

/** Async form of {@link beginStdoutCapture} scoped to one run. */
export async function withCapturedStdoutAsync(
  run: () => Promise<unknown>,
  options: StreamCaptureOptions = {},
): Promise<string> {
  const capture = beginStdoutCapture(options);
  try {
    await run();
  } finally {
    capture.restore();
  }
  return capture.read();
}

/** Runs `run` with both process output streams captured. */
export async function withCapturedOutput(
  run: () => Promise<unknown>,
): Promise<{ stdout: string; stderr: string }> {
  const stdout = beginStdoutCapture();
  const stderr = beginStderrCapture();
  try {
    await run();
  } finally {
    stderr.restore();
    stdout.restore();
  }
  return { stdout: stdout.read(), stderr: stderr.read() };
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
