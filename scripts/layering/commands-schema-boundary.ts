// Catches: a file under src/commands/ or packages/command-surface/src/ (outside the matching
//   schema/ folder) importing back into that schema/ folder — the render-the-facets direction
//   #2543 declared (cli-schema reads
//   commands, commands never reads cli-schema back). #2679 folded the standalone cli-schema
//   zone into commands/schema/, so the two now share one zone and the ranked-spine / R2
//   zone-policy table can no longer see the edge at all: checkLayeringRules in check.ts skips
//   every same-zone edge before ZONE_POLICIES ever runs. This is the folder-scoped
//   replacement for that lost R2 row.
// Evidence: #2543 declared the direction as the second R2 commands-floor row in
//   zone-policy.ts; #2679 moved src/cli-schema/* into src/commands/schema/* and found the
//   direction unenforced on the merged tree.
// Cost: ~30 LOC (rule + test).
// Kill criterion: none enforced today; retire only by maintainer decision that commands/
//   reading its own schema layer back is fine, or that commands/schema/ should move out of
//   the commands zone entirely (at which point the ranked-spine R2 table can express the
//   direction again).

import { matchesDeclaredRoot } from './architecture-ownership.ts';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';

// The command layer lives in two trees: the declaration package and the root presentation. The
// package entry re-exports the schema layer by design, so it is the one file exempt from the rule.
const COMMAND_TREES = [
  { root: 'src/commands/', schemaRoot: 'src/commands/schema/', entry: undefined },
  {
    root: 'packages/command-surface/src/',
    schemaRoot: 'packages/command-surface/src/schema/',
    entry: 'packages/command-surface/src/index.ts',
  },
] as const;

export function checkCommandsSchemaBoundary(
  edges: readonly ResolvedImportEdge[],
): LayeringViolation[] {
  return edges
    .filter((edge) =>
      COMMAND_TREES.some(
        (tree) =>
          matchesDeclaredRoot(edge.file, tree.root) &&
          !matchesDeclaredRoot(edge.file, tree.schemaRoot) &&
          edge.file !== tree.entry &&
          matchesDeclaredRoot(edge.target, tree.schemaRoot),
      ),
    )
    .map((edge) => ({
      rule: 'R2 commands-floor',
      file: edge.file,
      line: edge.line,
      message:
        `${edge.file} must not import ${edge.target}: commands/schema/ is the CLI/MCP schema ` +
        'layer that renders the command facets, so it sits above the rest of commands/ and ' +
        'reads them; commands must not import it back (#2543). The shared CommandSchema type ' +
        'and flag grammar live in @agent-device/command-registry, below both.',
    }));
}
