/**
 * The interaction guarantee matrix (ADR 0011).
 *
 * Every dispatch path an interaction command can take must classify EVERY
 * guarantee: enforced by shared runtime code, enforced runner-side (with a
 * parity table once ADR 0011 phase 3 lands), delegated to another path,
 * inapplicable by construction, or explicitly waived with a reason.
 *
 * The `Record` over the guarantee union makes completeness a compile error:
 * adding a guarantee refuses to build until every path classifies it, and a
 * new path cannot omit a cell. The companion gate test keeps the entries
 * honest (referenced symbols must exist, waivers must carry reasons).
 *
 * Waived cells with a `gap:` prefix are acknowledged debt — each should link
 * an issue. They are the point of the registry: the debt is a diffable list
 * a reviewer sees change, not folklore rediscovered on-device.
 */

export const INTERACTION_GUARANTEES = [
  // Ambiguous matches resolve visible-first, then deepest, then smallest;
  // remaining ties fail with "did not resolve uniquely".
  'disambiguation',
  // Targets covered by another visible element are refused.
  'occlusion',
  // The tap point (rect center) must lie inside the root viewport; closed
  // drawers / off-viewport carousels are refused, not silently no-op tapped.
  'offscreen',
  // Non-hittable targets are promoted to a hittable ancestor when possible
  // and annotated (targetHittable/hint) when not.
  'nonHittable',
  // Responses carry the shared field set (refLabel, selectorChain, evidence
  // merge) assembled by the shared builders, never hand-rolled per branch.
  'responseFields',
  // --verify captures a pre-action baseline and post-action digest.
  'verifyEvidence',
  // Failures use the shared codes/messages/hints (no-match diagnostics,
  // ambiguous shape, offscreen reasons).
  'errorTaxonomy',
] as const;

export type InteractionGuarantee = (typeof INTERACTION_GUARANTEES)[number];

export const INTERACTION_PATH_IDS = [
  'runtime-selector',
  'runtime-ref',
  'direct-ios-selector',
  'native-ref',
  'coordinate',
  'maestro-non-hittable-fallback',
] as const;

export type InteractionPathId = (typeof INTERACTION_PATH_IDS)[number];

export type GuaranteeEnforcement =
  | {
      kind: 'runtime';
      /** `<module path>#<exported symbol>` implementing the rule. */
      via: string;
    }
  | {
      kind: 'runner';
      /** Swift symbol implementing the rule runner-side. */
      via: string;
      /** Golden fixture table proving TS/Swift parity (ADR 0011 phase 3). */
      parityTable?: string;
    }
  | {
      kind: 'delegated';
      to: InteractionPathId;
      /** How the delegation is triggered (flag, error fallback, ...). */
      via: string;
    }
  | {
      kind: 'inapplicable';
      reason: string;
    }
  | {
      kind: 'waived';
      reason: string;
    };

export type InteractionPathContract = {
  description: string;
  commands: readonly string[];
  guarantees: Record<InteractionGuarantee, GuaranteeEnforcement>;
};

