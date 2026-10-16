import {
  CLIENT_SIDE_POLICY_NAME,
  LOGICAL_MODULE_POLICIES,
  matchesDeclaredRoot,
} from './architecture-ownership.ts';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';
import { staleReachModules, walkProcessReach } from './process-reach.ts';
import { DAEMON_SOURCE_ROOT } from './tracked-sources.ts';

export const DAEMON_CLIENT_ENTRY_RULE = 'R78 daemon-client-entry';

/** The modules a CLI process starts from. */
export const CLI_PROCESS_ENTRIES: readonly string[] = ['src/bin.ts', 'src/cli.ts'];

/**
 * Catches: any module the CLI process can load — over static and dynamic edges, so a root module
 *   the CLI lazy-loads counts — importing the daemon package. The folder ban on the client-side
 *   roots lives in `LOGICAL_MODULE_POLICIES` (R10) and covers direct edges, type-only included;
 *   this rule covers the hop outside those roots, where a root platform-runtime module could
 *   launder a daemon import into the CLI process. The violation names the chain from the entry.
 *   What the client shares with the daemon lives below both: `packages/daemon-contracts`,
 *   `DaemonWireRequest` in `@agent-device/contracts/command`, `DaemonResponse` in kernel.
 * Evidence: the folder ban alone left `device release --stale` loading the daemon reconciler
 *   through a root module one hop away.
 * Cost: one breadth-first walk over the resolved edges, inside check:layering.
 * Kill criterion: a maintainer decision that the CLI process may load daemon internals directly.
 */
export function checkDaemonClientEntry(
  sourceFiles: readonly string[],
  edges: readonly ResolvedImportEdge[],
  entries: readonly string[] = CLI_PROCESS_ENTRIES,
): LayeringViolation[] {
  const stale = staleReachModules(
    DAEMON_CLIENT_ENTRY_RULE,
    'scripts/layering/daemon-client-entry.ts',
    entries,
    sourceFiles,
    'CLI_PROCESS_ENTRIES',
  );
  if (stale.length > 0) return stale;
  const policy = LOGICAL_MODULE_POLICIES.find(({ name }) => name === CLIENT_SIDE_POLICY_NAME);
  const isPolicyCovered = (file: string) =>
    policy?.roots.some((root) => matchesDeclaredRoot(file, root)) ?? false;
  const walk = walkProcessReach(
    entries,
    edges.filter((edge) => !edge.file.startsWith(DAEMON_SOURCE_ROOT)),
    (edge) => edge.target.startsWith(DAEMON_SOURCE_ROOT),
  );
  return walk.stopped
    .filter((edge) => !isPolicyCovered(edge.file))
    .map((edge) => ({
      rule: DAEMON_CLIENT_ENTRY_RULE,
      file: edge.file,
      line: edge.line,
      message:
        `the CLI process reaches daemon internals: ${edge.file} imports ${edge.target}. ` +
        `Chain: ${[...walk.chainTo(edge.file), edge.target].join(' -> ')}.`,
    }));
}
