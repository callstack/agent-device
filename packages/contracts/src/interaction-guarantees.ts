/**
 * The interaction guarantee matrix (ADR 0011).
 *
 * Every dispatch path an interaction command can take must classify EVERY
 * guarantee: enforced by shared runtime code, enforced runner-side (with a
 * parity table once ADR 0011 phase 3 lands), delegated to another path,
 * inapplicable by construction, or explicitly waived with a reason.
 *
 * This registry plus its gate test is an HONESTY/COMPLETENESS gate, not a
 * truth gate: it proves every path has declared a stance and that referenced
 * symbols exist. Behavioral parity is only proven once the golden fixture
 * tables (Layer 2) and contract scenarios (Layer 3) land.
 *
 * The `Record` over the guarantee union makes completeness a compile error:
 * adding a guarantee refuses to build until every path classifies it, and a
 * new path cannot omit a cell. The companion gate test keeps the entries
 * honest (referenced symbols must exist, waivers must carry reasons, and
 * every `gap:` waiver must carry a tracking issue).
 *
 * Closure strategy for the acknowledged gaps is hybrid (see ADR 0011):
 * runner-side parity for cheap geometry-local rules; delegation-on-error for
 * semantic/rich-runtime failures (which is NOT success-path parity — cells
 * where the fast path can succeed on a candidate the runtime rules would
 * refuse stay gaps until proven); and a shared runtime preflight against the
 * already-captured snapshot node for the native-ref path, because a backend
 * fast path can silently succeed and delegation-on-error never triggers
 * (implemented: preflightNativeRefInteraction, #1081).
 */

export const INTERACTION_GUARANTEES = [
  // Mutating selectors collapse duplicate wrappers only when every match is
  // one ancestry chain resolving to the same actionable node. Distinct
  // subtrees fail with bounded, actionable candidates; geometry never wins.
  'disambiguation',
  // Targets covered by another visible element are refused.
  'occlusion',
  // The tap point (rect center) must lie inside the root viewport; closed
  // drawers / off-viewport carousels are refused, not silently no-op tapped.
  'offscreen',
  // Non-hittable targets are promoted to a hittable ancestor when possible
  // and annotated (targetHittable/hint) when not.
  'nonHittable',
  // Response payloads are assembled by a single shared construction site,
  // never hand-rolled per branch (the class of bug that dropped fill @ref
  // evidence). Closed by ADR 0011 Layer 2: buildInteractionResponseData plus
  // the hand-rolled-literal guard test.
  'responseConstruction',
  // The identity fields a path can echo back: refLabel, selectorChain, the
  // resolved target. Distinct from construction — a path may build responses
  // through the shared site yet be unable to provide identity fields.
  'responseIdentity',
  // --verify captures a pre-action baseline and post-action digest.
  'verifyEvidence',
  // --settle (#1101) waits for the UI to go quiet after the action and returns
  // the settled diff vs the pre-action tree (plus refsGeneration when the
  // settled tree was stored) in the same response. Best-effort: never fails
  // the action.
  'settleObservation',
  // Failures use the shared codes/messages/hints (no-match diagnostics,
  // ambiguous shape, offscreen reasons). NOTE: expected to split into
  // errorCodes (stable codes / fallback classification) vs errorDiagnostics
  // (rich selector diagnostics and hints) once direct runner paths close
  // codes earlier than full diagnostics.
  'errorTaxonomy',
  // The additive `resolution` response field (ADR 0012 decision 2):
  // unique/disambiguated/exact/label-fallback/not-observed provenance,
  // pre-action diagnostics only — never ref-issued or MCP-pinned.
  'resolutionDisclosure',
] as const;

export type InteractionGuarantee = (typeof INTERACTION_GUARANTEES)[number];

export const INTERACTION_PATH_IDS = [
  'runtime-selector',
  'runtime-ref',
  'target-drag',
  'direct-ios-selector',
  'native-ref',
  'coordinate',
  'maestro-non-hittable-fallback',
] as const;

