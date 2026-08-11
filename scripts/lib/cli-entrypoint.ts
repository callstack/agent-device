// Shared bootstrap for script entrypoints: run `main`, exit on its code, and turn a
// thrown error into one prefixed line rather than a stack trace.

export function runEntrypoint(prefix: string, main: () => Promise<number>): void {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : error}\n`);
      process.exit(1);
    },
  );
}
