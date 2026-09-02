// Catches: a session resource field (appLog, appLogFailure, audioProbe, perfCapture) written
//   from outside its declared owner module — R7's session-state-ownership shape applied to the
//   narrower set of per-resource fields these session-scoped runtimes carry, where the same
//   aliasing hazard (get()/set() hand back and re-put the live reference) applies.
// Evidence: 7b48531d3b (#2081) retired ADR-0019 cutover scaffolding this policy protected during
//   the runtime-command migration; 4454aef139 (#2092) removed what it retired.
// Cost: 115 LOC (57 rule + 58 test).
// Kill criterion: none enforced today; retire only by maintainer decision that per-owner write
//   authority over appLog/appLogFailure/audioProbe/perfCapture no longer matters. The fields
//   are plain mutable properties on the shared session record, so an outside write type-checks.

import { parseSync } from 'oxc-parser';
import { propertyName, visitAst } from './layering-ast.ts';
import type { LayeringViolation } from './model.ts';

type AstNode = Record<string, unknown>;

export const SESSION_RESOURCE_OWNERSHIP_RULE = 'R68 session-resource-ownership';

const RESOURCE_OWNERS: Readonly<Record<string, ReadonlySet<string>>> = {
  appLog: new Set(['src/daemon/app-log-session-resource.ts', 'src/daemon/types.ts']),
  appLogFailure: new Set(['src/daemon/app-log-session-resource.ts', 'src/daemon/types.ts']),
  audioProbe: new Set(['src/daemon/audio-probe-session-resource.ts', 'src/daemon/types.ts']),
  perfCapture: new Set(['src/daemon/perf-capture-session-resource.ts', 'src/daemon/types.ts']),
};

/** Durable session-resource records have one whole-record construction owner per domain. */
export function sessionResourceOwnershipViolations(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const [file, source] of sources) {
    if (!file.startsWith('src/daemon/')) continue;
    const program = parseSync(file, source).program as AstNode;
    visitAst(program, (node) => {
      if (node['type'] !== 'Property' || node['kind'] !== 'init' || node['computed'] === true) {
        return;
      }
      const field = propertyName(node['key']);
      if (field === undefined) return;
      const owners = RESOURCE_OWNERS[field];
      if (
        owners === undefined ||
        owners.has(file) ||
        isTeardownDiscriminant(field, node['value'])
      ) {
        return;
      }
      const offset = typeof node['start'] === 'number' ? node['start'] : 0;
      violations.push({
        rule: SESSION_RESOURCE_OWNERSHIP_RULE,
        file,
        line: source.slice(0, offset).split('\n').length,
        message: `session ${field} record constructed outside its owner`,
      });
    });
  }
  return violations;
}

function isTeardownDiscriminant(field: string, valueNode: unknown): boolean {
  if (field !== 'appLog' || valueNode === null || typeof valueNode !== 'object') return false;
  const value = valueNode as AstNode;
  return (
    value['type'] === 'Literal' &&
    (value['value'] === 'run' || value['value'] === 'already-settled')
  );
}
