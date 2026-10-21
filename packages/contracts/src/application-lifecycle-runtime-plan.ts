import { defineUse } from './platform-runtime-operations.ts';

/** The normal lifecycle binding used by `open` after facts admission. */
export const openApplicationRuntimeUse = defineUse({
  required: ['resolveOpenTarget', 'prepareApplicationOpen', 'openApplication'],
});

/** A runtime-hint write is an explicit native operation, never an implicit lifecycle sibling. */
export const openApplicationWithRuntimeHintApplyUse = defineUse({
  required: ['resolveOpenTarget', 'prepareApplicationOpen', 'openApplication', 'applyRuntimeHints'],
});

/**
 * Replacing transport hints on an already-open app has one extra native effect. It remains a
 * distinct plan so ordinary open cells do not inherit an unrelated runtime-hints requirement.
 */
export const openApplicationWithRuntimeHintClearUse = defineUse({
  required: ['resolveOpenTarget', 'prepareApplicationOpen', 'openApplication', 'clearRuntimeHints'],
});

/** An open can replace stored hints and apply a new transport in the same admitted binding. */
export const openApplicationWithRuntimeHintApplyAndClearUse = defineUse({
  required: [
    'resolveOpenTarget',
    'prepareApplicationOpen',
    'openApplication',
    'applyRuntimeHints',
    'clearRuntimeHints',
  ],
});

export type OpenApplicationRuntimePlan =
  | Readonly<{ kind: 'open'; use: typeof openApplicationRuntimeUse }>
  | Readonly<{
      kind: 'open-apply-runtime-hints';
      use: typeof openApplicationWithRuntimeHintApplyUse;
    }>
  | Readonly<{
      kind: 'open-clear-runtime-hints';
      use: typeof openApplicationWithRuntimeHintClearUse;
    }>
  | Readonly<{
      kind: 'open-apply-and-clear-runtime-hints';
      use: typeof openApplicationWithRuntimeHintApplyAndClearUse;
    }>;

/** Selects the one open use from daemon-owned runtime-hint/session policy. */
export function resolveOpenApplicationRuntimePlan(
  input: Readonly<{
    applyRuntimeHints: boolean;
    clearRemovedRuntimeHints: boolean;
  }>,
): OpenApplicationRuntimePlan {
  if (input.applyRuntimeHints && input.clearRemovedRuntimeHints) {
    return Object.freeze({
      kind: 'open-apply-and-clear-runtime-hints',
      use: openApplicationWithRuntimeHintApplyAndClearUse,
    });
  }
  if (input.applyRuntimeHints) {
    return Object.freeze({
      kind: 'open-apply-runtime-hints',
      use: openApplicationWithRuntimeHintApplyUse,
    });
  }
  if (input.clearRemovedRuntimeHints) {
    return Object.freeze({
      kind: 'open-clear-runtime-hints',
      use: openApplicationWithRuntimeHintClearUse,
    });
  }
  return Object.freeze({ kind: 'open', use: openApplicationRuntimeUse });
}

export const openApplicationRuntimePlanUses = Object.freeze([
  openApplicationRuntimeUse,
  openApplicationWithRuntimeHintApplyUse,
  openApplicationWithRuntimeHintClearUse,
  openApplicationWithRuntimeHintApplyAndClearUse,
] as const);

/** The normal lifecycle binding used by close when no native runtime-hint cleanup is pending. */
export const closeApplicationRuntimeUse = defineUse({
  required: ['closeApplication', 'finalizeApplicationClose'],
});

/** A close with persisted native transport values requires their explicit cleanup atomically. */
export const closeApplicationWithRuntimeHintClearUse = defineUse({
  required: ['closeApplication', 'finalizeApplicationClose', 'clearRuntimeHints'],
});

/**
 * Close resolves the target of a session on an app device before any teardown, so a target outside
 * that app is refused while the session is still intact (ADR 0035).
 */
export const resolveCloseTargetRuntimeUse = defineUse({ required: ['resolveOpenTarget'] });

/** Every close plan is declared at the descriptor: hint cleanup is part of close, never a sibling reach-through. */
export const closeApplicationRuntimePlanUses = Object.freeze([
  closeApplicationRuntimeUse,
  closeApplicationWithRuntimeHintClearUse,
  resolveCloseTargetRuntimeUse,
] as const);

/** Daemon shutdown finalizes durable lifecycle resources without issuing a second close. */
export const finalizeApplicationCloseRuntimeUse = defineUse({
  required: ['finalizeApplicationClose'],
});

/** Shutdown cleanup needs the same independently admitted native transport removal. */
export const finalizeApplicationCloseWithRuntimeHintClearUse = defineUse({
  required: ['finalizeApplicationClose', 'clearRuntimeHints'],
});

/** The Apple-only runner warm-up is a semantic lifecycle operation, not a command capability. */
export const prepareAppleRunnerRuntimeUse = defineUse({ required: ['prepareAppleRunner'] });

/** Runtime clear delegates only its native hint cleanup; set/show remain daemon session policy. */
export const clearRuntimeHintsRuntimeUse = defineUse({ required: ['clearRuntimeHints'] });

/** `runtime port-reverse` is an exact provider operation, admitted separately from hint cleanup. */
export const configureProviderPortReverseRuntimeUse = defineUse({
  required: ['configureProviderPortReverse'],
});

/** Runtime commands select one honest native effect from this descriptor-declared plan. */
export const runtimeCommandRuntimePlanUses = Object.freeze([
  clearRuntimeHintsRuntimeUse,
  configureProviderPortReverseRuntimeUse,
] as const);
