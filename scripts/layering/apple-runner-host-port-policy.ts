// Catches: a runner module reaching `@agent-device/host-kit/*` directly instead of through the
//   Apple runner host port (`runner/host.ts`, bound in `core/runner-host.ts`) -- invisible to R13's
//   general platform-package import rule, which admits host-kit to every platform-apple file, and
//   invisible to typecheck, because the direct import and the port delegator have the same call
//   shape. `packages/platform-apple/src/runner/` sits in the eager import closure of seven Apple
//   facade entries (`app-lifecycle-facade.ts`, `app-resolution-facade.ts`, `doctor-facade.ts`,
//   `perf-facade.ts`, `physical-device-facade.ts`, `runner-operations-facade.ts`, `runner/index.ts`)
//   held at a fixed size by `scripts/__tests__/eager-closure-budgets.ts`: a direct host-kit value
//   import from a runner module adds every module on its own import path to all seven closures at
//   once.
// Evidence: #2423 measured a candidate direct `@agent-device/host-kit/command` import from
//   `runner-cache-metadata.ts` adding 5 modules to `runner/index.ts`'s closure (13 -> 18); the
//   review spent two rounds rediscovering the port requirement before the symbol was routed back
//   through `runner/host.ts`, which is the gap this rule closes.
// Cost: 141 LOC (61 rule + 80 test).
// Kill criterion: none enforced today; retire only by maintainer decision that the eager-closure
//   budgets no longer bind the runner subtree, or that the port itself is retired in favor of some
//   other seam that keeps the same property.

import { parseImports, type LayeringViolation } from './model.ts';

const RULE = 'R77 apple-runner-host-port';

/** Every file this rule polices, production and test alike -- the port has no test exception. */
export const RUNNER_SUBTREE = 'packages/platform-apple/src/runner/';

const HOST_KIT_PREFIX = '@agent-device/host-kit/';

function violation(file: string, line: number, spec: string): LayeringViolation {
  return {
    rule: RULE,
    file,
    line,
    message:
      `imports '${spec}' directly. Reach host-kit through the runner host port ` +
      `(runner/host.ts, bound in core/runner-host.ts); a direct import grows the Apple facade ` +
      `eager closures (eager-closure-budgets).`,
  };
}

/**
 * `runner/**` (every file, `host.ts` included -- it holds none today, and a value import there
 * would defeat the port it defines) may not VALUE-import `@agent-device/host-kit/*`. A type-only
 * import of the same specifier (an `import type` declaration, or a named `type` specifier) is
 * exempt everywhere: it evaluates nothing, so it cannot add a module to a closure the
 * eager-closure gate measures at runtime.
 */
export function appleRunnerHostPortViolations(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const [file, source] of sources) {
    if (!file.startsWith(RUNNER_SUBTREE)) continue;
    for (const site of parseImports(source)) {
      if (site.typeOnly) continue;
      if (!site.spec.startsWith(HOST_KIT_PREFIX)) continue;
      violations.push(violation(file, site.line, site.spec));
    }
  }
  return violations;
}
