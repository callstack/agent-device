import type { ImportEdge } from './model.ts';

/**
 * R1-R3 as data: which zone may import which, and on what terms.
 *
 * These three rules used to be three hand-written predicate functions. They were short, but each
 * one buried its boundary in control flow — you had to read the early-returns to learn that R3
 * tolerates dynamic imports, or that R1 opens exactly one door. Stating them as a table means the
 * policy is readable without reading code, and a fourth boundary is a table entry rather than a
 * fourth function to keep consistent with the other three.
 *
 * The evaluator is deliberately small. Everything a policy can say is in `ZonePolicy`, so a rule
 * that needs more than these fields does NOT belong here: R4 (cycles), R5/R6 (spine ranking),
 * R7 (field ownership) and R9 (cycle size) are whole-graph or non-import properties, and each
 * keeps its own checker.
 */

/** Edge kinds a boundary can tolerate. Both are erased or deferred, so both can be legitimate. */
export type ToleratedKind = 'type-only' | 'dynamic';

export type ZonePolicy = {
  /** Rule id reported on violation, e.g. `R1 kernel-sink`. */
  rule: string;
  /** Source zones this policy governs. Omit for "every zone". */
  from?: readonly string[];
  /** Target zones this policy forbids importing. Omit and use `exceptTo` for "everything but". */
  to?: readonly string[];
  /** Target zones this policy does NOT govern — the complement form of `to`. */
  exceptTo?: readonly string[];
  /**
   * Edge kinds that do not violate this boundary. A type-only edge costs nothing at runtime; a
   * dynamic edge defers the cost past startup. Omitted means the boundary is closed to every kind.
   */
  tolerates?: readonly ToleratedKind[];
  /** Path prefixes allowed to cross regardless: the declared seam. */
  seam?: readonly string[];
  /** Subtrees of `seam` that are NOT part of it (a seam owner with a non-owning child). */
  seamExcept?: readonly string[];
  /** Why the boundary exists and what to do instead. ADR 0010: every error carries a hint. */
  hint: string;
};

/**
 * The policy table. Order is presentation only — every policy is evaluated against every edge.
 *
 * R1 kernel-sink retired 2026-07-30 (#1490 W0): the kernel moved to
 * packages/kernel, where package resolution and R11 package-boundaries enforce
 * the sink property physically — a package cannot import root src at all.
 */
export const ZONE_POLICIES: readonly ZonePolicy[] = [
  {
    rule: 'R2 commands-floor',
    from: ['platforms', 'core', 'daemon'],
    to: ['commands'],
    hint:
      'commands/ is the command surface, above these zones. Depend on shared kernel/contracts ' +
      'instead; if two zones need the same rule, put the rule below both of them.',
  },
  {
    rule: 'R3 platforms-seam',
    to: ['platforms'],
    tolerates: ['type-only', 'dynamic'],
    seam: ['src/core/interactors/', 'src/daemon/', 'src/sdk/'],
    seamExcept: ['src/daemon/client/'],
    hint:
      'Only src/core/interactors/, the daemon server and the sdk barrel may statically import ' +
      'platforms/; elsewhere use a dynamic import() or a type-only import to preserve CLI ' +
      'cold-start.',
  },
];

function kindOf(imp: ImportEdge): ToleratedKind | 'value' {
  if (imp.dynamic) return 'dynamic';
  if (imp.typeOnly) return 'type-only';
  return 'value';
}

function crossesSeam(policy: ZonePolicy, file: string): boolean {
  if (!policy.seam?.some((prefix) => file.startsWith(prefix))) return false;
  return !policy.seamExcept?.some((prefix) => file.startsWith(prefix));
}

/**
 * Whether `policy` governs this edge AND the edge violates it. Returns the hint on violation so
 * the caller can build the message, or `null` when the policy is silent about this edge.
 */
export function policyViolation(
  policy: ZonePolicy,
  edge: { file: string; fromZone: string; toZone: string; imp: ImportEdge },
): string | null {
  if (policy.from && !policy.from.includes(edge.fromZone)) return null;
  if (policy.to && !policy.to.includes(edge.toZone)) return null;
  if (policy.exceptTo?.includes(edge.toZone)) return null;

  const kind = kindOf(edge.imp);
  if (kind !== 'value' && policy.tolerates?.includes(kind)) return null;
  if (crossesSeam(policy, edge.file)) return null;

  return policy.hint;
}

/** The one-line lead every zone-policy violation shares, before its rule-specific hint. */
export function policyLead(edge: { fromZone: string; toZone: string; imp: ImportEdge }): string {
  const kind = kindOf(edge.imp);
  const qualifier = kind === 'value' ? '' : `${kind} `;
  return `${edge.fromZone}/ must not ${qualifier}import ${edge.toZone}/ (imports '${edge.imp.spec}').`;
}
