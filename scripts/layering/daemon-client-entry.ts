import type { LayeringViolation, ResolvedImportEdge } from './model.ts';

// The declared daemon-entry surface for the client (#2559). `src/daemon-client/**` composes the
// daemon over the network, not over its module graph, so it is NOT an entry point into daemon
// internals: the process root composition is. Every on-disk or protocol contract the client shares
// with the daemon (state-dir/transport resolution, pidfile liveness, the repair tombstone, the
// progress framing) therefore lives at the process root, not under `src/daemon/`, and the client
// reaches it there. What remains is the client reading the daemon's request/response vocabulary —
// the `DaemonRequest`/`DaemonResponse` types that anchor the ADR 0006 wire surface — recorded here,
// per measured `file -> target` edge, and only as a type-only import. A runtime (value or dynamic)
// import of a
// daemon module by the client is always a violation, an undeclared type import is a violation, and
// a recorded edge that no longer exists is stale; all three fail, so the set cannot grow, and a
// repair cannot leave a stale entry that would let the edge back in unnoticed.

export const DAEMON_CLIENT_ENTRY_RULE = 'R78 daemon-client-entry';

const REQUEST_RATIONALE =
  'the client names the request and response it sends and reads across the socket — the same ' +
  'DaemonRequest/DaemonResponse vocabulary that anchors the ADR 0006 wire surface and is gated by ' +
  'test/wire-compat. Reading it as a type is unavoidable and closes the wire surface; a value import ' +
  'would drag the daemon-private request half (#2318/#2322) into the client.';

export type DaemonClientEntryEdge = Readonly<{
  file: string;
  target: string;
  rationale: string;
}>;

/**
 * The residual client→daemon imports, every one of them a type-only read of the canonical
 * DaemonRequest/DaemonResponse vocabulary. It names measured edges, never a directory, so a new
 * client module reaching the daemon — even for the same type — fails until it is recorded here.
 */
export const DAEMON_CLIENT_ENTRY_EDGES: readonly DaemonClientEntryEdge[] = [
  {
    file: 'src/daemon-client/daemon-client.ts',
    target: 'src/daemon/daemon-request.ts',
    rationale: REQUEST_RATIONALE,
  },
  {
    file: 'src/daemon-client/daemon-client-lifecycle.ts',
    target: 'src/daemon/daemon-request.ts',
    rationale: REQUEST_RATIONALE,
  },
  {
    file: 'src/daemon-client/daemon-client-lease-beat.ts',
    target: 'src/daemon/daemon-request.ts',
    rationale: REQUEST_RATIONALE,
  },
  {
    file: 'src/daemon-client/daemon-client-progress.ts',
    target: 'src/daemon/daemon-request.ts',
    rationale: REQUEST_RATIONALE,
  },
  {
    file: 'src/daemon-client/daemon-client-rpc.ts',
    target: 'src/daemon/daemon-request.ts',
    rationale: REQUEST_RATIONALE,
  },
  {
    file: 'src/daemon-client/daemon-client-transport.ts',
    target: 'src/daemon/daemon-request.ts',
    rationale: REQUEST_RATIONALE,
  },
] as const;

function keyOf(file: string, target: string): string {
  return `${file} -> ${target}`;
}

type MeasuredEdge = { file: string; target: string; line: number; runtimeKind: string | null };

/**
 * Catches: the client reaching daemon internals again — a runtime import of any daemon module, or a
 *   new type-only import that was not measured and recorded. The runtime half is the regression this
 *   gate exists for: #2559 relocated the shared contracts to the process root specifically so the
 *   client stops value-importing `config.ts`, `daemon-process.ts`, `session-repair-tombstone.ts`,
 *   and `request-progress-protocol.ts`. The mirror failure — a recorded edge whose import is gone —
 *   is caught too, so a repair cannot leave the door open.
 * Evidence: #2559 measured 13 client→daemon pairs (8 runtime) at the #2557 tip; the runtime half is
 *   now 0 and the 5 wire-only type edges are the residue recorded above.
 * Cost: one rule registered in check.ts's whole-graph pass; not a standalone CI job.
 * Kill criterion: the client reaches the daemon only through its network protocol (the inventory
 *   empty), or a maintainer decision that the client may compose daemon internals directly.
 */
export function checkDaemonClientEntry(edges: readonly ResolvedImportEdge[]): LayeringViolation[] {
  const measured = new Map<string, MeasuredEdge>();
  for (const edge of edges) {
    if (!edge.file.startsWith('src/daemon-client/')) continue;
    if (!edge.target.startsWith('src/daemon/')) continue;
    const key = keyOf(edge.file, edge.target);
    const entry = measured.get(key) ?? {
      file: edge.file,
      target: edge.target,
      line: edge.line,
      runtimeKind: null,
    };
    if (entry.runtimeKind === null && !edge.typeOnly) {
      entry.runtimeKind = edge.dynamic ? 'dynamic-imports' : 'value-imports';
    }
    measured.set(key, entry);
  }

  const declared = new Set(DAEMON_CLIENT_ENTRY_EDGES.map((edge) => keyOf(edge.file, edge.target)));
  const violations: LayeringViolation[] = [];
  const seen = new Set<string>();

  for (const [key, entry] of measured) {
    if (entry.runtimeKind !== null) {
      violations.push({
        rule: DAEMON_CLIENT_ENTRY_RULE,
        file: entry.file,
        line: entry.line,
        message:
          `the daemon client ${entry.runtimeKind} daemon internals: ${key}. The client composes the ` +
          `daemon over the network, not its module graph. Move the shared contract to the process ` +
          `root (or read the DaemonRequest/DaemonResponse types in src/daemon/daemon-request.ts as a type).`,
      });
      seen.add(key);
      continue;
    }
    if (!declared.has(key)) {
      violations.push({
        rule: DAEMON_CLIENT_ENTRY_RULE,
        file: entry.file,
        line: entry.line,
        message:
          `unclassified daemon-client import of daemon internals: ${key}. If the client legitimately ` +
          `reads a request/response type, record the measured edge in DAEMON_CLIENT_ENTRY_EDGES ` +
          `(${DAEMON_CLIENT_ENTRY_RULE}) with its rationale; otherwise reach the shared root contract.`,
      });
    }
    seen.add(key);
  }

  for (const edge of DAEMON_CLIENT_ENTRY_EDGES) {
    const key = keyOf(edge.file, edge.target);
    if (seen.has(key)) continue;
    violations.push({
      rule: DAEMON_CLIENT_ENTRY_RULE,
      file: 'scripts/layering/daemon-client-entry.ts',
      line: 1,
      message:
        `stale declared edge: ${key} no longer exists. Remove it from DAEMON_CLIENT_ENTRY_EDGES so ` +
        `the client dependency cannot return unclassified.`,
    });
  }

  return violations;
}
