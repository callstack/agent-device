// R88: hand-rolled deadline races, counted per package. `Promise.race(work, sleep(timeout))`
// and its setTimeout twin are the same pattern: a timer racing work, and the timer is only safe
// while someone remembers to clear it on every settle path. The one deadline primitive belongs to
// host-kit (`settleWithin` in `@agent-device/host-kit/retry`, next to Deadline/sleep/
// pollUntilSettled) and clears its own timer on every path, so a new race site must not appear.
//
// Catches: a new `Promise.race(...)` call in production source — a per-site deadline race that can
// leak its timer when the work side settles or rejects on a path the author did not clear. Calls
// are counted as CallExpression nodes with the shared layering parser (layering-ast.ts), so a
// comment or string mentioning the literal, or extra spacing, cannot move the count. Races that
// are not deadlines (an abort racing work, two futures racing each other) are legitimate; the
// owner's review decides which kind a site is.
// Evidence: the daemon carried five hand-rolled deadline races (#4357 fixed one class at an
// owner with settleWithinBudget; the settleWithin migration removed the rest), and the count
// ratchet keeps them from coming back per package.
// Cost: 116 LOC rule + 84 LOC test, plus the shared merge-base measurement in ratchet-reference.ts.
// Kill criterion: none enforced today; retire only by maintainer decision that hand-rolled races
// no longer matter. Reaching zero remaining races does not retire it: at zero the ratchet is
// what keeps the count from regrowing, and nothing else flags a new `Promise.race(...)` call.

import { parseSync } from 'oxc-parser';
import { memberPath, visitAst } from './layering-ast.ts';
import type { LayeringViolation } from './model.ts';

const RULE = 'R88 promise-race-ratchet';

/** One `Promise.race(...)` call site in a production source file. */
export type PromiseRaceCall = Readonly<{ file: string; line: number }>;

// Programs memoized by source text: the ratchet measures both the working tree and the merge-base
// through the same reader, and a file byte-identical at both ends is parsed once (the same
// memoization the import parser in model.ts uses).
const programsBySource = new Map<string, unknown>();

function programFor(source: string): unknown {
  let program = programsBySource.get(source);
  if (!program) {
    const parsed = parseSync('promise-race-ratchet.ts', source, { sourceType: 'module' });
    if (parsed.errors.length > 0) {
      throw new SyntaxError(
        `Cannot parse for Promise.race count: ${parsed.errors.map(({ message }) => message).join('; ')}`,
      );
    }
    program = parsed.program;
    programsBySource.set(source, program);
  }
  return program;
}

/**
 * The package a production source file belongs to: `packages/<name>` for workspace packages, the
 * root `src` tree for the CLI itself. One key per package, so a count cannot hide by moving a
 * race between files inside the same package.
 */
export function packageOf(file: string): string {
  const match = /^packages\/([^/]+)\//.exec(file);
  return match ? `packages/${match[1]}` : (file.split('/', 1)[0] ?? file);
}

/** Every `Promise.race(...)` call in the given production sources, sorted by file then line. */
export function findPromiseRaceCalls(sources: ReadonlyMap<string, string>): PromiseRaceCall[] {
  const calls: PromiseRaceCall[] = [];
  for (const [file, source] of sources) {
    visitAst(programFor(source), (node) => {
      if (node.type !== 'CallExpression') return;
      const path = memberPath(node.callee);
      if (!path || path.length !== 2 || path[0] !== 'Promise' || path[1] !== 'race') return;
      const start = typeof node.start === 'number' ? node.start : 0;
      calls.push({ file, line: source.slice(0, start).split('\n').length });
    });
  }
  return calls.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

/** `Promise.race(...)` call counts per package over the given production sources, keys sorted. */
export function countPromiseRaces(sources: ReadonlyMap<string, string>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const call of findPromiseRaceCalls(sources)) {
    const pkg = packageOf(call.file);
    counts.set(pkg, (counts.get(pkg) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * The ratchet: each package's head count must sit at or under its merge-base count. A package the
 * base did not have may carry none, a shrink needs no edit, and no change can bank headroom by
 * recording a number above the tree — the reference is the same measurement over the merge-base
 * (ratchet-reference.ts).
 */
export function checkPromiseRaceCounts(
  sources: ReadonlyMap<string, string>,
  reference: Readonly<Record<string, number>>,
): LayeringViolation[] {
  const counts = countPromiseRaces(sources);
  const calls = findPromiseRaceCalls(sources);
  const violations: LayeringViolation[] = [];
  for (const [pkg, count] of Object.entries(counts)) {
    const allowed = reference[pkg] ?? 0;
    if (count <= allowed) continue;
    const carrier = calls.find((call) => packageOf(call.file) === pkg)!;
    violations.push({
      rule: RULE,
      file: carrier.file,
      line: carrier.line,
      message:
        `Promise.race(...) calls in ${pkg} grew to ${count} (baseline ${allowed} at the ` +
        `merge-base). Deadline races belong to settleWithin (@agent-device/host-kit/retry), which ` +
        `clears its own timer on every settle path; the count may only shrink.`,
    });
  }
  return violations;
}
