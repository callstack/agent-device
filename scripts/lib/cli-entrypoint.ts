// Shared bootstrap for script entrypoints: run `main`, exit on its code, and turn a
// thrown error into one prefixed line rather than a stack trace.

export function runEntrypoint(prefix: string, main: () => Promise<number>): void {
  const exitAfterOutput = async (code: number): Promise<never> => {
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) =>
          new Promise<void>((resolve) => {
            if (stream.destroyed || !stream.writable) {
              resolve();
              return;
            }
            stream.once('error', () => resolve());
            stream.write('', () => resolve());
          }),
      ),
    );
    process.exit(code);
  };
  main().then(exitAfterOutput, (error: unknown) => {
    process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : error}\n`);
    return exitAfterOutput(1);
  });
}