export type InteractionPathId = (typeof INTERACTION_PATH_IDS)[number];

type GuaranteeEnforcementBase =
  | {
      kind: 'runtime';
      /** `<module path>#<exported symbol>` implementing the rule. */
      via: string;
    }
  | {
      kind: 'runner';
      /** Swift symbol implementing the rule runner-side. */
      via: string;
      /**
       * Golden fixture table proving TS/Swift parity. Optional until ADR 0011
       * Layer 3 lands; required once a runner cell claims parity.
       */
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
      /** Required when the reason starts with `gap:` — waivers must be owned. */
      trackingIssue?: string;
    };

export type GuaranteeEnforcement = GuaranteeEnforcementBase & {
  /**
   * Command scoping: when a guarantee only applies to a subset of the path's
   * commands (e.g. --verify exists on press/click/fill but not longpress),
   * the cell names that subset instead of implying path-wide coverage. Must
   * be a non-empty subset of the path's `commands`; omitted = all commands.
   */
  appliesTo?: readonly string[];
};

export type InteractionPathContract = {
  description: string;
  commands: readonly string[];
  guarantees: Record<InteractionGuarantee, GuaranteeEnforcement>;
};

const GAPS_UMBRELLA_ISSUE = 'https://github.com/callstack/agent-device/issues/1081';

// Every path shares the SAME cell by construction: response payloads have one
// construction site (ADR 0011 Layer 2), and the hand-rolled-literal guard test
// (interaction-response-construction-guard.test.ts) keeps new branches on it.
const SHARED_RESPONSE_CONSTRUCTION: GuaranteeEnforcement = {
  kind: 'runtime',
  via: 'src/daemon/handlers/interaction-touch-response.ts#buildInteractionResponseData',
};

// The two runtime tree paths (selector and ref resolution) run the SAME shared
// guard/observation implementations; only how the target is found
// (disambiguation) and how failures are described (errorTaxonomy) differ.
const RUNTIME_TREE_SHARED_GUARANTEES = {
  occlusion: {
    kind: 'runtime',
    via: 'src/snapshot/snapshot-occlusion.ts#isSnapshotNodeInteractionBlocked',
  },
  // #1542: the base decision is isNodeVisibleOnScreen (bulk accessibility
  // tree), but throwIfOffscreenInteractionTarget is the actual end-to-end
  // enforcement point — on iOS (local, non-provider sessions only) a would-be
  // refusal is re-checked against a live, tree-independent read via the
  // optional AgentDeviceBackend.confirmOffscreenTargetVisible hook before
  // erroring, and a confirmed rescue re-targets the action at the LIVE rect,
  // not the bulk one. Every other platform, and any backend that omits the
  // hook, refuses on isNodeVisibleOnScreen's verdict unchanged — this is a
  // rescue-only override, never a way to relax a genuine refusal.
  offscreen: {
    kind: 'runtime',
    via: 'src/commands/interaction/runtime/resolution.ts#throwIfOffscreenInteractionTarget',
  },
  nonHittable: {
    kind: 'runtime',
    via: 'src/core/interaction-targeting.ts#resolveActionableTouchResolution',
  },
  responseConstruction: SHARED_RESPONSE_CONSTRUCTION,
  responseIdentity: {
    kind: 'runtime',
    via: 'src/daemon/handlers/interaction-touch-targets.ts#interactionResultExtra',
  },
  verifyEvidence: {
    kind: 'runtime',
    via: 'src/commands/interaction/runtime/interactions.ts#pressCommand',
    appliesTo: ['press', 'click', 'fill'],
  },
  settleObservation: {
    kind: 'runtime',
    via: 'src/commands/interaction/runtime/settle.ts#settleAfterInteraction',
  },
} satisfies Partial<Record<InteractionGuarantee, GuaranteeEnforcement>>;

