import { pathToFileURL } from 'node:url';

/**
 * Run `main` as the process entrypoint, but only when `moduleUrl` (pass `import.meta.url`) is the
 * script node was actually invoked with — so importing the module for its exports never runs it.
 * Exits with `main`'s status and turns a throw into a `label`-prefixed non-zero exit. Keeps the
 * `import.meta.url === pathToFileURL(process.argv[1])` guard from being copy-pasted per script.
 */
function isEntrypoint(moduleUrl: string): boolean {
  return moduleUrl === pathToFileURL(process.argv[1] ?? '').href;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runAsMain(
  moduleUrl: string,
  label: string,
  main: (argv: string[]) => number,
): void {
  if (!isEntrypoint(moduleUrl)) return;
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error: unknown) {
    process.stderr.write(`${label}: ${messageOf(error)}\n`);
    process.exit(1);
  }
}
