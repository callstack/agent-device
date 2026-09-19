// Catches: a file under src/commands/ (outside commands/schema/) importing back into
//   commands/schema/ — the render-the-facets direction #2543 declared (cli-schema reads
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

const COMMANDS_SCHEMA_ROOT = 'src/commands/schema/';
const COMMANDS_ROOT = 'src/commands/';

export function checkCommandsSchemaBoundary(
  edges: readonly ResolvedImportEdge[],
): LayeringViolation[] {
  return edges
    .filter(
      (edge) =>
        matchesDeclaredRoot(edge.file, COMMANDS_ROOT) &&
        !matchesDeclaredRoot(edge.file, COMMANDS_SCHEMA_ROOT) &&
        matchesDeclaredRoot(edge.target, COMMANDS_SCHEMA_ROOT),
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
