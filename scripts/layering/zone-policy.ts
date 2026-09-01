import type { ImportEdge } from './model.ts';

/**
 * R2 as data: which zone may import which.
 *
 * The original folder policies were hand-written predicate functions. Stating the remaining rule
 * as data keeps its scope readable without following control flow.
 *
 * The evaluator is deliberately small. Everything a policy can say is in `ZonePolicy`, so a rule
 * that needs more than these fields does NOT belong here: R4 (cycles), R5/R6 (spine ranking),
 * R7 (field ownership) and R9 (cycle size) are whole-graph or non-import properties, and each
 * keeps its own checker.
 */

export type ZonePolicy = {
  /** Rule id reported on violation, e.g. `R1 kernel-sink`. */
  rule: string;
  /** Source zones this policy governs. Omit for "every zone". */
  from?: readonly string[];
  /** Target zones this policy forbids importing. Omit and use `exceptTo` for "everything but". */
  to?: readonly string[];
  /** Target zones this policy does NOT govern — the complement form of `to`. */
  exceptTo?: readonly string[];
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
    from: ['core', 'daemon'],
    to: ['commands'],
    hint:
      'commands/ is the command surface, above these zones. Depend on shared kernel/contracts ' +
      'instead; if two zones need the same rule, put the rule below both of them.',
  },
];

function kindOf(imp: ImportEdge): 'type-only' | 'dynamic' | 'value' {
  if (imp.dynamic) return 'dynamic';
  if (imp.typeOnly) return 'type-only';
  return 'value';
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

  return policy.hint;
}

/** The one-line lead every zone-policy violation shares, before its rule-specific hint. */
export function policyLead(edge: { fromZone: string; toZone: string; imp: ImportEdge }): string {
  const kind = kindOf(edge.imp);
  const qualifier = kind === 'value' ? '' : `${kind} `;
  return `${edge.fromZone}/ must not ${qualifier}import ${edge.toZone}/ (imports '${edge.imp.spec}').`;
}
