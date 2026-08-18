/**
 * Snapshot scope specification (`snapshot --scope <text>`), one rule for every presentation
 * runtime (#1797 / #1832):
 *
 * - a node matches when its label, value, or identifier contains the scope text,
 *   case-insensitively;
 * - the scope root is the FIRST match in document (pre-)order;
 * - the scoped snapshot is that root's subtree, re-rooted at depth 0;
 * - no match yields an EMPTY snapshot — never the full tree.
 *
 * The golden table `contracts/fixtures/snapshot-scope-policy.json` pins the rule; every runtime
 * that resolves scope (Android platform projection, the daemon's post-wire pass, the Swift runner
 * twin) is asserted against the same table so drift turns CI red on whichever side changed.
 */
export type SnapshotScopeCandidate = {
  label?: string | null;
  value?: string | null;
  identifier?: string | null;
};

export function matchesSnapshotScope(node: SnapshotScopeCandidate, scope: string): boolean {
  const query = scope.toLowerCase();
  return [node.label, node.value, node.identifier].some((field) =>
    (field ?? '').toLowerCase().includes(query),
  );
}
