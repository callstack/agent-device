// Catches: a `using`/`await using` declaration landing in source-checkout TypeScript that Node's
//   type stripper runs directly — syntax tsc accepts and type-checks fine, but that the
//   source-execution path (no build step) cannot run, so the failure would otherwise surface
//   only at runtime, on whichever command path first hits the file.
// Evidence: 7b48531d3b (#2081) retired ADR-0019 cutover scaffolding alongside this policy;
//   4454aef139 (#2092) removed the retired migration scaffolding it depended on.
// Cost: 57 LOC (31 rule + 26 test).
// Kill criterion: none enforced today (tsc accepts `using`; only running the file exposes it);
//   retire only by maintainer decision that source execution without a build step no longer
//   matters — moot once the Node floor in package.json engines runs `using`/`await using`
//   natively.

import { parseSync } from 'oxc-parser';
import { visitAst } from './layering-ast.ts';
import type { LayeringViolation } from './model.ts';

export const SOURCE_EXECUTION_COMPATIBILITY_RULE = 'R67 source-execution-compatibility';

/** Source-checkout TypeScript must remain executable by the repository's Node type stripper. */
export function sourceExecutionCompatibilityViolations(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const [file, source] of sources) {
    const program = parseSync(file, source).program as Record<string, unknown>;
    visitAst(program, (node) => {
      if (
        node['type'] !== 'VariableDeclaration' ||
        (node['kind'] !== 'using' && node['kind'] !== 'await using')
      ) {
        return;
      }
      const offset = typeof node['start'] === 'number' ? node['start'] : 0;
      violations.push({
        rule: SOURCE_EXECUTION_COMPATIBILITY_RULE,
        file,
        line: source.slice(0, offset).split('\n').length,
        message: `source-executed TypeScript uses unsupported ${String(node['kind'])} declaration`,
      });
    });
  }
  return violations;
}
