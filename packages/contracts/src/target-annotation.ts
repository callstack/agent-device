// ADR 0012 target evidence: the shape of the `target-v1` annotation recorded beside a replayed
// action.
//
// Shared vocabulary, not a replay internal — the daemon writes it (8 modules), `replay/` parses and
// verifies it, and `commands/` reads it back. It was declared in `replay/target-identity.ts`
// alongside the parsing logic, which meant `SessionAction` could not be stated without depending on
// the replay zone. The parsing and classification logic stays there; only the shape moved.

export type TargetAncestryEntry = { role: string; label?: string };
export type TargetScrollRegion = { role: string; id?: string; label?: string };
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
