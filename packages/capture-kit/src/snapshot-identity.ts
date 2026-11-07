import type { SnapshotProvenance } from '@agent-device/contracts/snapshot-model';

/**
 * Stamps the served identity of a capture onto its result: the producer that read the tree and the
 * channel it arrived on. Every one-source owner stamps through here (ADR 0038); an owner with more
 * than one source routes through the snapshot router instead. The identity must be a registry pair,
 * so a producer without a `SNAPSHOT_PRODUCERS` row, or a channel its row does not list, does not
 * compile.
 */
export function stampSnapshotIdentity<
  Result extends object,
  const Identity extends SnapshotProvenance,
>(result: Result, identity: Identity): Omit<Result, 'backend' | 'producer'> & Identity {
  return { ...result, ...identity };
}
