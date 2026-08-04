// ADR 0012 target evidence: the shape of the `target-v1` annotation recorded beside a replayed
// action.
//
// Shared vocabulary, not a replay internal — the daemon writes it (8 modules), `replay/` parses and
// verifies it, and `commands/` reads it back. It was declared in `replay/target-identity.ts`
// alongside the parsing logic, which meant `SessionAction` could not be stated without depending on
// the replay zone. The parsing and classification logic stays there; only the shape moved.

export type TargetAncestryEntry = { role: string; label?: string };
export type TargetScrollRegion = { role: string; id?: string; label?: string };

/**
 * ADR 0012 decision 3: a node's local identity tier — normalized id, role, and
 * label in drop-empty-keys form. Produced only by `@agent-device/ad-script`'s
 * `readNodeLocalIdentity` (NFC, label whitespace collapse, `normalizeType`
 * role, 256-byte field caps), so every path that compares identities does so
 * with byte-identical semantics.
 */
export type LocalIdentity = { id?: string; role: string; label?: string };

/**
 * ADR 0012 decision 3: the STRUCTURAL denotation of a node within its capture
 * — the discriminators path 6 uses to isolate ONE member among several nodes
 * that share the same local identity. `documentOrder` is the node's pre-order
 * tree-traversal index (decision 3's "canonical total order of this
 * contract"), which distinguishes ANY two distinct nodes. `sibling` is its
 * zero-based ordinal among its own parent's children (decision 3 path 6.i).
 * Both captures (the verifier's and dispatch's) run the same snapshot
 * pipeline, so for the same physical node in the same screen these values
 * agree; two distinct duplicates never share a `documentOrder`.
 */
export type NodeStructuralDenotation = {
  documentOrder: number;
  sibling: number;
};
export type TargetRect = { x: number; y: number; width: number; height: number };
export type TargetVerification = 'verified' | 'unverifiable';

export type TargetAnnotationV1 = {
  id?: string;
  role: string;
  label?: string;
  ancestry: TargetAncestryEntry[];
  sibling: number;
  viewportOrder: number;
  scrollRegion?: TargetScrollRegion;
  rect?: TargetRect;
  verification: TargetVerification;
};
