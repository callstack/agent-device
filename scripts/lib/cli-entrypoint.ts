const OUTPUT_DRAIN_TIMEOUT_MS = 2000;

function isClosedPipe(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPIPE';
}

function outputFailure(stream: NodeJS.WriteStream, error?: unknown): unknown {
  const cause = stream.errored ?? error;
  return cause != null && !isClosedPipe(cause) ? cause : undefined;
}

class OutputDeadlineExceeded extends Error {
  constructor() {
    super('output drain timed out');
  }
}

/**
 * The one owner of output completion: settles with the stream's failure once what was written to it
 * has flushed, or with `OutputDeadlineExceeded` at `deadline`.
 */
function settleOutput(stream: NodeJS.WriteStream, deadline: number): Promise<unknown> {
  return new Promise((resolve) => {
    const finish = (error?: unknown): void => {
      clearTimeout(timer);
      stream.off('error', finish);
      resolve(outputFailure(stream, error));
    };
    const timer = setTimeout(
      () => finish(new OutputDeadlineExceeded()),
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
// pipe preserves its code. Primary output and the stdout-failure diagnostic each settle by a deadline.
// A pending write holds the process even while main is pending, and Node cannot close stdio, so a
// diagnostic still unflushed at its deadline exits with the failure it reports.
export function runEntrypoint(prefix: string, main: () => Promise<number>): void {
  let mainSettled = false;
  // A pending main promise does not keep Node alive; retain early failures for natural exit.
  const retainOutputFailure = (error: unknown): void => {
    if (!isClosedPipe(error) && !Number(process.exitCode)) process.exitCode = 1;
  };
  let diagnostic: Promise<unknown> | undefined;
  const reportStdoutFailure = (error: unknown): void => {
    if (
      diagnostic ||
      process.stderr.destroyed ||
      !process.stderr.writable ||
      process.stderr.errored != null
    )
      return;
    const message = error instanceof Error ? error.message : String(error);
    try {
      process.stderr.write(`${prefix}: unable to flush stdout: ${message}\n`);
    } catch (error) {
      retainOutputFailure(error);
    }
    diagnostic = settleOutput(process.stderr, Date.now() + OUTPUT_DRAIN_TIMEOUT_MS);
    void diagnostic.then((failure) => {
      if (!mainSettled && failure instanceof OutputDeadlineExceeded) {
        process.exit(Number(process.exitCode) || 1);
      }
    });
  };
  process.stderr.on('error', retainOutputFailure);
  process.stdout.on('error', (error: unknown) => {
    retainOutputFailure(error);
    if (!isClosedPipe(error)) reportStdoutFailure(error);
  });
  const exitAfterOutput = async (code: number): Promise<never> => {
    mainSettled = true;
    const deadline = Date.now() + OUTPUT_DRAIN_TIMEOUT_MS;
    const [initialStdoutError, initialStderrError] = await Promise.all([
      settleOutput(process.stdout, deadline),
      settleOutput(process.stderr, deadline),
    ]);
    const stdoutError = initialStdoutError ?? outputFailure(process.stdout);
    let stderrError = initialStderrError ?? outputFailure(process.stderr);
    if (stdoutError != null && stderrError == null) {
      reportStdoutFailure(stdoutError);
      stderrError = await diagnostic;
    }
    process.exit(code || (stdoutError != null || stderrError != null ? 1 : 0));
  };
  main().then(exitAfterOutput, (error: unknown) => {
    process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : error}\n`);
    return exitAfterOutput(1);
  });
}
