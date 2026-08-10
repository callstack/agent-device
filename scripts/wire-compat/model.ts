/**
 * Does the daemon RPC wire surface's drift since the last RELEASED version
 * carry the justification ADR 0006 requires? (#1432)
 *
 * Pure comparison, no git and no filesystem, so the bump / ack / removal rules
 * are provable from fixtures instead of only from whatever the repository's
 * tags happen to contain today — the `scripts/<name>/{model,run}.ts` split
 * check-affected and coverage-changed already use.
 *
 * Division of labour with the unit lane: `test/wire-compat/wire-compat.test.ts`
 * ties the ledger to the SOURCE it describes (and to
 * `DAEMON_RPC_PROTOCOL_VERSION`), which is why nothing here re-checks that.
 * This model only ties one ledger to another.
 */

import type { WireLedger } from '../../test/wire-compat/ledger.ts';

export type WireComparisonInput = {
  /** Released tag the baseline ledger came from, for failure messages. */
  baselineTag: string;
  released: WireLedger;
  current: WireLedger;
  /** Digests recomputed from today's source, keyed `<file>#<name>`. */
  digests: ReadonlyMap<string, string>;
};

export type WireComparison = {
  /** Declarations whose digest moved since the baseline. */
  changed: readonly string[];
  /** Declarations the baseline had and the current wire surface does not. */
  removed: readonly string[];
  /** Declarations added since the baseline; additive, so never a failure. */
  added: readonly string[];
  /** Whether the protocol version advanced since the baseline. */
  bumped: boolean;
  /** Empty when the drift is justified. */
  failures: readonly string[];
};

export function compareWireLedgers(input: WireComparisonInput): WireComparison {
  const { baselineTag, released, current, digests } = input;
  const bumped = current.protocolVersion > released.protocolVersion;

  const changed: string[] = [];
  const removed: string[] = [];
  for (const [key, releasedDigest] of Object.entries(released.declarations)) {
    const digest = digests.get(key);
    if (digest === undefined) removed.push(key);
    else if (digest !== releasedDigest) changed.push(key);
  }
  const added = Object.keys(current.declarations).filter((key) => !(key in released.declarations));

  const failures: string[] = [];
  const stillAt = `still ${current.protocolVersion}`;

  // A declaration the released wire surface had and this one does not is a
  // break by definition: a peer on the old protocol can still send it. There is
  // no additive reading of a removal, so no ack can cover one — only a bump.
  if (removed.length > 0 && !bumped) {
    failures.push(
      `Dropped since ${baselineTag} without bumping DAEMON_RPC_PROTOCOL_VERSION (${stillAt}):\n` +
        `${removed.map((key) => `  - ${key}`).join('\n')}\n` +
        `  Removing wire surface a released peer still sends is breaking; an ack cannot cover it.`,
    );
  }

  if (changed.length > 0 && !bumped) {
    // An ack is keyed by the digest the declaration moved TO, so it covers one
    // specific post-change shape and cannot be recycled for the next change.
    const acked = new Map(current.compatibleChanges.map((ack) => [ack.declaration, ack]));
    const unacked = changed.filter((key) => {
      const ack = acked.get(key);
      return ack?.digest !== digests.get(key) || ack.rationale.trim().length === 0;
    });
    if (unacked.length > 0) {
      failures.push(
        `Changed since ${baselineTag} without bumping DAEMON_RPC_PROTOCOL_VERSION (${stillAt}):\n` +
          `${unacked.map((key) => `  - ${key}`).join('\n')}\n` +
          `  Read ADR 0006. If a peer on protocol ${released.protocolVersion} would misinterpret ` +
          `the new payload, bump the constant and the ledger's protocolVersion. If the change is ` +
          `additive — a new optional field the other side ignores — add a compatibleChanges entry ` +
          `per declaration carrying its current digest and the reason it stays compatible. ` +
          `test/wire-compat/README.md walks both.`,
      );
    }
  }

  return { changed, removed, added, bumped, failures };
}
