// The Apple runner builds in Swift 5 language mode, where several off-main uses of main-actor state
// are only warnings: a `RunnerMainOwnedState` read inside a `DispatchQueue.async` closure, or a
// `@MainActor` closure called from one (#2882). `scripts/build-xcuitest-apple.sh` runs this scan
// over the `xcodebuild build-for-testing` log, so any actor-isolation diagnostic fails the
// swift-runner gates whatever its severity. Other warnings stay out of scope: the base already
// carries unrelated ones, so treating every warning as an error would fail it.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A compiler diagnostic line: `<file>:<line>:<column>: warning|error: <message>`. */
const SWIFT_DIAGNOSTIC_LINE = /^\S.*:\d+:\d+: (?:warning|error): /;
/**
 * The stable phrases of the Swift 5 isolation diagnostics: "main actor-isolated property …",
 * "call to main actor-isolated … [#ActorIsolatedCall]", and "converting function value … loses
 * global actor 'MainActor'".
 */
const ISOLATION_PHRASES = ['actor-isolated', 'loses global actor'];

/** Every distinct actor-isolation diagnostic line in `log`, in first-seen order. */
export function actorIsolationDiagnostics(log: string): string[] {
  const found = new Set<string>();
  for (const line of log.split(/\r?\n/)) {
    if (
      SWIFT_DIAGNOSTIC_LINE.test(line) &&
      ISOLATION_PHRASES.some((phrase) => line.includes(phrase))
    ) {
      found.add(line);
    }
  }
  return [...found];
}

function main(): number {
  const [logPath] = process.argv.slice(2);
  if (!logPath) {
    process.stderr.write('Usage: runner-isolation-diagnostics.ts <xcodebuild-log>\n');
    return 2;
  }
  const diagnostics = actorIsolationDiagnostics(fs.readFileSync(logPath, 'utf8'));
  if (diagnostics.length === 0) return 0;
  process.stderr.write(`${diagnostics.join('\n')}\n`);
  process.stderr.write(
    `runner isolation scan: ${diagnostics.length} actor-isolation diagnostic(s). Off-main code ` +
      'reads target identity from a SnapshotCaptureTarget taken on main and writes main-owned ' +
      'state through applyMainOwnedSnapshotState; it never names a RunnerMainOwnedState member or ' +
      'calls a @MainActor closure.\n',
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
