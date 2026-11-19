// R87: hand-rolled deadline races, counted per package. `Promise.race(work, sleep(timeout))`
// and its setTimeout twin are the same pattern: a timer racing work, and the timer is only safe
// while someone remembers to clear it on every settle path. The one deadline primitive belongs to
// host-kit (`settleWithin` in `@agent-device/host-kit/retry`, next to Deadline/sleep/
// pollUntilSettled) and clears its own timer on every path, so a new race site must not appear.
//
// Catches: a new `Promise.race(` in production source — a per-site deadline race that can leak
// its timer when the work side settles or rejects on a path the author did not clear. Races that
// are not deadlines (an abort racing work, two futures racing each other) are legitimate; this
// rule counts only the literal call, and the owner's review decides which kind a site is.
// Evidence: the daemon carried five hand-rolled deadline races (#4357 fixed one class at an
// owner with settleWithinBudget; the settleWithin migration removed the rest), and the count
// ratchet keeps them from coming back per package.
// Cost: 63 LOC rule + 90 LOC test, plus the shared merge-base measurement in ratchet-reference.ts.
// Kill criterion: none enforced today; retire only by maintainer decision that hand-rolled races
// no longer matter. Reaching zero remaining races does not retire it: at zero the ratchet is
// what keeps the count from regrowing, and nothing else flags a new `Promise.race(`.

import type { LayeringViolation } from './model.ts';

const RULE = 'R87 promise-race-ratchet';

const RACE_CALL = 'Promise.race(';

/**
 * The package a production source file belongs to: `packages/<name>` for workspace packages, the
 * root `src` tree for the CLI itself. One key per package, so a count cannot hide by moving a
 * race between files inside the same package.
 */
export function packageOf(file: string): string {
  const match = /^packages\/([^/]+)\//.exec(file);
  return match ? `packages/${match[1]}` : (file.split('/', 1)[0] ?? file);
}

/** `Promise.race(` occurrences per package over the given production sources, keys sorted. */
export function countPromiseRaces(sources: ReadonlyMap<string, string>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const [file, source] of sources) {
    const occurrences = source.split(RACE_CALL).length - 1;
    if (occurrences === 0) continue;
    const pkg = packageOf(file);
    counts.set(pkg, (counts.get(pkg) ?? 0) + occurrences);
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
  const violations: LayeringViolation[] = [];
  for (const [pkg, count] of Object.entries(counts)) {
    const allowed = reference[pkg] ?? 0;
    if (count <= allowed) continue;
    const carrier = [...sources]
      .filter(([file, source]) => packageOf(file) === pkg && source.includes(RACE_CALL))
      .sort(([left], [right]) => left.localeCompare(right))[0]!;
    const [carrierFile, carrierSource] = carrier;
    const line = carrierSource.slice(0, carrierSource.indexOf(RACE_CALL)).split('\n').length;
    violations.push({
      rule: RULE,
      file: carrierFile,
      line,
      message:
        `${RACE_CALL} count in ${pkg} grew to ${count} (baseline ${allowed} at the merge-base). ` +
        `Deadline races belong to settleWithin (@agent-device/host-kit/retry), which clears its own ` +
        `timer on every settle path; the count may only shrink.`,
    });
  }
  return violations;
}
