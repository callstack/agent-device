// The suite universe, and which units of work no lane reaches.
//
// Ownership is tracked per TERMINAL rather than per suite, so an aggregate script whose parts
// are spread across five jobs (`check:tooling`) is not reported as unowned merely because no
// single job runs all of it.

import {
  execTarget,
  report,
  resolveScript,
  type ResolveContext,
  type Sink,
  type Terminal,
  type UnresolvedEdge,
} from './execution-terminals.ts';
import { OWNING_LANE_KINDS, type Lane } from './workflow-lanes.ts';

export type Suite = {
  /** `vitest:<project>` or the package script name. */
  readonly id: string;
  readonly kind: 'vitest-project' | 'package-script';
  readonly terminals: ReadonlySet<Terminal>;
  readonly unresolved: readonly UnresolvedEdge[];
};

/**
 * The suite universe, derived rather than listed: every Vitest project, plus every `test:*`
 * and `check:*` package script. Adding either without wiring it to a lane fails the gate.
 */
export function suiteUniverse(ctx: ResolveContext): Suite[] {
  const suites: Suite[] = ctx.vitestProjects.map((project) => ({
    id: `vitest:${project}`,
    kind: 'vitest-project' as const,
    terminals: new Set([`vitest:${project}`]),
    unresolved: [],
  }));
  for (const [name, command] of ctx.packageScripts) {
    // The `test:`/`check:` convention is the primary universe, but a naming convention does not
    // enforce itself: `maestro:conformance`, `mutation:test` and `fuzz:parsers` all run real
    // gates in real lanes under other names, and were invisible here. Membership is therefore
    // decided by what a script RUNS, not what it is called, so the universe cannot be dodged —
    // by accident or otherwise — by naming a gate something else.
    if (!/^(?:test|check):/.test(name) && !runsGate(name, command, ctx)) continue;
    suites.push(packageScriptSuite(name, command, ctx));
  }
  return suites.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Whether a script reaches a gate. Probed WITHOUT reporting, because most scripts here are
 * ordinary (`build`, `dev`) and resolve to nothing — reporting during the probe would file every
 * one of them as an unresolved edge.
 *
 * Two ways to qualify, because "runs a test runner" is not the same question as "is a gate".
 * A Vitest or `node --test` terminal proves itself. A gate that drives its OWN runner does not:
 * `fuzz:parsers` and `mutation:run` are `exec:` terminals indistinguishable from `build`'s by
 * shape, so the executables behind them are declared (GATE_RUNNERS) rather than guessed at.
 */
function runsGate(name: string, command: string, ctx: ResolveContext): boolean {
  const probe: Sink = {
    terminals: new Set(),
    unresolved: [],
    source: `package.json#${name}`,
    step: name,
  };
  resolveScript(name, command, ctx, probe);
  return [...probe.terminals].some(
    (terminal) =>
      terminal.startsWith('vitest:') ||
      terminal.startsWith('node-test:') ||
      isDeclaredGateRunner(terminal, ctx),
  );
}

/**
 * Whether a terminal runs a declared gate executable, matched on the executable rather than the
 * whole terminal so one declaration governs every script that runs it: `mutation:run`,
 * `mutation:check` and `mutation:affected` differ only in flags.
 */
function isDeclaredGateRunner(terminal: Terminal, ctx: ResolveContext): boolean {
  const target = execTarget(terminal);
  return target !== null && ctx.gateRunners.has(target);
}

export function packageScriptSuite(name: string, command: string, ctx: ResolveContext): Suite {
  const sink: Sink = {
    terminals: new Set(),
    unresolved: [],
    source: `package.json#${name}`,
    step: name,
  };
  resolveScript(name, command, ctx, sink);
  if (sink.terminals.size === 0 && sink.unresolved.length === 0) {
    report(sink, 'no-terminal', `script "${name}" resolves to no unit of work`);
  }
  return {
    id: name,
    kind: 'package-script',
    terminals: sink.terminals,
    unresolved: sink.unresolved,
  };
}

export type UnownedTerminal = {
  readonly terminal: Terminal;
  /** Which suites need it — named so the failure says what stops being checked. */
  readonly suites: readonly string[];
};

/**
 * Terminals some suite needs that no QUALIFYING lane reaches.
 *
 * Two rules are doing work here. Ownership is per terminal rather than per suite, so an
 * aggregate script (`check:tooling`, whose parts are spread across five jobs) is not reported
 * as unowned merely because no single job runs all of it. And only PR-triggered and scheduled
 * lanes count (OWNING_LANE_KINDS): a suite reachable only from a release, push-to-main, or
 * manually-dispatched workflow is NOT gating anything on the way in, so #1429 requires it to
 * be wired or classified local-only rather than quietly credited to that lane.
 *
 * The filter lives here rather than at the call site so a caller cannot re-introduce the hole
 * by passing every lane it happens to have.
 */
export function unownedTerminals(
  suites: readonly Suite[],
  lanes: readonly Lane[],
  waived: ReadonlySet<Terminal>,
): UnownedTerminal[] {
  const owned = new Set<Terminal>();
  for (const lane of lanes) {
    if (!OWNING_LANE_KINDS.has(lane.kind)) continue;
    for (const terminal of lane.terminals) owned.add(terminal);
  }

  const needed = new Map<Terminal, string[]>();
  for (const suite of suites) {
    for (const terminal of suite.terminals) {
      if (owned.has(terminal) || waived.has(terminal)) continue;
      const holders = needed.get(terminal) ?? [];
      holders.push(suite.id);
      needed.set(terminal, holders);
    }
  }
  return [...needed]
    .map(([terminal, holders]) => ({ terminal, suites: holders.sort() }))
    .sort((left, right) => left.terminal.localeCompare(right.terminal));
}
