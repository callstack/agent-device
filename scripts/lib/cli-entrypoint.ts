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
  // A pending main promise does not keep Node alive; retain early failures for natural exit.
  const retainOutputFailure = (error: unknown): void => {
    if (!isClosedPipe(error) && !Number(process.exitCode)) process.exitCode = 1;
  };
  let stdoutDiagnosticAttempted = false;
  const reportStdoutFailure = (error: unknown): void => {
    if (
      stdoutDiagnosticAttempted ||
      process.stderr.destroyed ||
      !process.stderr.writable ||
      process.stderr.errored != null
    )
      return;
    stdoutDiagnosticAttempted = true;
    const message = error instanceof Error ? error.message : String(error);
    try {
      process.stderr.write(`${prefix}: unable to flush stdout: ${message}\n`);
    } catch (error) {
      retainOutputFailure(error);
    }
  };
  process.stderr.on('error', retainOutputFailure);
  process.stdout.on('error', (error: unknown) => {
    retainOutputFailure(error);
    if (!isClosedPipe(error)) reportStdoutFailure(error);
  });
  const exitAfterOutput = async (code: number): Promise<never> => {
    const deadline = Date.now() + OUTPUT_DRAIN_TIMEOUT_MS;
    const [stdoutError, initialStderrError] = await Promise.all([
      drainOutput(process.stdout, deadline),
      drainOutput(process.stderr, deadline),
    ]);
    let stderrError = initialStderrError;
    if (stdoutError != null && stderrError == null) {
      reportStdoutFailure(stdoutError);
      stderrError = await drainOutput(process.stderr, Date.now() + OUTPUT_DRAIN_TIMEOUT_MS);
    }
    process.exit(code || (stdoutError != null || stderrError != null ? 1 : 0));
  };
  main().then(exitAfterOutput, (error: unknown) => {
    process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : error}\n`);
    return exitAfterOutput(1);
  });
}
