// The Apple runner builds in Swift 5 language mode, where several off-main uses of main-actor state
// are only warnings: a `RunnerMainOwnedState` read inside a `DispatchQueue.async` closure, or a
// `@MainActor` closure called from one (#2882). `scripts/build-xcuitest-apple.sh` runs this scan
// over the `xcodebuild build-for-testing` log, so any concurrency diagnostic fails the
// swift-runner gates whatever its severity. Other warnings stay out of scope: the base already
// carries unrelated ones, so treating every warning as an error would fail it.
//
// The scan matches English prose where Swift prints no diagnostic group, so it carries a positive
// control: the build compiles `RunnerIsolationCanary.swift` with the runner's own flags, and the
// scan fails unless it saw a diagnostic on every canary line.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Repository-relative path of the positive-control source the runner gate builds compile. */
export const ISOLATION_CANARY_PATH =
  'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerIsolationCanary.swift';
const ISOLATION_CANARY_MARKER = '// isolation-canary';

/** A compiler diagnostic line: `<file>:<line>:<column>: warning|error: <message>`. */
const SWIFT_DIAGNOSTIC_LINE = /^(\S.*):(\d+):\d+: (?:warning|error): (.*)$/;
/**
 * Swift's concurrency diagnostics, by the diagnostic group it prints where it has one, and
 * otherwise by a phrase of the message: "main actor-isolated property … can not be referenced",
 * "converting function value … loses global actor 'MainActor'", "capture of … with non-Sendable
 * type", "mutation of captured var … in concurrently-executing code".
 */
const CONCURRENCY_DIAGNOSTIC_GROUPS = ['[#ActorIsolatedCall]', '[#SendableClosureCaptures]'];
const CONCURRENCY_DIAGNOSTIC_PHRASES = [
  'actor-isolated',
  'loses global actor',
  'non-sendable',
  'concurrently-executing code',
];

type ConcurrencyDiagnostic = { line: string; file: string; lineNumber: number };

function concurrencyDiagnostic(line: string): ConcurrencyDiagnostic | undefined {
  const match = SWIFT_DIAGNOSTIC_LINE.exec(line);
  if (!match) return undefined;
  const [, file = '', lineNumber = '', message = ''] = match;
  const lowerMessage = message.toLowerCase();
  const isConcurrency =
    CONCURRENCY_DIAGNOSTIC_GROUPS.some((group) => message.includes(group)) ||
    CONCURRENCY_DIAGNOSTIC_PHRASES.some((phrase) => lowerMessage.includes(phrase));
  return isConcurrency ? { line, file, lineNumber: Number(lineNumber) } : undefined;
}

/** The 1-based line numbers of `canarySource` that must each carry a concurrency diagnostic. */
export function isolationCanaryLines(canarySource: string): number[] {
  return canarySource
    .split(/\r?\n/)
    .flatMap((line, index) => (line.includes(ISOLATION_CANARY_MARKER) ? [index + 1] : []));
}

export type RunnerIsolationScan = {
  /** Every distinct concurrency diagnostic line outside the canary lines, in first-seen order. */
  violations: string[];
  /** Canary lines the log carried no concurrency diagnostic for. */
  missingCanaryLines: number[];
};

export function scanRunnerBuildLog(log: string, canarySource: string): RunnerIsolationScan {
  const expected = new Set(isolationCanaryLines(canarySource));
  const seenCanaryLines = new Set<number>();
  const violations = new Set<string>();
  for (const line of log.split(/\r?\n/)) {
    const diagnostic = concurrencyDiagnostic(line);
    if (!diagnostic) continue;
    const isCanaryLine =
      diagnostic.file.endsWith(`/${path.basename(ISOLATION_CANARY_PATH)}`) &&
      expected.has(diagnostic.lineNumber);
    if (isCanaryLine) {
      seenCanaryLines.add(diagnostic.lineNumber);
    } else {
      violations.add(diagnostic.line);
    }
  }
  return {
    violations: [...violations],
    missingCanaryLines: [...expected].filter((line) => !seenCanaryLines.has(line)),
  };
}

function main(): number {
  const [logPath] = process.argv.slice(2);
  if (!logPath) {
    process.stderr.write('Usage: runner-isolation-diagnostics.ts <xcodebuild-log>\n');
    return 2;
  }
  const canarySource = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', ISOLATION_CANARY_PATH),
    'utf8',
  );
  const { violations, missingCanaryLines } = scanRunnerBuildLog(
    fs.readFileSync(logPath, 'utf8'),
    canarySource,
  );
  if (violations.length > 0) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.stderr.write(
      `runner isolation scan: ${violations.length} concurrency diagnostic(s). Off-main code ` +
        'reads target identity from a SnapshotCaptureTarget taken on main and writes main-owned ' +
        'state through applyMainOwnedSnapshotState; it never names a RunnerMainOwnedState member or ' +
        'calls a @MainActor closure.\n',
    );
  }
  if (missingCanaryLines.length > 0) {
    process.stderr.write(
      `runner isolation scan: no concurrency diagnostic on ${ISOLATION_CANARY_PATH} line(s) ` +
        `${missingCanaryLines.join(', ')}. Either this build did not compile the canary, or the ` +
        'compiler words or groups that diagnostic differently: update the groups and phrases in ' +
        'scripts/runner-isolation-diagnostics.ts to match it.\n',
    );
  }
  return violations.length > 0 || missingCanaryLines.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
