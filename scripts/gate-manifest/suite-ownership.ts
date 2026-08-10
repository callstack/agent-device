// The suite universe, and which units of work no lane reaches.
//
// Ownership is tracked per TERMINAL rather than per suite, so an aggregate script whose parts
// are spread across five jobs (`check:tooling`) is not reported as unowned merely because no
// single job runs all of it.

import {
  report,
  resolveScript,
  type ResolveContext,
  type Sink,
  type Terminal,
  type UnresolvedEdge,
} from './execution-terminals.ts';
import type { Lane } from './workflow-lanes.ts';

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
    if (!/^(?:test|check):/.test(name)) continue;
    suites.push(packageScriptSuite(name, command, ctx));
  }
  return suites.sort((left, right) => left.id.localeCompare(right.id));
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
 * Terminals some suite needs that no lane reaches. Ownership is per terminal rather than per
 * suite so an aggregate script (`check:tooling`, whose parts are spread across five jobs)
 * cannot report as unowned merely because no single job runs all of it.
 */
export function unownedTerminals(
  suites: readonly Suite[],
  lanes: readonly Lane[],
  waived: ReadonlySet<Terminal>,
): UnownedTerminal[] {
  const owned = new Set<Terminal>();
  for (const lane of lanes) for (const terminal of lane.terminals) owned.add(terminal);

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
