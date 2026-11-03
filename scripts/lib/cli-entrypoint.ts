function isClosedPipe(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED')
  );
}

// Shared bootstrap for script entrypoints: run `main`, exit on its code, and turn a
// thrown error into one prefixed line rather than a stack trace.
export function runEntrypoint(prefix: string, main: () => Promise<number>): void {
  const exitAfterOutput = async (code: number): Promise<never> => {
    const failures = await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) =>
          new Promise<boolean>((resolve) => {
            const finish = (error?: unknown): void => {
              resolve(error != null && !isClosedPipe(error));
            };
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
          }),
      ),
    );
    process.exit(code || (failures.some(Boolean) ? 1 : 0));
  };
  main().then(exitAfterOutput, (error: unknown) => {
    process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : error}\n`);
    return exitAfterOutput(1);
  });
}