export const INTERACTION_DISPATCH_PATHS: Record<InteractionPathId, InteractionPathContract> = {
  'runtime-selector': {
    description: 'Daemon tree capture, selector chain resolution, guarded coordinate tap.',
    commands: ['press', 'click', 'fill', 'longpress'],
    guarantees: {
      ...RUNTIME_TREE_SHARED_GUARANTEES,
      disambiguation: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/selector-action-resolution.ts#resolveActionSelector',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/selector-action-resolution.ts#resolveActionSelector',
      },
      // Full pre-action diagnostic shape; equivalent wrapper chains disclose
      // their structural collapse, while distinct subtrees never succeed.
      resolutionDisclosure: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/selector-action-resolution.ts#resolveActionSelector',
      },
    },
  },
  'runtime-ref': {
    description:
      'Session snapshot ref lookup, guarded coordinate tap. #1654: when the caller already resolved the node (a mutating `find`), the lookup is replaced by that node and every guarantee below is enforced against it — the guards are unchanged, only the lookup is skipped.',
    commands: ['press', 'click', 'fill', 'longpress'],
    guarantees: {
      ...RUNTIME_TREE_SHARED_GUARANTEES,
      disambiguation: {
        kind: 'waived',
        reason:
          'Intentional: a resolved @ref names exactly one node, but the replay trailing-label recovery resolves a stale @ref by FIRST label match without the visible/deepest/smallest ranking; that outcome is disclosed per-response as resolutionDisclosure label-fallback rather than silently claiming exactness.',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'packages/selectors/src/internal/resolve.ts#STALE_REF_HINT',
      },
      // ADR 0012 decision 2: the shared builder produces both outcomes — exact
      // for an ordinary or pre-resolved @ref, label-fallback only for trailing-
      // label recovery. The pre-resolved path validates carried ref/node/tree
      // provenance before it can claim exact.
      resolutionDisclosure: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution.ts#buildRefResolution',
      },
    },
  },
  'target-drag': {
    description:
      'Target-authored gesture drag resolves source and destination independently through the runtime tree, verifies both identities on replay, then dispatches one uninterrupted pointer plan.',
    commands: ['gesture'],
    guarantees: {
      disambiguation: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/selector-action-resolution.ts#resolveActionSelector',
      },
      occlusion: {
        kind: 'runtime',
        via: 'src/snapshot/snapshot-occlusion.ts#isSnapshotNodeInteractionBlocked',
      },
      offscreen: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution.ts#throwIfOffscreenInteractionTarget',
      },
      nonHittable: {
        kind: 'inapplicable',
        reason:
          'Drag endpoints name contact coordinates and intentionally need not be independently tappable controls; covered and off-screen endpoints are still refused.',
      },
      responseConstruction: {
        kind: 'runtime',
        via: 'src/daemon/handlers/interaction-gesture-response.ts#gestureResponseData',
      },
      responseIdentity: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/gestures.ts#dragCommand',
      },
      verifyEvidence: {
        kind: 'inapplicable',
        reason: 'Target-authored drag has replay identity evidence but does not expose --verify.',
      },
      settleObservation: {
        kind: 'inapplicable',
        reason:
          'Target-authored drag does not expose --settle; callers can wait on the destination state.',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'packages/selectors/src/internal/resolve.ts#formatSelectorFailure',
      },
      resolutionDisclosure: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/gestures.ts#dragCommand',
      },
    },
  },
  'direct-ios-selector': {
    description:
      'Simple press selectors on iOS are sent to the XCTest runner, which queries and taps natively without a daemon tree capture. Fill deliberately resolves through the runtime tree so AX-hostile text inputs carry typed target evidence into coordinate entry.',
    commands: ['press'],
    guarantees: {
      disambiguation: {
        kind: 'delegated',
        to: 'runtime-selector',
        via: 'RunnerSelectorMatchPolicy.swift#classifyDirectSelectorCandidates rejects multiple raw exact matches before hittability; AMBIGUOUS_MATCH then falls back to runtime structural-equivalence classification for non-maestro dispatches',
      },
      occlusion: {
        kind: 'delegated',
        to: 'runtime-selector',
        via: 'runner ELEMENT_NOT_FOUND/AMBIGUOUS_MATCH fall back to tree-based resolution (isDirectIosSelectorFallbackError delegateSemanticFailures; non-maestro dispatches only) — XCTest skips covered/non-hittable matches, so the runtime path raises the covered-element refusal with its hint',
      },
      offscreen: {
        // Decision: TapPointPolicy (pure geometry, parity-tested against the
        // TS twin isTapPointInsideViewport). onScreenWindowFrame stays the
        // impure frame getter feeding it.
        kind: 'runner',
        via: 'RunnerTapPointPolicy.swift#TapPointPolicy',
        parityTable: 'contracts/fixtures/tap-point-policy.json',
      },
      nonHittable: {
        kind: 'delegated',
        to: 'runtime-selector',
        via: 'runner ELEMENT_NOT_FOUND (non-hittable matches are skipped runner-side) falls back to tree-based resolution (isDirectIosSelectorFallbackError delegateSemanticFailures; non-maestro dispatches only), which promotes to a hittable ancestor or annotates targetHittable/hint',
      },
      responseConstruction: SHARED_RESPONSE_CONSTRUCTION,
      responseIdentity: {
        kind: 'waived',
        reason: 'gap: refLabel/selectorChain are absent on the direct path.',
        trackingIssue: GAPS_UMBRELLA_ISSUE,
      },
      verifyEvidence: {
        kind: 'delegated',
        to: 'runtime-selector',
        via: '--verify disables the direct path when the descriptor post-action observation trait supports verify evidence',
      },
      settleObservation: {
        kind: 'delegated',
        to: 'runtime-selector',
        via: '--settle disables the direct path when the descriptor post-action observation trait supports settle observation — settling needs the tree-based baseline and captures',
      },
      errorTaxonomy: {
        kind: 'delegated',
        to: 'runtime-selector',
        via: 'runner ELEMENT_NOT_FOUND/AMBIGUOUS_MATCH fall back to tree-based resolution (isDirectIosSelectorFallbackError delegateSemanticFailures; non-maestro dispatches only), which attaches the shared no-match diagnostics, ambiguous shape, and hints',
      },
      // No daemon tree, so only the not-observed marker — no counts or
      // candidates, and no parity table (that would imply runtime parity).
      resolutionDisclosure: {
        kind: 'runtime',
        via: 'src/daemon/handlers/interaction-touch-response.ts#buildInteractionResponseData',
      },
    },
  },
  'native-ref': {
    // WEB-ONLY in production: apple/android backends never define
    // tapTarget/fillTarget - the sole wiring is the web provider's clickRef
    // (a stable DOM-handle click). Verified 2026-07-04 while designing the
    // #1088 retirement experiment, which this finding dissolved: there is no
    // iOS runner round trip to retire.
    description:
      'click @ref / fill @ref dispatch to backend.tapTarget/fillTarget (web provider clickRef only; no mobile backend implements these) without runtime resolution when no non-default options are set. A zero-round-trip preflight (preflightNativeRefInteraction) runs the shared guards against the stored session snapshot node first; no snapshot / no usable rect makes the preflight a no-op.',
    commands: ['click', 'fill'],
    guarantees: {
      disambiguation: {
        kind: 'inapplicable',
        reason: 'Refs identify exactly one node by construction.',
      },
      occlusion: {
        kind: 'runtime',
        via: 'src/snapshot/snapshot-occlusion.ts#isSnapshotNodeInteractionBlocked',
      },
      // Same enforcement point as the runtime-tree paths (#1542): the
      // preflight guard IS throwIfOffscreenInteractionTarget, which can
      // rescue via the optional iOS confirmOffscreenTargetVisible hook — see
      // the comment on RUNTIME_TREE_SHARED_GUARANTEES.offscreen above. This
      // path is web-only in production (no mobile backend implements
      // tapTarget/fillTarget), so the rescue hook never fires here in
      // practice, but the code path is identical.
      offscreen: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution.ts#throwIfOffscreenInteractionTarget',
      },
      // Annotation only (targetHittable/hint on the result): promotion to a
      // hittable ancestor stays a runtime-path behavior — the preflight never
      // changes which element the backend acts on.
      nonHittable: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution.ts#preflightNativeRefInteraction',
      },
      responseConstruction: SHARED_RESPONSE_CONSTRUCTION,
      responseIdentity: {
        kind: 'runtime',
        via: 'src/daemon/handlers/interaction-touch-targets.ts#interactionResultExtra',
      },
      verifyEvidence: {
        kind: 'delegated',
        to: 'runtime-ref',
        via: '--verify disables the native ref fast path when the descriptor post-action observation trait supports verify evidence',
      },
      settleObservation: {
        kind: 'delegated',
        to: 'runtime-ref',
        via: '--settle disables the native ref fast path when the descriptor post-action observation trait supports settle observation — settling needs the tree-based baseline and captures',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'packages/selectors/src/internal/resolve.ts#STALE_REF_HINT',
      },
      // An @ref names exactly one node by construction (same cell as runtime-ref).
      resolutionDisclosure: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution.ts#EXACT_REF_RESOLUTION',
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
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution.ts#resolveInteractionTarget',
      },
      nonHittable: {
        kind: 'inapplicable',
        reason: 'No element to promote or annotate.',
      },
      responseConstruction: SHARED_RESPONSE_CONSTRUCTION,
      responseIdentity: {
        kind: 'inapplicable',
        reason: 'No resolved node, so no refLabel/selectorChain.',
      },
      verifyEvidence: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution.ts#resolveInteractionTarget',
        appliesTo: ['press', 'click', 'fill'],
      },
      settleObservation: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/settle.ts#settleAfterInteraction',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'packages/kernel/src/errors.ts#normalizeError',
      },
      resolutionDisclosure: {
        kind: 'inapplicable',
        reason: 'Coordinates name a point; no element was resolved to disclose.',
      },
    },
  },
  'maestro-non-hittable-fallback': {
    description:
      'Replay-only coordinate fallback for non-hittable elements (allowNonHittableCoordinateFallback), matching Maestro semantics.',
    commands: ['press', 'fill'],
    guarantees: {
      disambiguation: {
        kind: 'waived',
        reason:
          'Intentional: Maestro replay matches by its expected-point/non-hittable compatibility scan (findElement), a deliberate divergence from runtime structural-equivalence-or-reject semantics.',
      },
      occlusion: {
        kind: 'waived',
        reason: 'Intentional: Maestro taps resolved bounds regardless of overlay state.',
      },
      offscreen: {
        // hasTappableFrame keeps two path-specific choices (empty element
        // frames are refused; app.frame is the frame source, Maestro-style)
        // but its center-in-frame decision is the shared TapPointPolicy.
        kind: 'runner',
        via: 'RunnerTests+Interaction.swift#hasTappableFrame',
        parityTable: 'contracts/fixtures/tap-point-policy.json',
      },
      nonHittable: {
        kind: 'waived',
        reason: 'Intentional: the entire point of this path is tapping non-hittable elements.',
      },
      responseConstruction: SHARED_RESPONSE_CONSTRUCTION,
      responseIdentity: {
        kind: 'waived',
        reason: 'Intentional: replay-only path; Maestro semantics do not consume identity fields.',
      },
      verifyEvidence: {
        kind: 'inapplicable',
        reason: 'Replay-only path; --verify is not part of replay semantics.',
      },
      settleObservation: {
        kind: 'inapplicable',
        reason: 'Replay-only path; --settle is not part of replay semantics.',
      },
      errorTaxonomy: {
        kind: 'waived',
        reason: 'gap: shares the direct path error shapes, including their missing hints.',
        trackingIssue: GAPS_UMBRELLA_ISSUE,
      },
      resolutionDisclosure: {
        kind: 'inapplicable',
        reason:
          'Maestro owns matching; the fallback is coordinate execution. Cell membership is usage-based: only a dispatch whose runner actually executed the coordinate fallback is this path — allowed-but-not-taken is the direct path and discloses not-observed.',
      },
    },
  },
};