export const INTERACTION_DISPATCH_PATHS: Record<InteractionPathId, InteractionPathContract> = {
  'runtime-selector': {
    description: 'Daemon tree capture, selector chain resolution, guarded coordinate tap.',
    commands: ['press', 'click', 'fill', 'longpress'],
    guarantees: {
      disambiguation: {
        kind: 'runtime',
        via: 'src/daemon/selectors-resolve.ts#resolveSelectorChain',
      },
      occlusion: {
        kind: 'runtime',
        via: 'src/snapshot/snapshot-occlusion.ts#isSnapshotNodeInteractionBlocked',
      },
      offscreen: {
        kind: 'runtime',
        via: 'src/snapshot/mobile-snapshot-semantics.ts#isNodeVisibleOnScreen',
      },
      nonHittable: {
        kind: 'runtime',
        via: 'src/core/interaction-targeting.ts#resolveActionableTouchResolution',
      },
      responseFields: {
        kind: 'runtime',
        via: 'src/daemon/handlers/interaction-touch-targets.ts#interactionResultExtra',
      },
      verifyEvidence: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/interactions.ts#pressCommand',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'src/daemon/selectors-resolve.ts#formatSelectorFailure',
      },
    },
  },
  'runtime-ref': {
    description: 'Session snapshot ref lookup, guarded coordinate tap.',
    commands: ['press', 'click', 'fill', 'longpress'],
    guarantees: {
      disambiguation: {
        kind: 'inapplicable',
        reason: 'Refs identify exactly one node by construction.',
      },
      occlusion: {
        kind: 'runtime',
        via: 'src/snapshot/snapshot-occlusion.ts#isSnapshotNodeInteractionBlocked',
      },
      offscreen: {
        kind: 'runtime',
        via: 'src/snapshot/mobile-snapshot-semantics.ts#isNodeVisibleOnScreen',
      },
      nonHittable: {
        kind: 'runtime',
        via: 'src/core/interaction-targeting.ts#resolveActionableTouchResolution',
      },
      responseFields: {
        kind: 'runtime',
        via: 'src/daemon/handlers/interaction-touch-targets.ts#interactionResultExtra',
      },
      verifyEvidence: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/interactions.ts#pressCommand',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'src/daemon/selectors-resolve.ts#STALE_REF_HINT',
      },
    },
  },
  'direct-ios-selector': {
    description:
      'Simple selectors on iOS are sent to the XCTest runner, which queries and taps natively without a daemon tree capture.',
    commands: ['press', 'fill'],
    guarantees: {
      disambiguation: {
        kind: 'waived',
        reason:
          'gap: runner findElement uses unique-hittable-or-AMBIGUOUS_MATCH, which differs from tree rules (no visible-first/deepest-smallest preference). Needs a parity table or delegation on AMBIGUOUS_MATCH.',
      },
      occlusion: {
        kind: 'waived',
        reason:
          'gap: XCTest isHittable approximates occlusion but there is no explicit covered-element check on the direct path.',
      },
      offscreen: {
        kind: 'runner',
        via: 'RunnerTests+Interaction.swift#onScreenWindowFrame',
      },
      nonHittable: {
        kind: 'waived',
        reason:
          'gap: non-hittable matches are skipped runner-side (ELEMENT_NOT_FOUND) instead of promoted/annotated like the runtime path.',
      },
      responseFields: {
        kind: 'waived',
        reason:
          'gap: the response is built from the runner payload; refLabel/selectorChain are absent on the direct path.',
      },
      verifyEvidence: {
        kind: 'delegated',
        to: 'runtime-selector',
        via: '--verify disables the direct path (readDirectIosSelectorTapTarget / fill flags.verify check)',
      },
      errorTaxonomy: {
        kind: 'waived',
        reason:
          'gap: ELEMENT_NOT_FOUND/AMBIGUOUS_MATCH lack the selector diagnostics and hints the runtime path attaches.',
      },
    },
  },
  'native-ref': {
    description:
      'click @ref / fill @ref dispatch to backend.tapTarget/fillTarget without runtime resolution when no non-default options are set.',
    commands: ['click', 'fill'],
    guarantees: {
      disambiguation: {
        kind: 'inapplicable',
        reason: 'Refs identify exactly one node by construction.',
      },
      occlusion: {
        kind: 'waived',
        reason: 'gap: no covered-element check before the native ref tap.',
      },
      offscreen: {
        kind: 'waived',
        reason:
          'gap: no viewport check before the native ref tap; relies on runner-side ref resolution behavior.',
      },
      nonHittable: {
        kind: 'waived',
        reason: 'gap: no promotion/annotation on the native ref path.',
      },
      responseFields: {
        kind: 'runtime',
        via: 'src/daemon/handlers/interaction-touch-targets.ts#interactionResultExtra',
      },
      verifyEvidence: {
        kind: 'delegated',
        to: 'runtime-ref',
        via: '--verify disables the native ref fast path (maybeTapRefTarget / maybeFillRefTarget verify check)',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'src/daemon/selectors-resolve.ts#STALE_REF_HINT',
      },
    },
  },
  coordinate: {
    description: 'Raw x/y tap. Semantics are intentionally minimal.',
    commands: ['press', 'click', 'fill', 'longpress'],
    guarantees: {
      disambiguation: {
        kind: 'inapplicable',
        reason: 'Coordinates name a point, not an element.',
      },
      occlusion: {
        kind: 'inapplicable',
        reason: 'Coordinates bypass element semantics by design (escape hatch).',
      },
      offscreen: {
        kind: 'waived',
        reason:
          'gap: out-of-viewport coordinates are forwarded as-is; a bounds warning would be cheap.',
      },
      nonHittable: {
        kind: 'inapplicable',
        reason: 'No element to promote or annotate.',
      },
      responseFields: {
        kind: 'inapplicable',
        reason: 'No resolved node, so no refLabel/selectorChain.',
      },
      verifyEvidence: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution.ts#resolveInteractionTarget',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'src/kernel/errors.ts#normalizeError',
      },
    },
  },
  'maestro-non-hittable-fallback': {
    description:
      'Replay-only coordinate fallback for non-hittable elements (allowNonHittableCoordinateFallback), matching Maestro semantics.',
    commands: ['press', 'fill'],
    guarantees: {
      disambiguation: {
        kind: 'runner',
        via: 'RunnerTests+Interaction.swift#findElement',
      },
      occlusion: {
        kind: 'waived',
        reason: 'Intentional: Maestro taps resolved bounds regardless of overlay state.',
      },
      offscreen: {
        kind: 'runner',
        via: 'RunnerTests+Interaction.swift#hasTappableFrame',
      },
      nonHittable: {
        kind: 'waived',
        reason: 'Intentional: the entire point of this path is tapping non-hittable elements.',
      },
      responseFields: {
        kind: 'runtime',
        via: 'src/daemon/handlers/interaction-touch.ts#handleTouchInteractionCommands',
      },
      verifyEvidence: {
        kind: 'inapplicable',
        reason: 'Replay-only path; --verify is not part of replay semantics.',
      },
      errorTaxonomy: {
        kind: 'waived',
        reason: 'gap: shares the direct path error shapes, including their missing hints.',
      },
    },
  },
};
