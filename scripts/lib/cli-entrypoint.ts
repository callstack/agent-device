const OUTPUT_DRAIN_TIMEOUT_MS = 2000;

function isClosedPipe(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPIPE';
}

function drainOutput(stream: NodeJS.WriteStream, deadline: number): Promise<unknown> {
  return new Promise((resolve) => {
    const finish = (error?: unknown): void => {
      clearTimeout(timer);
      const cause = stream.errored ?? error;
      resolve(cause != null && !isClosedPipe(cause) ? cause : undefined);
    };
    const timer = setTimeout(
      () => finish(new Error('output drain timed out')),
      Math.max(0, deadline - Date.now()),
    );
    if (stream.destroyed || !stream.writable) {
      finish(stream.errored);
      return;
    }
    stream.once('error', finish);
    try {
      stream.write('', finish);
    } catch (error) {
      finish(error);
    }
  });
}

// Shared bootstrap for script entrypoints. Output failure fails a successful command; a closed
// pipe preserves its code. Primary output has a hard deadline, even for a slow reader.
// A failure diagnostic gets one separate bounded drain window.
export function runEntrypoint(prefix: string, main: () => Promise<number>): void {
  // Node retains the cause on stream.errored; early writes must survive until the drain classifies it.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => undefined);
  const exitAfterOutput = async (code: number): Promise<never> => {
    const deadline = Date.now() + OUTPUT_DRAIN_TIMEOUT_MS;
    const [stdoutError, initialStderrError] = await Promise.all([
      drainOutput(process.stdout, deadline),
      drainOutput(process.stderr, deadline),
    ]);
    let stderrError = initialStderrError;
    if (stdoutError != null && stderrError == null) {
      const message = stdoutError instanceof Error ? stdoutError.message : String(stdoutError);
      try {
        process.stderr.write(`${prefix}: unable to flush stdout: ${message}\n`);
        stderrError = await drainOutput(process.stderr, Date.now() + OUTPUT_DRAIN_TIMEOUT_MS);
      } catch (error) {
        stderrError = error;
      }
    }
    process.exit(code || (stdoutError != null || stderrError != null ? 1 : 0));
  };
  main().then(exitAfterOutput, (error: unknown) => {
    process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : error}\n`);
    return exitAfterOutput(1);
  });
}
